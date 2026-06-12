import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { changedFiles, detectDeployRequired } from '../deploy-detector.js';
import * as git from '../git-ops.js';
import * as notify from '../notifier.js';
import type { ParsedTask, RunOutcome } from '../types.js';

export interface FinalizeContext {
  task: ParsedTask;
  workingDir: git.WorkingDir;
  durationMs: number;
  testsPassed?: number;
}

/**
 * Resolve a task's `[output:]` value against config.dataDir and assert the
 * result stays within config.dataDir. `task.output` is taken verbatim from the
 * queue task's tag with no parse-time validation, so an absolute path or one
 * containing `..` segments could otherwise escape dataDir and write artifacts
 * anywhere the dispatcher user can write. Returns the resolved base, or null if
 * the value escapes the data directory.
 */
function resolveOutputBase(output: string, ...extra: string[]): string | null {
  const base = resolve(config.dataDir, output.replace(/\/$/, ''), ...extra);
  const rel = relative(config.dataDir, base);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return base;
  return null;
}

/**
 * Count commits on `branch` not reachable from `baseBranch`, evaluated in
 * config.root (where both refs live for a self-task worktree). Returns 0 when
 * git is unavailable or either ref can't be resolved. Never throws.
 *
 * Used by finalizeCodeLocal to distinguish a real "Claude produced nothing"
 * no-op from a prior attempt that committed to the worktree branch but crashed
 * before merging — the latter is still a successful task whose only remaining
 * action is the merge, not a failure that should re-enter the audit pipeline.
 */
