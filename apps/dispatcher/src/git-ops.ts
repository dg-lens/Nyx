import { execSync, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { config } from './config.js';

export interface WorkingDir {
  kind: 'worktree' | 'clone' | 'output';
  path: string;
  branch?: string;
  cleanup(): void;
}

/**
 * Strip any secret value from a string before it can reach a log sink. execSync
 * throws an Error whose `.message` is `Command failed: <full argv>\n<stderr>` —
 * for a clone whose URL embeds `x-access-token:<TOKEN>@github.com`, the token is
 * in that message verbatim. That message flows into the hash-chained audit DB
 * and Slack, so it MUST be scrubbed at the throw site. Redacts the configured
 * GitHub token + the `x-access-token:…@` URL credential form generically.
 */
export function redactSecrets(s: string): string {
  let out = s.replace(/(x-access-token:)[^@/\s]+(@)/g, '$1***$2');
  if (config.githubToken) out = out.split(config.githubToken).join('***');
  return out;
}

// Hard cap on any single git/gh invocation. A stalled fetch/push/PR-create
// (network hang) would otherwise block the single-threaded dispatcher
// synchronously and indefinitely. On timeout execSync throws (SIGTERM), which
// `run`/`tryRun` already turn into a deterministic failure for the audit phase.
const GIT_TIMEOUT_MS = 120_000;

// GIT_TERMINAL_PROMPT=0 + GCM_INTERACTIVE=never: never block on an interactive
// credential prompt (empty/expired PAT on a private HTTPS repo) — fail fast
// instead of wedging the dispatcher waiting on stdin.
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

// Re-throw an execSync/execFileSync error with every secret value scrubbed from
// its message + stdout + stderr before it can reach the hash-chained audit DB or
// Slack. Shared by the shell-string `run` and the argv-form `runArgs`.
function rethrowScrubbed(err: unknown): never {
  const e = err as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
  const scrubbed = new Error(redactSecrets(e.message ?? String(e))) as Error & {
    stdout?: string;
    stderr?: string;
  };
  if (e.stdout != null) scrubbed.stdout = redactSecrets(e.stdout.toString());
  if (e.stderr != null) scrubbed.stderr = redactSecrets(e.stderr.toString());
  throw scrubbed;
}

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
    }).trim();
  } catch (err) {
    rethrowScrubbed(err);
  }
}

// argv-form executor for git invocations whose arguments contain externally-
// influenced values (repo names, URLs, paths). execFileSync passes args directly
// to the binary with NO shell, so metacharacters in any argument are inert —
// closing the `git clone "${url}"` command-injection class (C2). Use this, not
// `run`, for any git command interpolating a value that isn't a fixed literal or
// a strictly-validated token (e.g. taskId / branch from the `[A-Z0-9-]` charset).
function runArgs(file: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(file, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
    }).trim();
  } catch (err) {
    rethrowScrubbed(err);
  }
}

function tryRun(cmd: string, cwd?: string): string | null {
  try { return run(cmd, cwd); } catch { return null; }
}

const SENTINEL_FILE = '.nyx-task.pid';

interface Sentinel {
  pid: number;
  taskId: string;
  startedAt: string;
}

/**
 * Liveness check for sentinel ownership, hardened against PID reuse. A bare
 * process.kill(pid, 0) is a PID-reuse hazard: after the original dispatcher dies
 * the OS can recycle its PID for an unrelated process, and the signal then
 * reports it live — pinning a working dir to a ghost forever. A Nyx dispatcher
 * always runs as the operator's own user, so:
 *   - ESRCH (no such process) AND EPERM (PID owned by a different user, which a
 *     same-user dispatcher never is) both mean this is not our process -> stale.
 *   - When the PID is signalable, cross-check its command line still looks like
 *     a node process (the dispatcher runtime). A recycled PID running some other
 *     binary fails this and is treated as stale.
 * `ps` unavailable or empty -> fall back to the bare signal result (preserve the
 * more-permissive behavior rather than wrongly clearing a possibly-live dir).
 */
function isSentinelOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH (no such process) AND EPERM (PID owned by a different user, which a
    // same-user dispatcher never is) both mean this is not our process -> stale.
    return false;
  }
  const comm = tryRun(`ps -o comm= -p ${pid}`);
  if (comm === null || comm.trim() === '') return true;
  return /node/i.test(comm);
}

function readSentinel(dir: string): Sentinel | null {
  try {
    const raw = readFileSync(resolve(dir, SENTINEL_FILE), 'utf8');
    return JSON.parse(raw) as Sentinel;
  } catch {
    return null;
  }
}

/**
 * Keep the liveness sentinel out of the committed diff. `commitAll` runs
 * `git add -A`, which would otherwise stage `.nyx-task.pid` into EXTERNAL clones
 * (whose own `.gitignore` does not list it — only ~/Nyx's does). Add it to the
 * clone's `.git/info/exclude` so it's ignored regardless of the repo's tracked
 * `.gitignore`. Guarded: a linked worktree's `.git` is a FILE pointing at the
 * parent repo's gitdir (whose exclude already lists the sentinel via ~/Nyx),
 * so only act when `<workDir>/.git` is a real directory (a clone or fresh repo).
 */
function excludeSentinelFromCommit(workDir: string): void {
  try {
    const gitPath = resolve(workDir, '.git');
    if (!existsSync(gitPath) || !statSync(gitPath).isDirectory()) return;
    const excludePath = resolve(gitPath, 'info', 'exclude');
    mkdirSync(resolve(gitPath, 'info'), { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (current.split('\n').some(l => l.trim() === SENTINEL_FILE)) return;
    appendFileSync(excludePath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${SENTINEL_FILE}\n`, 'utf8');
  } catch { /* swallow — best-effort; sentinel-leak prevention is non-fatal */ }
}

export function writeLivenessSentinel(workDir: string, taskId: string): void {
  const sentinel: Sentinel = { pid: process.pid, taskId, startedAt: new Date().toISOString() };
  try {
    writeFileSync(resolve(workDir, SENTINEL_FILE), JSON.stringify(sentinel), 'utf8');
  } catch { /* swallow — missing sentinel is treated as stale, not crash */ }
  excludeSentinelFromCommit(workDir);
}

// Test seam: override the worktrees dir so unit tests don't touch the real repo.
let worktreesDirOverride: string | null = null;
export function _setWorktreesDir(dir: string | null): void { worktreesDirOverride = dir; }
function getWorktreesDir(): string { return worktreesDirOverride ?? config.worktreesDir; }

export function branchName(taskId: string): string {
  return `nyx/${taskId.toLowerCase()}`;
}

export function createLocalWorktree(taskId: string): WorkingDir {
  if (!existsSync(resolve(config.root, '.git'))) {
    run('git init', config.root);
    configureGitIdentity(config.root);
    if (!tryRun('git rev-parse --verify HEAD', config.root)) {
      run('git commit --allow-empty -m "nyx: init"', config.root);
    }
  }

  const branch = branchName(taskId);
  const path = resolve(getWorktreesDir(), taskId);
  if (existsSync(path)) {
    // Audit retry: reuse existing dir; sentinel already written with current PID.
    return {
      kind: 'worktree',
      path,
      branch,
      cleanup: () => removeWorktree(path),
    };
  }
  mkdirSync(getWorktreesDir(), { recursive: true });
  if (tryRun(`git rev-parse --verify ${branch}`, config.root)) {
    run(`git worktree add "${path}" "${branch}"`, config.root);
  } else {
    run(`git worktree add -b "${branch}" "${path}"`, config.root);
  }
  configureGitIdentity(path);
  writeLivenessSentinel(path, taskId);
  return {
    kind: 'worktree',
    path,
    branch,
    cleanup: () => removeWorktree(path),
  };
}

/**
 * Greenfield scaffold dir: a brand-new, standalone git repo (NOT a worktree of
 * ~/Nyx, NOT a clone of any remote). Used by pipeline runs whose `repo` is a
 * greenfield keyword (`local`) — the operator wants a new local project built
 * from scratch. `git init` + an empty initial commit so branches/worktrees/
 * merges work exactly like a cloned base. No liveness sentinel — the dir is the
 * deliverable and must stay clean. The caller owns the cleanup policy: the
 * throwaway planning dir deletes itself; the durable project base does not.
 */
export function createGreenfieldDir(path: string): WorkingDir {
  if (existsSync(path)) {
    // Durable deliverable dirs live under config.projectsDir and are NOT
    // throwaway. Distinct task_ids can sanitize to the same path (e.g. "My/Proj"
    // and "My_Proj" both -> "my_proj"), so a second greenfield run could wipe a
    // prior delivered project — a standalone repo with no remote, unrecoverable.
    // Refuse to clobber a non-empty durable project dir; the throwaway planning
    // dir (under cloneRootPrefix) still gets wiped for a clean slate on retry.
    const resolvedPath = resolve(path);
    const isDurable = resolvedPath === resolve(config.projectsDir) ||
      resolvedPath.startsWith(resolve(config.projectsDir) + '/');
    if (isDurable && readdirSync(path).length > 0) {
      throw new Error(
        `createGreenfieldDir refusing to wipe existing non-empty project dir ${resolvedPath}: ` +
          `another greenfield run's task_id sanitizes to this path. ` +
          `Use a distinct task_id or remove the prior deliverable manually.`,
      );
    }
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true });
  run('git init -b main', path);
  configureGitIdentity(path);
  run('git commit --allow-empty -m "nyx: greenfield init"', path);
  return {
    kind: 'clone',
    path,
    cleanup: () => { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); },
  };
}

