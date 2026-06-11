/**
 * Pipeline executing stage (⑤) — run the frozen DAG's flight plans as parallel
 * coders, each in its own git worktree off a shared integration base, each
 * committing to its own branch. No clobbering.
 *
 * Step 3 scope: the parallel coder execution + isolation only. There is NO
 * merge and NO composer redux yet (⑥, step 4) — coders run in topological waves
 * (≤ concurrency cap) against the integration base IN ISOLATION: a coder cannot
 * see a sibling's uncommitted work, so it codes against its flight-plan
 * `consumes` contract. Redux (step 4) reconciles + merges the branches.
 *
 * Testability: `scheduleWaves` (the topological + cap-bounded scheduler) is pure
 * and fully unit-tested. The per-coder git+spawn (`defaultRunCoder`) and the
 * base clone (`setupIntegrationBase`) are dependency-injected so `runExecuting`
 * can be driven with canned coders, and `defaultRunCoder` is exercised against a
 * real temp git repo with a fake spawn.
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { liveOwnClaudeCount } from '../claude-registry.js';
import * as git from '../git-ops.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import { addUsage, costMeteringArgs, parseCostActuals, parseUsage, type CostActuals, type SpawnUsage } from '../spawn-usage.js';
import { pipelineRunEnv, loadRunDecisions } from './run-secrets.js';
import { parsePlanJson, renderCoderSpec, type FlightPlanContract, type PlanningResult } from './flight-plan.js';
import type { PlanTarget } from './planning.js';
import { updateRun } from './db.js';
import { appDestination, invalidRepoReason, targetMode } from './target.js';
import type { PipelineRun } from './types.js';

const CODER_TIMEOUT_MS = 30 * 60_000;
const CODER_MODEL = 'sonnet';
const CODER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'MultiEdit', 'TodoWrite'];

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase();
}

export class ExecuteError extends Error {}

/**
 * A reused `worktree_base` that no longer exists on disk (M2). Multi-phase runs
 * span many ticks (one phase/tick, 30-min coder caps → hours-to-days); the /tmp
 * base of a self/external run can be evicted by a reboot or tmp-reaper mid-run.
 * Distinct from ExecuteError so the orchestrator routes it to a RECOVERABLE
 * base-missing halt instead of failing every coder with a raw ENOENT.
 */
export class BaseMissingError extends Error {}

export type CoderStatus = 'committed' | 'no_changes' | 'failed';

export interface CoderResult {
  task_id: string;
  branch: string;
  status: CoderStatus;
  commit: string | null;
  files_changed: string[];
  exit_code: number;
  log: string;
  /** Locally-estimated cost/tokens for this coder spawn; null when metering is off. */
  usage?: SpawnUsage | null;
}

export interface ExecuteResult {
  coder_results: CoderResult[];
  integration_branch: string;
  worktree_base: string;
}

// ─── Pure scheduler ───────────────────────────────────────────────────────────

interface SchedNode {
  id: string;
  deps: string[];
}

/**
 * Run each node through `runOne` in topological order, at most `cap` running
 * concurrently. A node starts only once all its (in-set) deps have COMPLETED
 * (any status — a failed dep doesn't block; step 4's redux handles the hole). A
 * dependency cycle / unsatisfiable dep is broken by force-starting a node so the
 * scheduler always makes progress. Returns results in COMPLETION order.
 */