function commitsAheadOfMain(branch: string, baseBranch: string): number {
  try {
    const out = execSync(`git rev-list "${baseBranch}".."${branch}" --count`, {
      cwd: config.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve a git ref (e.g. `origin/dev`) to its current commit SHA in the given
 * working dir. Returns null if git is unavailable or the ref doesn't exist.
 * Never throws.
 *
 * Used to snapshot the deploy base SHA BEFORE a direct push: pushDirectToBranch
 * updates the local remote-tracking ref `origin/<target>` to equal HEAD on a
 * successful push, so diffing against the live `origin/<target>` ref afterwards
 * always yields an empty diff. Capturing the pre-push SHA preserves the real
 * base so the deploy-detection diff reflects exactly what shipped.
 */
function resolveRefSha(workingDirPath: string, ref: string): string | null {
  try {
    const out = execSync(`git rev-parse --verify "${ref}"`, {
      cwd: workingDirPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Emit `task.production.deploy_required` when the task's committed diff touches
 * files that require a manual production deploy step. This is observational only
 * — it does NOT block task completion. The event payload names the matched files
 * and the deploy surfaces so the operator can act without cross-referencing the
 * codebase.
 *
 * Skipped silently when deployPatterns is empty (repo has no deploy config) or
 * when changedFiles() returns an empty list (git unavailable, bad baseRef, etc.).
 */
function maybeEmitDeployRequired(
  task: ParsedTask,
  workingDirPath: string,
  baseRef: string,
  deployPatterns: string[],
  deployTargets: string[],
): void {
  if (deployPatterns.length === 0) return;
  const changed = changedFiles(workingDirPath, baseRef);
  const { matchedFiles } = detectDeployRequired(changed, deployPatterns);
  if (matchedFiles.length > 0) {
    audit('task.production.deploy_required', 'dispatcher', {
      taskId: task.id,
      repo: task.repo,
      matchedFiles,
      deployTargets,
    });
  }
}

export async function finalizeCodeLocal(ctx: FinalizeContext): Promise<RunOutcome> {
  const { task, workingDir, durationMs } = ctx;
  const message = `nyx(${task.id}): ${task.description}`;
  const didCommit = git.commitAll(workingDir.path, message);

  // Mirror finalizeCodeExternal's no-changes handling. When Claude produced no
  // new file changes there are two sub-cases:
  //   1. A prior attempt committed to the worktree branch but crashed before
  //      merging — the branch has commits not yet in main. The work IS done;
  //      fall through to the merge. Don't burn another audit cycle.
  //   2. Nothing was ever committed and the branch has no commits ahead of
  //      main — a real "Claude produced nothing" failure. Route to audit
  //      instead of silently reporting success.
  let priorAttemptCommit = false;
  if (!didCommit) {
    const mainBranch = git.detectMainBranch();
    priorAttemptCommit =
      !!workingDir.branch && commitsAheadOfMain(workingDir.branch, mainBranch) > 0;
    if (!priorAttemptCommit) {
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog: 'claude produced no file changes — nothing to commit or merge',
      };
    }
  }

  if (didCommit) {
    audit('task.committed', 'dispatcher', { taskId: task.id });
  } else {
    audit('task.committed', 'dispatcher', {
      taskId: task.id,
      source: 'prior-attempt',
      note: 'no new changes this attempt; merging existing branch commit(s)',
    });
  }
  if ((didCommit || priorAttemptCommit) && workingDir.branch) {
    let snapshot: git.MergeSnapshot | null = null;
    try {
      snapshot = git.mergeBranchIntoMain(workingDir.branch);
      audit('task.merged', 'dispatcher', { taskId: task.id, branch: workingDir.branch });
    } catch (err) {
      const e = err as Error;
      // mergeBranchIntoMain self-cleans on conflict (abort + reset to its
      // pre-merge sha), so config.root is already clean when it throws. The
      // best-effort abort here covers any other mid-merge throw path and is a
      // safe no-op when no merge is in progress; resetMainTo runs only when a
      // snapshot exists (a throw AFTER a successful merge returned).
      git.abortMergeIfAny();
      if (snapshot) {
        git.resetMainTo(snapshot);
        audit('task.rollback', 'dispatcher', { taskId: task.id, reason: e.message, restoredTo: snapshot.preMergeSha });
      } else {
        audit('task.rollback', 'dispatcher', { taskId: task.id, reason: e.message, restoredTo: 'pre-merge-noop' });
      }
      return { taskId: task.id, status: 'failed', durationMs, failureLog: `merge failed: ${e.message}` };
    }
  }
  workingDir.cleanup();
  return { taskId: task.id, status: 'completed', durationMs, testsPassed: ctx.testsPassed };
}

export async function finalizeCodeExternal(ctx: FinalizeContext): Promise<RunOutcome> {
  const { task, workingDir, durationMs } = ctx;
  if (!workingDir.branch) {
    return { taskId: task.id, status: 'failed', durationMs, failureLog: 'no branch on working dir' };
  }

  const message = `nyx(${task.id}): ${task.description}`;
  const didCommit = git.commitAll(workingDir.path, message);

  // v0.8.x: resolve target BEFORE the no-changes check so we can use baseBranch
  // to detect "no new changes but prior commit still pending push" — which is
  // a successful task whose only remaining work is the push, not a failure.
  const target = task.repo ? config.gitTargets[task.repo] : undefined;

  if (!didCommit) {
    // No new file changes from Claude. Two sub-cases:
    //   1. Local HEAD is ahead of origin/<baseBranch> from a prior attempt
    //      that committed but failed to push (audit pipeline interrupted).
    //      The work IS done; just push. Don't burn another audit cycle.
    //   2. Local HEAD == origin/<baseBranch>: nothing was ever committed.
    //      This is a real failure (claude didn't change anything).
    const baseRef = target?.baseBranch
      ? `origin/${target.baseBranch}`
      : `origin/${git.detectMainBranch()}`;
    if (git.isBranchAhead(workingDir.path, baseRef)) {
      audit('task.committed', 'dispatcher', {
        taskId: task.id,
        source: 'prior-attempt',
        note: 'no new changes this attempt; pushing existing local commit(s)',
      });
      // fall through to push
    } else {
      // Real "Claude produced nothing" failure. Preserve dir for audit.
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog: 'claude produced no file changes — nothing to commit or push',
      };
    }
  } else {
    audit('task.committed', 'dispatcher', { taskId: task.id });
  }

  // v0.8: per-repo target was resolved above before the no-changes check.
  // Repos configured for `direct` push (branch-protected main + dedicated
  // integration branch like dev) skip PR creation; the working dir's commits
  // get rebased onto and pushed directly to the integration branch.
  if (target?.pushMode === 'direct' && task.repo) {
    // v0.9: pre-push branch-ancestry assertion. Catches the OUTREACH-SEQUENCE-CRON
    // failure mode (clone misrooted on wrong base, push to dev would either fail
    // as non-FF or overwrite legitimate work). Fail fast with structured error
    // rather than letting the push attempt produce misleading "rebase conflict"
    // messaging that audit-classifier misinterprets.
    try {
      git.assertBranchOnBase(workingDir.path, target.baseBranch);
    } catch (err) {
      const failureLog = `clone branch-ancestry assertion failed before push: ${(err as Error).message}`;
      audit('task.clone.basebranch.assertion_failed', 'dispatcher', {
        taskId: task.id,
        repo: task.repo,
        expected_base: target.baseBranch,
        error: (err as Error).message,
      });
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog,
      };
    }

    // Snapshot the deploy base SHA BEFORE the push. pushDirectToBranch updates
    // the local `origin/<baseBranch>` tracking ref to equal HEAD on success, so
    // diffing against the live ref afterwards is always empty. Falling back to
    // the live ref name (null capture) preserves prior behavior for the case
    // where the ref can't be resolved pre-push.
    const deployBaseRef =
      resolveRefSha(workingDir.path, `origin/${target.baseBranch}`) ??
      `origin/${target.baseBranch}`;

    const branchUrl = git.pushDirectToBranch(workingDir.path, target.baseBranch, task.repo);
    if (!branchUrl) {
      // v0.8.x: do NOT cleanup() on failure here. The dispatchOne audit loop
      // (cli/run-once.ts) inspects the preserved working dir to diagnose and
      // potentially auto-fix the push problem. Tearing down here means the
      // diagnostic agent spawns with cwd=<deleted-dir>, gets ENOENT, returns
      // empty output, and the failure surfaces as "unparseable diagnostic"
      // instead of the real push failure log. Cleanup happens on the success
      // path below, or on operator-driven resume.
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog: `direct push to ${task.repo}@${target.baseBranch} failed — rebase conflict, non-FF, or auth`,
      };
    }
    audit('task.pushed', 'dispatcher', {
      taskId: task.id,
      mode: 'direct',
      repo: task.repo,
      baseBranch: target.baseBranch,
      branchUrl,
    });
    // Detect whether the diff touches files that need a manual production deploy.
    // Fires after the successful push so the event reflects exactly what shipped.
    // baseRef is the SHA captured BEFORE the push (deployBaseRef) — the live
    // origin/<baseBranch> tracking ref now equals HEAD post-push and would diff empty.
    maybeEmitDeployRequired(
      task,
      workingDir.path,
      deployBaseRef,
      target.deployPatterns ?? [],
      target.deployTargets ?? [],
    );
    await notify.prCreated(task.id, branchUrl);
    workingDir.cleanup();
    return {
      taskId: task.id,
      status: 'completed',
      durationMs,
      prUrl: branchUrl,
      ...(ctx.testsPassed != null ? { testsPassed: ctx.testsPassed } : {}),
    };
  }

  const baseBranch = target?.baseBranch;
  const prUrl = git.pushBranchAndOpenPR(
    workingDir.path,
    workingDir.branch,
    task.id,
    task.description,
    baseBranch,
  );
  if (!prUrl) {
    // v0.8.x: preserve dir for audit. Cleanup runs on success/resume.
    return {
      taskId: task.id,
      status: 'failed',
      durationMs,
      failureLog: 'branch was pushed but `gh pr create` returned no URL (auth missing? duplicate PR?)',
    };
  }
  audit('task.pr.created', 'dispatcher', { taskId: task.id, prUrl });
  // Detect whether the PR diff touches files that need a manual production deploy.
  // Fires after the successful PR creation so the event reflects exactly what was pushed.
  // baseBranch is the PR base — either from gitTargets or defaulting to 'main'.
  maybeEmitDeployRequired(
    task,
    workingDir.path,
    `origin/${baseBranch ?? 'main'}`,
    target?.deployPatterns ?? [],
    target?.deployTargets ?? [],
  );
  await notify.prCreated(task.id, prUrl);
  workingDir.cleanup();
  return { taskId: task.id, status: 'completed', durationMs, prUrl, ...(ctx.testsPassed != null ? { testsPassed: ctx.testsPassed } : {}) };
}

export async function finalizeAnalysis(ctx: FinalizeContext): Promise<RunOutcome> {
  const { task, workingDir, durationMs } = ctx;
  const findingsSrc = resolve(workingDir.path, 'NYX_FINDINGS.md');
  if (!existsSync(findingsSrc)) {
    // v0.8.x: preserve dir for audit.
    return {
      taskId: task.id,
      status: 'failed',
      durationMs,
      failureLog: 'analysis produced no NYX_FINDINGS.md',
    };
  }
  let outBase: string;
  if (task.output) {
    const resolved = resolveOutputBase(task.output);
    if (!resolved) {
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog: `[output:] path escapes data dir: ${task.output}`,
      };
    }
    outBase = resolved;
  } else {
    outBase = resolve(config.outputsDir, 'reports');
  }
  mkdirSync(outBase, { recursive: true });
  const outFile = resolve(outBase, `${task.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  cpSync(findingsSrc, outFile);
  audit('task.output.written', 'dispatcher', { taskId: task.id, path: outFile });
  workingDir.cleanup();
  return { taskId: task.id, status: 'completed', durationMs, outputPath: outFile };
}

export async function finalizeContent(ctx: FinalizeContext): Promise<RunOutcome> {
  const { task, workingDir, durationMs } = ctx;
  const entries = existsSync(workingDir.path) ? readdirSync(workingDir.path) : [];
  const artifacts = entries.filter(n => !n.startsWith('.git'));
  if (artifacts.length === 0) {
    // v0.8.x: preserve dir for audit.
    return {
      taskId: task.id,
      status: 'failed',
      durationMs,
      failureLog: 'content task produced no output files',
    };
  }
  let outBase: string;
  if (task.output) {
    const resolved = resolveOutputBase(task.output, task.id);
    if (!resolved) {
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog: `[output:] path escapes data dir: ${task.output}`,
      };
    }
    outBase = resolved;
  } else {
    outBase = resolve(config.outputsDir, 'content', task.id);
  }
  mkdirSync(outBase, { recursive: true });
  for (const name of artifacts) {
    cpSync(resolve(workingDir.path, name), resolve(outBase, name), { recursive: true });
  }
  audit('task.output.written', 'dispatcher', { taskId: task.id, path: outBase });
  workingDir.cleanup();
  return { taskId: task.id, status: 'completed', durationMs, outputPath: outBase };
}

export async function finalizeAssistant(ctx: FinalizeContext): Promise<RunOutcome> {
  const { task, workingDir, durationMs } = ctx;
  const outFile = resolve(workingDir.path, 'ASSISTANT_OUTPUT.md');
  if (!existsSync(outFile)) {
    // v0.8.x: preserve dir for audit.
    return {
      taskId: task.id,
      status: 'failed',
      durationMs,
      failureLog: 'assistant task produced no ASSISTANT_OUTPUT.md',
    };
  }
  const body = readFileSync(outFile, 'utf8');

  // Contact surface: a `[slack-reply:]` task composed a member reply into
  // ./SLACK_REPLY.md; deliver it in-thread HERE, over the notifier's bot-token
  // client — the bot is the only Nyx-side participant in the member↔bot DM, so
  // this is the one path that actually lands. A missing/empty reply or a
  // failed post is a task FAILURE (dir preserved, audit pipeline takes over) —
  // never a silent completion that drops the member's answer.
  if (task.slackReply) {
    const { channelId, threadTs } = task.slackReply;
    const replyFile = resolve(workingDir.path, 'SLACK_REPLY.md');
    const reply = existsSync(replyFile) ? readFileSync(replyFile, 'utf8').trim() : '';
    if (!reply) {
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog: 'respond task produced no usable SLACK_REPLY.md (missing or empty) — member reply not deliverable',
      };
    }
    const sent = await notify.postSlackThreadReply(channelId, threadTs, reply.slice(0, 4000));
    if (!sent) {
      audit('slack.reply.failed', 'dispatcher', { taskId: task.id, channelId, threadTs });
      return {
        taskId: task.id,
        status: 'failed',
        durationMs,
        failureLog:
          `member reply composed but Slack delivery failed (notifier bot path did not reach channel ${channelId}, ` +
          `thread ${threadTs}) — reply preserved in SLACK_REPLY.md`,
      };
    }
    audit('slack.reply.sent', 'dispatcher', { taskId: task.id, channelId, threadTs, bytes: reply.length });
  }

  await notify.dm(`📋 ${task.id}\n${body.slice(0, 3500)}`);
  audit('assistant.reminder', 'dispatcher', { taskId: task.id, bytes: body.length });
  workingDir.cleanup();
  return { taskId: task.id, status: 'completed', durationMs };
}