/**
 * Pin the git author/committer identity inside a working dir so any commits
 * made there — including ones the spawned Claude makes directly via Bash —
 * are attributed to the configured operator. `commitAll()` ALSO sets the
 * identity via `-c` flags for defense in depth; this is the upstream pin.
 */
function configureGitIdentity(cwd: string): void {
  tryRun(`git config user.name "${config.gitAuthorName.replace(/"/g, '\\"')}"`, cwd);
  tryRun(`git config user.email "${config.gitAuthorEmail.replace(/"/g, '\\"')}"`, cwd);
}

export function removeWorktree(path: string): void {
  tryRun(`git worktree remove --force "${path}"`, config.root);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  tryRun(`git worktree prune`, config.root);
  // Also delete the per-run branch the worktree was created on
  // (`nyx/<taskId>`). The worktree's leaf dir name is the taskId, so branchName
  // reconstructs the exact branch. Guarded by tryRun: a branch that is still
  // checked out elsewhere or already gone is a clean no-op — without this, every
  // self-target run leaks a dangling nyx/* branch in config.root.
  tryRun(`git branch -D "${branchName(basename(path))}"`, config.root);
}

export function cloneExternalRepo(
  taskId: string,
  repo: string,
  depth = 1,
  opts: { reuseExisting?: boolean; baseBranch?: string } = {},
): WorkingDir {
  const path = `${config.cloneRootPrefix}${taskId}`;
  if (opts.reuseExisting && existsSync(path)) {
    // Audit-driven retry — preserve whatever the prior attempt + autofix wrote.
    return {
      kind: 'clone',
      path,
      cleanup: () => { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); },
    };
  }
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  const url = repoUrl(repo);
  // v0.8.x: honor gitTargets.baseBranch at clone time. Without --branch, git
  // clone fetches the remote's default branch (main). Tasks targeting a
  // non-default branch (e.g. dev for direct-push mode) need to start from
  // that branch's tip, not main's, or any pre-staged commits on the target
  // branch are invisible to the spawned Claude. Push-time rebase against
  // baseBranch then becomes a no-op rather than a divergence.
  // argv-form clone (C2): `url` derives from the task's `[repo:]` tag. Even with
  // parse-time validation upstream, never let it reach a shell. execFileSync
  // passes each arg verbatim to git with no `/bin/sh -c`, so a `repo` carrying
  // `"`, `;`, `$(…)` or backticks is an inert (and 404-ing) string, not a command.
  const cloneArgs = ['clone', '--depth', String(depth)];
  if (opts.baseBranch) cloneArgs.push('--branch', opts.baseBranch, '--single-branch');
  cloneArgs.push(url, path);
  runArgs('git', cloneArgs);
  configureGitIdentity(path);
  writeLivenessSentinel(path, taskId);

  // v0.9: strict baseBranch assertion. After clone, when opts.baseBranch is
  // set, HEAD MUST point at origin/<baseBranch>. If it doesn't, the clone is
  // misrooted — proceeding would cause the OUTREACH-SEQUENCE-CRON cascade
  // (clone defaulted to main, agent rebuilt entire sub-app, push to dev failed
  // as non-FF, audit retries cascaded). Throw loudly instead of silently.
  if (opts.baseBranch) {
    const headSha = tryRun('git rev-parse HEAD', path);
    const baseSha = tryRun(`git rev-parse origin/${opts.baseBranch}`, path);
    if (!headSha || !baseSha || headSha.trim() !== baseSha.trim()) {
      throw new Error(
        `clone baseBranch assertion failed for ${repo}: ` +
          `HEAD=${headSha?.trim() ?? '<unresolved>'} ` +
          `origin/${opts.baseBranch}=${baseSha?.trim() ?? '<unresolved>'}. ` +
          `Clone may have fallen back to repo default branch. ` +
          `the Arachne graph`,
      );
    }
  }

  return {
    kind: 'clone',
    path,
    cleanup: () => { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); },
  };
}