export async function scheduleWaves<T>(
  nodes: SchedNode[],
  cap: number,
  runOne: (id: string) => Promise<T>,
): Promise<Array<{ id: string; result: T }>> {
  const cap_ = Math.max(1, cap);
  const ids = new Set(nodes.map((n) => n.id));
  const pending = new Map(nodes.map((n) => [n.id, n.deps.filter((d) => ids.has(d))]));
  const done = new Set<string>();
  const running = new Map<string, Promise<{ id: string; result: T }>>();
  const out: Array<{ id: string; result: T }> = [];

  const startReady = (): void => {
    for (const [id, deps] of pending) {
      if (running.size >= cap_) break;
      if (running.has(id)) continue;
      if (deps.every((d) => done.has(d))) {
        running.set(id, runOne(id).then((result) => ({ id, result })));
      }
    }
  };

  while (done.size < nodes.length) {
    startReady();
    if (running.size === 0) {
      // No node became ready (cycle / dangling dep) — force-start one to progress.
      const next = [...pending.keys()].find((id) => !running.has(id));
      if (next === undefined) break;
      running.set(next, runOne(next).then((result) => ({ id: next, result })));
    }
    const finished = await Promise.race(running.values());
    running.delete(finished.id);
    pending.delete(finished.id);
    done.add(finished.id);
    out.push(finished);
  }
  return out;
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitRun(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}
function gitTry(cmd: string, cwd: string): string | null {
  try {
    return gitRun(cmd, cwd);
  } catch {
    return null;
  }
}

export function coderBranch(runId: string, taskId: string): string {
  return `nyx-pipeline/${sanitize(runId)}/${sanitize(taskId)}`;
}

/**
 * Clone the target repo (or local ~/Nyx) into a base, create the integration
 * branch off its HEAD. Coders add worktrees off this base; step 4 merges their
 * branches here. Returns the base path + integration branch + a cleanup thunk.
 */
export function setupIntegrationBase(run: PipelineRun, target: PlanTarget): {
  basePath: string;
  integrationBranch: string;
  cleanup: () => void;
} {
  const mode = targetMode(target.repo);
  let base: git.WorkingDir;
  if (mode === 'external') {
    const baseBranch = config.gitTargets[target.repo!]?.baseBranch;
    base = git.cloneExternalRepo(`${run.id}-base`, target.repo!, 1, baseBranch ? { baseBranch } : {});
  } else if (mode === 'greenfield') {
    // Durable, standalone repo under Data/projects/<task>: this IS the deliverable,
    // so cleanup must NOT delete it (no-op cleanup; delivery keeps the base).
    const projectPath = resolve(config.projectsDir, sanitize(run.task_id));
    base = { ...git.createGreenfieldDir(projectPath), cleanup: () => {} };
  } else if (mode === 'app') {
    // Greenfield variant landing at the durable appsDir/<slug> (slug verbatim —
    // never sanitize(task_id) here, or the path stops matching the operator's
    // tag). Same cleanup policy as greenfield: the base IS the deliverable.
    // Re-check the collision here even though planning already refused: the
    // preview gate sits between the two (TOCTOU across ticks), and an existing
    // dir reaching createGreenfieldDir is a standalone repo with no remote —
    // unrecoverable. This branch only runs when the run has no recorded base
    // (runExecuting reuses run.worktree_base otherwise), so an existing dir
    // here is ALWAYS a foreign collision, never the run's own resume.
    const dest = appDestination(target.repo);
    if (existsSync(dest)) {
      throw new ExecuteError(
        `app destination ${dest} already exists — refusing to overwrite it. ` +
          `Pick a different app:<slug> or move the existing directory aside.`,
      );
    }
    base = { ...git.createGreenfieldDir(dest), cleanup: () => {} };
  } else if (mode === 'invalid') {
    throw new ExecuteError(invalidRepoReason(target.repo));
  } else {
    // Self-mode pipeline is unsupported (C1). It used to clone ~/Nyx into a /tmp
    // base, build the integration branch there, then DELETE that base at cleanup
    // with no merge-back into ~/Nyx and no push — silent, success-reported total
    // data loss on the documented no-[repo:] default path. handlePipelineInTick
    // rejects these up front; this throw is the defense-in-depth backstop for any
    // run that still reaches execution (e.g. a legacy in-flight self run). To
    // build a new standalone project use [repo: local] (greenfield, persists to
    // Data/projects); to modify Nyx itself use a [type: code] task.
    throw new ExecuteError(
      `self-mode pipeline is unsupported (no [repo:]): the build would land in a ` +
        `/tmp clone that cleanup deletes with no merge-back. Use [repo: local] for a ` +
        `new standalone project, [repo: owner/name] for a GitHub repo, or [type: code] ` +
        `to modify Nyx itself.`,
    );
  }
  const integrationBranch = `nyx-pipeline/${sanitize(run.id)}/integration`;
  gitRun(`git checkout -B "${integrationBranch}"`, base.path);
  gitTry(`git config user.name "${config.gitAuthorName.replace(/"/g, '\\"')}"`, base.path);
  gitTry(`git config user.email "${config.gitAuthorEmail.replace(/"/g, '\\"')}"`, base.path);
  return { basePath: base.path, integrationBranch, cleanup: base.cleanup };
}

// ─── Per-coder execution ──────────────────────────────────────────────────────

export interface CoderContext {
  run: PipelineRun;
  plan: FlightPlanContract;
  basePath: string;
  fromRef: string;
  spawn: CoderSpawn;
}

export interface CoderSpawnArgs {
  prompt: string;
  workingDir: string;
  timeoutMs: number;
  label: string;
  runId: string;
}
export type CoderSpawn = (args: CoderSpawnArgs) => Promise<{ exitCode: number; stderr: string; usage?: SpawnUsage | null }>;

const realCoderSpawn: CoderSpawn = async (a) => {
  const env: NodeJS.ProcessEnv = {
    ...pipelineRunEnv(a.runId),
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  const args = [
    '-p',
    a.prompt,
    '--model',
    CODER_MODEL,
    '--permission-mode',
    config.claudePermissionMode,
    '--allowed-tools',
    CODER_TOOLS.join(' '),
    ...(config.costMeteringEnabled ? costMeteringArgs() : []),
    '--add-dir',
    a.workingDir,
  ];
  // Capture stdout ONLY to parse the cost envelope — a coder's success is judged
  // by its git diff, never by its stdout text, so there's no sentinel to preserve
  // here (unlike the main task path). The silence watchdog guards the long coder
  // budget against a hung tool/MCP call.
  const r = await spawnWithTimeout(
    'claude',
    args,
    {
      cwd: a.workingDir,
      env,
      captureStdout: config.costMeteringEnabled,
      label: a.label,
      silenceTimeoutMs: config.claudeSilenceTimeoutMs || undefined,
      claudeMeta: { class: 'git' },
    },
    a.timeoutMs,
  );
  const usage = config.costMeteringEnabled && r.exitCode === 0 ? parseUsage(r.stdout) : null;
  return { exitCode: r.exitCode, stderr: r.stderr, usage };
};

/**
 * The coder prompt is the COMPILED SCOPED SPEC for this task — never the overall
 * operator goal. Feeding a coder the full goal is what let one coder do a
 * sibling's work (the producer/consumer cross-contamination); the scoped spec
 * (`renderCoderSpec`) gives it only its slice. The only run-level context added
 * is the operator's corrective-wave directive, when present.
 */
function coderPrompt(run: PipelineRun, plan: FlightPlanContract): string {
  let prompt = renderCoderSpec(plan);
  if (run.fix_directive && run.fix_directive.trim()) {
    prompt +=
      `\n\n## Operator correction (this is a corrective wave — incorporate it, still within your scope)\n` +
      run.fix_directive.trim();
  }
  const decisions = loadRunDecisions(run.id);
  if (decisions.length > 0) {
    prompt +=
      `\n\n## Operator decisions at the preview gate (honor these, still within your scope)\n` +
      decisions.map((d) => `- ${d.question} → ${d.answer.toUpperCase()}${d.note ? ` (${d.note})` : ''}`).join('\n');
  }
  return prompt;
}

/** Real per-coder run: add a worktree off the base, spawn the coder, commit. */
export async function defaultRunCoder(ctx: CoderContext): Promise<CoderResult> {
  const branch = coderBranch(ctx.run.id, ctx.plan.task_id);
  const wtPath = resolve(`${config.cloneRootPrefix}${ctx.run.id}-wt-${sanitize(ctx.plan.task_id)}`);
  const base: CoderResult = {
    task_id: ctx.plan.task_id,
    branch,
    status: 'failed',
    commit: null,
    files_changed: [],
    exit_code: -1,
    log: '',
  };
  try {
    if (existsSync(wtPath)) gitTry(`git worktree remove --force "${wtPath}"`, ctx.basePath);
    gitRun(`git worktree add -b "${branch}" "${wtPath}" "${ctx.fromRef}"`, ctx.basePath);
  } catch (err) {
    return { ...base, log: `worktree add failed: ${(err as Error).message}` };
  }

  const spawnRes = await ctx.spawn({
    prompt: coderPrompt(ctx.run, ctx.plan),
    workingDir: wtPath,
    timeoutMs: CODER_TIMEOUT_MS,
    label: `pipeline-coder-${sanitize(ctx.plan.task_id)}`,
    runId: ctx.run.id,
  });

  // Commit anything the coder left uncommitted (it may have committed itself).
  gitTry(`git add -A`, wtPath);
  const dirty = gitTry(`git status --porcelain`, wtPath);
  if (dirty && dirty.length > 0) {
    // task_id + description are LLM-generated free text; quote the message with
    // JSON.stringify (the canonical safe pattern — git-ops.ts commitAll) so a
    // literal `"`, backtick, or `$(...)` can't corrupt or inject into the shell
    // command. Escape author name/email too.
    const name = config.gitAuthorName.replace(/"/g, '\\"');
    const email = config.gitAuthorEmail.replace(/"/g, '\\"');
    const message = `pipeline ${ctx.plan.task_id}: ${ctx.plan.description.slice(0, 60)}`;
    gitTry(
      `git -c user.name="${name}" -c user.email="${email}" commit -m ${JSON.stringify(message)}`,
      wtPath,
    );
  }
  const commit = gitTry(`git rev-parse HEAD`, wtPath);
  const baseHead = gitTry(`git rev-parse "${ctx.fromRef}"`, wtPath);
  const filesRaw = commit && baseHead && commit !== baseHead
    ? gitTry(`git diff --name-only "${ctx.fromRef}"..HEAD`, wtPath)
    : '';
  const files = (filesRaw ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  const committed = commit !== baseHead && files.length > 0;

  return {
    task_id: ctx.plan.task_id,
    branch,
    status: committed ? 'committed' : spawnRes.exitCode === 0 ? 'no_changes' : 'failed',
    commit: committed ? commit : null,
    files_changed: files,
    exit_code: spawnRes.exitCode,
    log: spawnRes.stderr.slice(-500),
    usage: spawnRes.usage ?? null,
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface ExecuteDeps {
  /** Override the per-coder runner (tests inject canned results). */
  runCoder?: (ctx: CoderContext) => Promise<CoderResult>;
  /** Override base setup (tests inject a base path, skipping the real clone). */
  base?: { basePath: string; integrationBranch: string; cleanup?: () => void };
  /** Override the coder spawn (used by the real runner; tests with a real git base). */
  spawn?: CoderSpawn;
  /**
   * Override the concurrency cap. When omitted the cap is derived as
   * min(config.pipelineCoderConcurrency, maxConcurrentClaude - liveSpawnCount()),
   * floored at 1. An explicit value bypasses the budget bound entirely (tests).
   */
  cap?: number;
  /**
   * Live Nyx-spawned claude count at phase start (the ISO pool already running
   * this tick). Subtracted from maxConcurrentClaude to size the coder budget.
   * Defaults to the real registry count; tests inject a fixed number.
   */
  liveSpawnCount?: () => number;
}

/**
 * Execute the frozen plan: set up the integration base, run every flight plan as
 * a coder in topological waves (≤ cap), persist results onto the run. Returns
 * the per-coder results + base/branch info.
 */
export async function runExecuting(run: PipelineRun, deps: ExecuteDeps = {}): Promise<ExecuteResult> {
  const plan: PlanningResult | null = parsePlanJson(run.plan_json);
  if (!plan || plan.plans.length === 0) {
    throw new ExecuteError(`run ${run.id} has no frozen plan to execute`);
  }
  // Phase-scope: run ONLY the current phase's tasks. They branch off the
  // integration branch, which already carries every prior phase's merged code —
  // so a later phase's coders see the real, merged work of earlier phases.
  const phaseOf = (p: { phase?: number }): number => (Number.isInteger(p.phase) ? (p.phase as number) : 0);
  const phasePlans = plan.plans.filter((p) => phaseOf(p) === run.current_phase);
  if (phasePlans.length === 0) {
    throw new ExecuteError(`run ${run.id} has no tasks in phase ${run.current_phase}`);
  }
  const target: PlanTarget = { id: run.task_id, description: run.prompt, ...(run.repo ? { repo: run.repo } : {}) };
  // Set the base up ONCE (phase 0); later phases reuse it so they branch off the
  // accumulated integration branch. M2: a reuse must revalidate the base dir on
  // disk — a string in `worktree_base` does NOT prove the dir survived a reboot /
  // tmp eviction between ticks. Without the guard every coder's `git worktree
  // add` ENOENT-fails against the vanished cwd and redux fails the same way,
  // surfacing as mass coder failure and discarding the already-merged earlier
  // phases (whose only copy lived in the deleted clone). Drive a recoverable
  // base-missing halt instead so the operator can rollback/re-run cleanly.
  let base: { basePath: string; integrationBranch: string; cleanup?: () => void };
  if (deps.base) {
    base = deps.base;
  } else if (run.worktree_base && run.integration_branch) {
    if (!existsSync(run.worktree_base)) {
      throw new BaseMissingError(
        `pipeline base ${run.worktree_base} no longer exists on disk (evicted between ticks). ` +
          `The integration branch carrying earlier phases lived only there. Rollback to replan, ` +
          `or abort.`,
      );
    }
    base = { basePath: run.worktree_base, integrationBranch: run.integration_branch };
  } else {
    base = setupIntegrationBase(run, target);
  }
  const spawn = deps.spawn ?? realCoderSpawn;
  const runCoder = deps.runCoder ?? defaultRunCoder;
  // Coder concurrency is bounded by BOTH the pipeline-specific cap AND the
  // aggregate Max-plan ceiling. The coders spawn claude inside the GIT slot
  // while the tick's ISO pool is already live, so coders + ISO together must
  // not exceed maxConcurrentClaude or the shared OAuth quota is blown. Subtract
  // the already-live spawns (the ISO pool registered earlier this tick) and
  // floor at 1 so a fully-saturated budget still makes progress one coder at a
  // time rather than deadlocking. A test-injected `deps.cap` overrides both.
  const liveSpawnCount = deps.liveSpawnCount ?? liveOwnClaudeCount;
  const budgetCap = Math.max(1, config.maxConcurrentClaude - liveSpawnCount());
  const cap = deps.cap ?? Math.min(config.pipelineCoderConcurrency, budgetCap);

  const byId = new Map(phasePlans.map((p) => [p.task_id, p]));
  const nodes: SchedNode[] = phasePlans.map((p) => ({ id: p.task_id, deps: p.deps }));

  const scheduled = await scheduleWaves(nodes, cap, async (id) => {
    const fp = byId.get(id)!;
    audit('pipeline.coder.started', 'pipeline.execute', { runId: run.id, phase: run.current_phase, taskId: id });
    const result = await runCoder({ run, plan: fp, basePath: base.basePath, fromRef: base.integrationBranch, spawn });
    audit('pipeline.coder.finished', 'pipeline.execute', {
      runId: run.id,
      phase: run.current_phase,
      taskId: id,
      status: result.status,
      files: result.files_changed.length,
    });
    return result;
  });

  const resultById = new Map(scheduled.map((s) => [s.id, s.result]));
  const phaseResults = phasePlans.map((p) => resultById.get(p.task_id)!).filter(Boolean);

  // Accumulate coder_results across phases (drop any prior entry for the same
  // task id, then append this phase's), so redux can find each phase's branches.
  const prior: CoderResult[] = run.coder_results ? (JSON.parse(run.coder_results) as CoderResult[]) : [];
  const phaseTaskIds = new Set(phaseResults.map((r) => r.task_id));
  const coderResults = [...prior.filter((r) => !phaseTaskIds.has(r.task_id)), ...phaseResults];

  // Per-RUN cost accumulation (G-B/P1). Parallel coders multiply spend ~Nx, so the
  // meaningful budget is per-run, not per-spawn — fold THIS phase's coder usage
  // into the persisted running total. Accumulated across phases via the prior
  // cost_actuals value, so it survives the one-phase-per-tick resume model.
  const priorCost = parseCostActuals(run.cost_actuals);
  let costActuals: CostActuals | null = priorCost;
  for (const r of phaseResults) costActuals = addUsage(costActuals, r.usage ?? null);

  updateRun(
    run.id,
    {
      coder_results: JSON.stringify(coderResults),
      integration_branch: base.integrationBranch,
      worktree_base: base.basePath,
      ...(costActuals ? { cost_actuals: JSON.stringify(costActuals) } : {}),
    },
    Date.now(),
  );

  return { coder_results: phaseResults, integration_branch: base.integrationBranch, worktree_base: base.basePath };
}