/**
 * v0.9: pre-push branch-ancestry validation. Verifies HEAD is a descendant
 * of origin/<expectedBase> before any push attempt. If it isn't, the local
 * branch was rooted on the wrong base — pushing would either fail with the
 * misleading "non-FF" error or, worse, overwrite legitimate work on the
 * target branch. Used by finalize.ts before pushDirectToBranch /
 * pushBranchAndOpenPR.
 *
 * Returns nothing on success; throws with a descriptive error on failure
 * so the caller can audit the assertion and halt.
 */
export function assertBranchOnBase(workingDir: string, expectedBase: string): void {
  // Refresh the remote ref first — origin/<base> may be stale from clone time.
  tryRun(`git fetch origin ${expectedBase}:refs/remotes/origin/${expectedBase}`, workingDir);
  const baseSha = tryRun(`git rev-parse origin/${expectedBase}`, workingDir);
  const headSha = tryRun('git rev-parse HEAD', workingDir);
  if (!baseSha || !headSha) {
    throw new Error(
      `assertBranchOnBase: cannot resolve refs ` +
        `(HEAD=${headSha?.trim() ?? '<unresolved>'}, ` +
        `origin/${expectedBase}=${baseSha?.trim() ?? '<unresolved>'})`,
    );
  }
  const mergeBase = tryRun(`git merge-base HEAD origin/${expectedBase}`, workingDir);
  if (!mergeBase || mergeBase.trim() !== baseSha.trim()) {
    const aheadCount = tryRun(`git rev-list --count origin/${expectedBase}..HEAD`, workingDir)?.trim() ?? '?';
    const behindCount = tryRun(`git rev-list --count HEAD..origin/${expectedBase}`, workingDir)?.trim() ?? '?';
    throw new Error(
      `assertBranchOnBase failed: HEAD is not a descendant of origin/${expectedBase}. ` +
        `HEAD=${headSha.trim()}, origin/${expectedBase}=${baseSha.trim()}, ` +
        `merge-base=${mergeBase?.trim() ?? '<none>'}. ` +
        `Local is ${aheadCount} ahead and ${behindCount} behind. ` +
        `This indicates the clone was rooted on the wrong base, or the local branch ` +
        `was rebased/checked-out to a divergent state. ` +
        `Pushing now would either fail as non-FF or overwrite ${expectedBase}. ` +
        `the Arachne graph`,
    );
  }
}

export function createCloneWithBranch(
  taskId: string,
  repo: string,
  opts: { reuseExisting?: boolean; baseBranch?: string } = {},
): WorkingDir {
  const wd = cloneExternalRepo(taskId, repo, 50, opts);
  const branch = branchName(taskId);
  if (!opts.reuseExisting) {
    run(`git checkout -b "${branch}"`, wd.path);
  }
  return { ...wd, branch };
}

export function createOutputDir(taskId: string, subPath?: string): WorkingDir {
  const dir = subPath
    ? resolve(config.outputsDir, subPath.replace(/^outputs\//, ''), taskId)
    : resolve(config.outputsDir, taskId);
  mkdirSync(dir, { recursive: true });
  return { kind: 'output', path: dir, cleanup: () => {} };
}

function repoUrl(repo: string): string {
  if (config.githubToken) return `https://x-access-token:${config.githubToken}@github.com/${repo}.git`;
  return `https://github.com/${repo}.git`;
}

/**
 * Checks whether a task's working directory is actively held by a live process.
 *
 * Returns:
 *   'live'          — working dir exists and the sentinel PID is alive
 *   'stale_cleared' — working dir existed but the process is dead (ghost); dir
 *                     has been cleaned up so the caller can re-dispatch
 *   'none'          — no working dir found
 *
 * Pre-v0.9 ghost worktrees (no sentinel file) are treated as stale and
 * auto-cleared on the first tick after deploy — desired recovery behavior.
 */
export function inFlight(taskId: string): 'live' | 'stale_cleared' | 'none' {
  const worktreePath = resolve(getWorktreesDir(), taskId);
  if (existsSync(worktreePath)) {
    const s = readSentinel(worktreePath);
    if (s && isSentinelOwnerAlive(s.pid)) return 'live';
    removeWorktree(worktreePath);
    return 'stale_cleared';
  }

  const clonePath = `${config.cloneRootPrefix}${taskId}`;
  if (existsSync(clonePath)) {
    const s = readSentinel(clonePath);
    if (s && isSentinelOwnerAlive(s.pid)) return 'live';
    try { rmSync(clonePath, { recursive: true, force: true }); } catch { /* swallow */ }
    return 'stale_cleared';
  }

  return 'none';
}

/**
 * Is the local HEAD ahead of `<ref>`? Returns true when there's at least one
 * commit on HEAD that isn't reachable from `ref`. Used by finalize to detect
 * the "Claude produced no new changes but a prior attempt's commit is still
 * sitting unpushed" state — that's a successful task whose only remaining
 * action is to push, not a failure that should trigger another audit pass.
 */
export function isBranchAhead(cwd: string, ref: string): boolean {
  // Make sure ref is fetched first; rev-list against a stale local copy of
  // the remote ref would lie about ahead-ness.
  tryRun('git fetch origin', cwd);
  const count = tryRun(`git rev-list ${ref}..HEAD --count`, cwd);
  if (count === null) return false;
  const n = Number.parseInt(count.trim(), 10);
  return Number.isFinite(n) && n > 0;
}

export function commitAll(cwd: string, message: string): boolean {
  tryRun('git add -A', cwd);
  const status = tryRun('git status --porcelain', cwd) ?? '';
  if (!status.trim()) return false;
  const name = config.gitAuthorName.replace(/"/g, '\\"');
  const email = config.gitAuthorEmail.replace(/"/g, '\\"');
  run(
    `git -c user.name="${name}" -c user.email="${email}" commit -m ${JSON.stringify(message)}`,
    cwd,
  );
  return true;
}

export function detectMainBranch(): string {
  // `--short` output is `origin/<branch>`; strip only the leading `origin/` so a
  // default branch that itself contains a slash (`origin/release/2026`) keeps
  // its full name rather than collapsing to the last segment via split/pop.
  const fromOrigin = tryRun('git symbolic-ref --short refs/remotes/origin/HEAD', config.root)?.replace(/^origin\//, '');
  if (fromOrigin) return fromOrigin;
  const explicit = process.env['NYX_MAIN_BRANCH'];
  if (explicit) return explicit;
  throw new Error(
    'cannot determine main branch: set origin/HEAD with `git remote set-head origin -a`, ' +
      'or set NYX_MAIN_BRANCH in .env',
  );
}

export interface MergeSnapshot {
  mainBranch: string;
  preMergeSha: string;
  stashed: boolean;
}

export function mergeBranchIntoMain(branch: string): MergeSnapshot {
  const mainBranch = detectMainBranch();
  // The operator may be actively editing config.root (the LIVE ~/Nyx repo).
  // A self-task worktree branch that touches the same tracked files git would
  // refuse the `checkout`/`merge` outright ("local changes would be
  // overwritten"). Stash the operator's uncommitted work (tracked + untracked)
  // first, restore it after; never auto-commit it.
  // Arachne node self-task-merge-local-changes
  const dirty = (tryRun('git status --porcelain', config.root) ?? '').trim().length > 0;
  let stashed = false;
  if (dirty) {
    const out = tryRun('git stash push --include-untracked -m "nyx: pre-merge operator stash"', config.root);
    stashed = out !== null && !/No local changes to save/.test(out);
  }
  run(`git checkout ${mainBranch}`, config.root);
  const preMergeSha = run('git rev-parse HEAD', config.root);
  try {
    run(`git merge --no-ff ${branch} -m "nyx: merge ${branch}"`, config.root);
  } catch (err) {
    // A conflicting merge leaves config.root mid-merge (MERGE_HEAD set, conflict
    // markers in tracked files). Abort + hard-reset to the pre-merge sha so the
    // live repo is always clean before the exception propagates, then re-throw
    // with err.stdout (where git writes the CONFLICT notices) folded into the
    // message so the audit-classifier's merge-conflict pattern can match it.
    tryRun('git merge --abort', config.root);
    tryRun(`git reset --hard ${preMergeSha}`, config.root);
    // Restore the operator's stashed working tree before propagating — the live
    // repo must be returned to exactly the state we found it in on failure.
    if (stashed) tryRun('git stash pop', config.root);
    const e = err as Error & { stdout?: Buffer | string };
    const stdout = e.stdout ? e.stdout.toString() : '';
    throw new Error(stdout ? `${stdout}\n${e.message}` : e.message);
  }
  // Merge succeeded — restore the operator's pending edits on top of the merge.
  if (stashed) tryRun('git stash pop', config.root);
  return { mainBranch, preMergeSha, stashed };
}

export function resetMainTo(snapshot: MergeSnapshot): void {
  run(`git checkout ${snapshot.mainBranch}`, config.root);
  run(`git reset --hard ${snapshot.preMergeSha}`, config.root);
}

/**
 * Best-effort abort of any in-progress merge in config.root. Safe no-op when no
 * merge is underway (`git merge --abort` exits non-zero, swallowed by tryRun).
 * Used by finalizeCodeLocal's rollback path so the live repo is never left in a
 * conflicted mid-merge state across ticks.
 */
export function abortMergeIfAny(cwd: string = config.root): void {
  tryRun('git merge --abort', cwd);
}

/**
 * Push the branch and open a PR. Returns the PR URL on success, null on any
 * failure (push reject, gh auth fail, etc.). v0.6.3: switched push from `run`
 * (throws) to `tryRun` (returns null) — a push failure used to bubble all the
 * way to main()'s top-level handler, crashing the dispatcher without cleaning
 * up the clone. Now it surfaces as a normal finalize failure with cleanup.
 *
 * Common push-failure causes:
 *   - file > 100MB without LFS (GitHub's hard limit)
 *   - branch protection / required reviewers
 *   - non-fast-forward (a previous attempt left a different branch state)
 *   - auth (no PAT / expired token)
 */
export function pushBranchAndOpenPR(
  cwd: string,
  branch: string,
  taskId: string,
  description: string,
  baseBranch?: string,
): string | null {
  // v0.7: rebase against the target base branch (default: detected main)
  // before pushing. The clone was made at dispatch-start time; if another
  // task in this chain merged anything since, the PR opens behind the base
  // and conflicts trigger the merge-treadmill we saw during the EMP build-out.
  // A clean rebase here avoids that entirely.
  const fetched = tryRun('git fetch origin', cwd);
  if (fetched === null) return null;
  const target = baseBranch ?? detectBaseBranch(cwd);
  const rebased = tryRun(`git rebase origin/${target}`, cwd);
  if (rebased === null) {
    tryRun('git rebase --abort', cwd);
    return null;
  }
  const pushed = tryRun(`git push --force-with-lease -u origin "${branch}"`, cwd);
  if (pushed === null) return null;
  const title = `${taskId}: ${description}`.slice(0, 200);
  const body = `Generated by Nyx.\n\n${description}`;
  const out = tryRun(
    `gh pr create --base ${target} --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --head ${branch}`,
    cwd,
  );
  if (!out) return null;
  const urlMatch = out.match(/https?:\/\/\S+/);
  const prUrl = urlMatch?.[0] ?? out.trim();
  // Opt-in auto-merge only — matches the pipeline delivery contract
  // (delivery.ts: "the operator reviews + merges"). Default is OFF; a code
  // task's PR is terminal-A PR-ready, not auto-shipped. GitHub still waits for
  // required checks/approvals when auto-merge is enabled on the repo.
  if (prUrl && config.settings.pipeline.autoMerge) {
    tryRun(`gh pr merge --auto --squash ${JSON.stringify(prUrl)}`, cwd);
  }
  return prUrl;
}

/**
 * Direct-push mode (v0.8): push the working dir's commits straight to the
 * target branch with no PR. Used for repos that have a protected main +
 * dedicated integration branch (e.g. `dev`), where Nyx is trusted to
 * append commits to the integration branch and the operator handles the
 * dev → main promotion separately.
 *
 * Flow:
 *   1. git fetch origin
 *   2. git rebase origin/<target>
 *   3. git push origin HEAD:<target>   (fast-forward only — if non-FF, fail and let audit handle)
 *
 * Returns the resulting branch URL on success (https://github.com/<repo>/tree/<target>)
 * for the operator's reference, or null on any failure. The caller treats null
 * the same as a PR-creation failure.
 */
export function pushDirectToBranch(
  cwd: string,
  target: string,
  repo: string,
): string | null {
  const fetched = tryRun('git fetch origin', cwd);
  if (fetched === null) return null;
  // Check the target branch exists on origin; if not, fail loud rather than
  // silently creating it (operator should pre-create dev branches).
  const ref = tryRun(`git rev-parse --verify origin/${target}`, cwd);
  if (ref === null) return null;
  const rebased = tryRun(`git rebase origin/${target}`, cwd);
  if (rebased === null) {
    tryRun('git rebase --abort', cwd);
    return null;
  }
  // Fast-forward push HEAD onto the remote target. NO --force; if dev moved
  // forward concurrently we want the push to fail and the audit phase to
  // rebase + retry.
  const pushed = tryRun(`git push origin HEAD:refs/heads/${target}`, cwd);
  if (pushed === null) return null;
  return `https://github.com/${repo}/tree/${target}`;
}

/**
 * Detect the default base branch for a clone — gh stores origin/HEAD on
 * clone; fall back to `main`. Used when no per-task / per-repo override is
 * specified.
 */
function detectBaseBranch(cwd: string): string {
  // Strip only the leading `origin/` (not every '/') so a default branch with a
  // slash in its name survives — see detectMainBranch for the same reasoning.
  return tryRun('git symbolic-ref --short refs/remotes/origin/HEAD', cwd)?.replace(/^origin\//, '') ?? 'main';
}
