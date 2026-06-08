/**
 * Composer redux (⑥) — inspect-before-merge + cross-worktree reconciliation.
 * This is composer stages 1–3 promoted into the pipeline.
 *
 * Design (moc-nyx-pipeline (Arachne)): **the LLM judge is primary;
 * deterministic git facts are a sensor feed, NOT a growing rule engine.**
 *   - Free universal facts (no per-project expansion): `git diff --name-only`,
 *     diff-stat, the coder's exit/commit status, and the MERGE TRIAL (try the
 *     merge — git decides). Harvested and fed to the judge for grounding + focus.
 *   - The judge does ALL judgment (scope / signature / semantic) against the
 *     flight-plan contract — generalizes, zero per-project rules.
 *   - Authoritative-deterministic outcomes (merge conflict, didn't-run) are NOT
 *     judgments — they short-circuit straight to a flagged verdict.
 *
 * Two phases:
 *   P1 per-coder  — facts + judge each diff vs ITS OWN flight plan → verdict.
 *   P2 cross-worktree — judge ALL coders through the interface graph
 *                       (creates/consumes) → system breakage + per-task
 *                       fits-the-whole verdict + remediation directives. P2 is
 *                       the final arbiter and can re-flag a P1-clean coder. The
 *                       adversarial cross-check is folded in (no separate spawn).
 *
 * Merge queue: merge only clean + fits-the-whole branches into the integration
 * branch (topological); the real merge is authoritative (a clean-trial branch
 * that conflicts after a sibling merged is held). Flagged tasks → remediation
 * plan → R1 (step 5).
 *
 * Testability: `decideMerges` is pure; `harvestFacts` + `runMergeQueue` are real
 * git (tested vs temp repos); the two judges are dependency-injected.
 */

import { execSync } from 'node:child_process';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import { updateRun } from './db.js';
import {
  extractJson,
  parsePlanJson,
  topoOrderOf,
  type FlightPlanContract,
} from './flight-plan.js';
import type { CoderResult } from './execute.js';
import type { PipelineRun } from './types.js';

const JUDGE_TIMEOUT_MS = 8 * 60_000;
const P1_MODEL = 'sonnet';
const P2_MODEL = 'opus';
const JUDGE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite'];
const DIFF_CAP = 12_000;

export class ReduxError extends Error {}

export type P1Verdict = 'clean' | 'scope_drift' | 'signature_drift' | 'conflict' | 'failed' | 'semantic_suspect';

export interface CoderFacts {
  task_id: string;
  branch: string;
  exit_code: number;
  status: CoderResult['status'];
  files_changed: string[];
  diffstat: string;
  merge_trial: 'clean' | 'conflict' | 'empty';
}

export interface P1Finding {
  task_id: string;
  verdict: P1Verdict;
  detail: string;
  out_of_scope_files: string[];
}

export interface P2PerTask {
  task_id: string;
  fits_whole: boolean;
  reason: string;
}

export interface RemediationDirective {
  task_id: string;
  problem: string;
  target_state: string;
}

export interface P2Result {
  system_findings: Array<{ detail: string; involved: string[] }>;
  per_task: P2PerTask[];
  remediation: RemediationDirective[];
  catastrophic: boolean;
  catastrophic_reason: string;
}

export interface ReduxResult {
  facts: CoderFacts[];
  p1: P1Finding[];
  p2: P2Result;
  merged: string[];
  held: string[];
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

/** Trial-merge `branch` into `integration` (no commit), then undo. git decides. */
function tryMerge(basePath: string, integration: string, branch: string): 'clean' | 'conflict' | 'empty' {
  gitTry(`git checkout -q "${integration}"`, basePath);
  let trial: 'clean' | 'conflict' | 'empty';
  try {
    const out = gitRun(`git merge --no-commit --no-ff "${branch}"`, basePath);
    trial = /already up to date/i.test(out) ? 'empty' : 'clean';
  } catch {
    trial = 'conflict';
  }
  gitTry(`git merge --abort`, basePath);
  gitTry(`git reset --hard -q "${integration}"`, basePath);
  return trial;
}

/**
 * Harvest the free deterministic facts per coder. No judgment — just what git +
 * the coder's exit status say. Fed to the judges for grounding.
 */
export function harvestFacts(basePath: string, integration: string, coders: CoderResult[]): CoderFacts[] {
  return coders.map((c): CoderFacts => {
    const base: CoderFacts = {
      task_id: c.task_id,
      branch: c.branch,
      exit_code: c.exit_code,
      status: c.status,
      files_changed: c.files_changed,
      diffstat: '',
      merge_trial: 'empty',
    };
    if (c.status === 'failed' || !c.commit) return base;
    const files = gitTry(`git diff --name-only "${integration}".."${c.branch}"`, basePath);
    const diffstat = gitTry(`git diff --stat "${integration}".."${c.branch}"`, basePath);
    return {
      ...base,
      files_changed: (files ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
      diffstat: diffstat ?? '',
      merge_trial: tryMerge(basePath, integration, c.branch),
    };
  });
}

// ─── Judge injection ──────────────────────────────────────────────────────────

export interface JudgeSpawnArgs {
  prompt: string;
  model: string;
  workingDir: string;
  timeoutMs: number;
  label: string;
}
export type JudgeSpawn = (args: JudgeSpawnArgs) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const realJudgeSpawn: JudgeSpawn = async (a) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  const args = [
    '-p',
    a.prompt,
    '--model',
    a.model,
    '--permission-mode',
    config.claudePermissionMode,
    '--allowed-tools',
    JUDGE_TOOLS.join(' '),
    '--add-dir',
    a.workingDir,
  ];
  const r = await spawnWithTimeout(
    'claude',
    args,
    { cwd: a.workingDir, env, captureStdout: true, label: a.label },
    a.timeoutMs,
  );
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

// ─── Prompts + parsers ────────────────────────────────────────────────────────

function p1Prompt(plan: FlightPlanContract, facts: CoderFacts, diff: string): string {
  const L: string[] = [];
  L.push(`# Composer redux P1 — judge coder ${plan.task_id}`);
  L.push('');
  L.push('Judge ONE coder\'s diff against ITS OWN flight-plan contract. You are the primary judgment — the git facts below are grounding, not rules. Look for: scope drift (touched files outside its contract), signature drift (created symbols differ from the contract), and anything semantically wrong even if no rule names it.');
  L.push('');
  L.push('## Flight-plan contract');
  L.push('```json');
  L.push(JSON.stringify(plan, null, 2));
  L.push('```');
  L.push('');
  L.push('## Deterministic facts (grounding)');
  L.push('```json');
  L.push(JSON.stringify({ files_changed: facts.files_changed, diffstat: facts.diffstat, merge_trial: facts.merge_trial, status: facts.status }, null, 2));
  L.push('```');
  L.push('');
  L.push('## Diff (truncated)');
  L.push('```diff');
  L.push(diff.slice(0, DIFF_CAP));
  L.push('```');
  L.push('');
  L.push('## Output — write ONLY this JSON to stdout');
  L.push('```json');
  L.push(JSON.stringify({ task_id: plan.task_id, verdict: 'clean | scope_drift | signature_drift | conflict | failed | semantic_suspect', detail: 'one paragraph', out_of_scope_files: ['files touched outside the contract'] }, null, 2));
  L.push('```');
  return L.join('\n');
}

function p2Prompt(plans: FlightPlanContract[], p1: P1Finding[], facts: CoderFacts[]): string {
  const L: string[] = [];
  L.push('# Composer redux P2 — cross-worktree consolidation');
  L.push('');
  L.push('You are the FINAL arbiter of whether each coder fits the WHOLE. Examine all coders together through the interface graph: each plan `creates` symbols and `consumes` symbols from siblings. A coder is broken-for-integration when its drift violates a sibling\'s `consumes` (A changed what B relies on), when two coders overlap conflictingly, or when a failure leaves a hole a sibling needs. You MAY re-flag a coder P1 called clean if it breaks integration. For every coder that won\'t merge cleanly, produce a remediation directive: what\'s broken, why it won\'t fit the rest, and the target state to fix toward.');
  L.push('');
  L.push('## Flight plans (the interface graph: creates/consumes)');
  L.push('```json');
  L.push(JSON.stringify(plans, null, 2));
  L.push('```');
  L.push('');
  L.push('## P1 per-coder verdicts');
  L.push('```json');
  L.push(JSON.stringify(p1, null, 2));
  L.push('```');
  L.push('');
  L.push('## Facts (merge trials + files changed)');
  L.push('```json');
  L.push(JSON.stringify(facts.map((f) => ({ task_id: f.task_id, files_changed: f.files_changed, merge_trial: f.merge_trial, status: f.status })), null, 2));
  L.push('```');
  L.push('');
  L.push('## Output — write ONLY this JSON to stdout');
  L.push('```json');
  L.push(
    JSON.stringify(
      {
        system_findings: [{ detail: 'one paragraph', involved: ['task ids'] }],
        per_task: [{ task_id: 'id', fits_whole: true, reason: 'one line' }],
        remediation: [{ task_id: 'id', problem: 'what is broken + why it will not fit', target_state: 'what to fix toward' }],
        catastrophic: false,
        catastrophic_reason: 'set true + explain ONLY if the run is genuinely unrecoverable and must escalate to the human now (strong bias against this)',
      },
      null,
      2,
    ),
  );
  L.push('```');
  return L.join('\n');
}

function parseP1(raw: string, plan: FlightPlanContract): P1Finding {
  const j = extractJson(raw) as Record<string, unknown> | null;
  const valid: P1Verdict[] = ['clean', 'scope_drift', 'signature_drift', 'conflict', 'failed', 'semantic_suspect'];
  const verdict = (j && valid.includes(j.verdict as P1Verdict) ? j.verdict : 'semantic_suspect') as P1Verdict;
  return {
    task_id: plan.task_id,
    verdict,
    detail: typeof j?.detail === 'string' ? j.detail : 'judge returned no usable verdict',
    out_of_scope_files: Array.isArray(j?.out_of_scope_files) ? (j!.out_of_scope_files as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}

function parseP2(raw: string, plans: FlightPlanContract[]): P2Result {
  const parsed = extractJson(raw) as Record<string, unknown> | null;
  // P2 is the FINAL arbiter. If it returned no usable JSON (timed out, crashed,
  // or emitted prose only), that is "arbiter UNAVAILABLE" — NOT "no objection."
  // Defaulting an absent arbiter to fits_whole=true silently merges
  // semantically-broken cross-task integration. Instead HOLD every task so the
  // phase stays held → diagnostics/review gate, never an auto-merge on a verdict
  // that was never rendered.
  if (parsed === null) {
    return {
      system_findings: [{ detail: 'P2 arbiter returned no usable verdict (timeout/crash/no JSON) — holding all tasks pending review.', involved: plans.map((p) => p.task_id) }],
      per_task: plans.map((p): P2PerTask => ({ task_id: p.task_id, fits_whole: false, reason: 'P2 arbiter unavailable — held, not approved' })),
      remediation: [],
      catastrophic: false,
      catastrophic_reason: '',
    };
  }
  const j = parsed;
  const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const sarr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const perTask = arr(j.per_task).map((t): P2PerTask => ({ task_id: str(t.task_id), fits_whole: t.fits_whole === true, reason: str(t.reason) }));
  // The judge DID render a verdict: a plan it didn't single out is "no objection."
  const named = new Set(perTask.map((t) => t.task_id));
  for (const p of plans) if (!named.has(p.task_id)) perTask.push({ task_id: p.task_id, fits_whole: true, reason: 'no objection from P2' });
  return {
    system_findings: arr(j.system_findings).map((f) => ({ detail: str(f.detail), involved: sarr(f.involved) })),
    per_task: perTask,
    remediation: arr(j.remediation).map((r): RemediationDirective => ({ task_id: str(r.task_id), problem: str(r.problem), target_state: str(r.target_state) })),
    catastrophic: j.catastrophic === true,
    catastrophic_reason: str(j.catastrophic_reason),
  };
}

// ─── Pure merge decision ──────────────────────────────────────────────────────

/**
 * A task is mergeable iff P1 said `clean`, P2 said `fits_whole`, AND every
 * producer it depends on is ALSO mergeable. That last clause is the
 * interface-graph gate: merging a consumer while its producer is held leaves
 * the integration branch with a reference to code that never landed (the
 * orphaned-consumer failure). Producers = `deps` ∪ `consumes[].from_task`.
 * Computed to a fixpoint so a held producer cascades to every transitive
 * consumer. Returns the mergeable ids in topological order + the held ids. Pure.
 */
export function decideMerges(
  plans: FlightPlanContract[],
  p1: P1Finding[],
  p2: P2Result,
): { mergeOrder: string[]; held: string[] } {
  const byId = new Map(plans.map((p) => [p.task_id, p]));
  // P1 verdicts the P2 arbiter is allowed to clear. `semantic_suspect` is P1's
  // "looks unusual, not sure" verdict (and the parse-failure default) — exactly
  // what P2, the FINAL arbiter, exists to adjudicate. Without this, a coder P1
  // flags suspect and P2 explicitly clears (fits_whole) is still held forever,
  // with no remediation directive, so the autonomous rounds flail and it
  // escalates to a review gate with only destructive options. Hard P1 verdicts
  // (conflict/failed/scope_drift/signature_drift) stay blocking regardless of P2.
  const P1_SOFT = new Set<P1Verdict>(['clean', 'semantic_suspect']);
  const p1soft = new Set(p1.filter((f) => P1_SOFT.has(f.verdict)).map((f) => f.task_id));
  const p2ok = new Set(p2.per_task.filter((t) => t.fits_whole).map((t) => t.task_id));

  // Seed with the locally-acceptable tasks (P2 fits ∧ P1 not a hard failure),
  // then drop any whose producers aren't also in the set, repeating until stable.
  const mergeable = new Set(plans.filter((p) => p1soft.has(p.task_id) && p2ok.has(p.task_id)).map((p) => p.task_id));
  const producersOf = (p: FlightPlanContract): string[] => [
    ...p.deps,
    ...p.consumes.map((c) => c.from_task),
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...mergeable]) {
      const plan = byId.get(id);
      if (!plan) continue;
      const orphaned = producersOf(plan).some((prod) => byId.has(prod) && !mergeable.has(prod));
      if (orphaned) {
        mergeable.delete(id);
        changed = true;
      }
    }
  }

  const ordered = topoOrderOf(plans).filter((id) => mergeable.has(id));
  const held = plans.map((p) => p.task_id).filter((id) => !mergeable.has(id));
  return { mergeOrder: ordered, held };
}

// ─── Real merge queue ─────────────────────────────────────────────────────────

/**
 * Merge each task's branch into the integration branch in order. The real merge
 * is authoritative: a branch that conflicts now (a sibling merged first) is
 * aborted + added to `held` even if its trial was clean.
 */
export function runMergeQueue(
  basePath: string,
  integration: string,
  order: string[],
  branchByTask: Map<string, string>,
): { merged: string[]; held: string[] } {
  gitTry(`git checkout -q "${integration}"`, basePath);
  const merged: string[] = [];
  const held: string[] = [];
  for (const taskId of order) {
    const branch = branchByTask.get(taskId);
    if (!branch) {
      held.push(taskId);
      continue;
    }
    try {
      gitRun(`git merge --no-ff -m "pipeline: integrate ${taskId}" "${branch}"`, basePath);
      merged.push(taskId);
    } catch {
      gitTry(`git merge --abort`, basePath);
      held.push(taskId);
    }
  }
  return { merged, held };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface ReduxDeps {
  judgeP1?: (plan: FlightPlanContract, facts: CoderFacts) => Promise<P1Finding>;
  judgeP2?: (plans: FlightPlanContract[], p1: P1Finding[], facts: CoderFacts[]) => Promise<P2Result>;
  /** Skip git fact-harvest + merge queue (tests inject everything). */
  base?: { basePath: string; integration: string };
}

export async function runRedux(run: PipelineRun, deps: ReduxDeps = {}): Promise<ReduxResult> {
  const plan = parsePlanJson(run.plan_json);
  if (!plan) throw new ReduxError(`run ${run.id} has no frozen plan`);
  const allCoders: CoderResult[] = run.coder_results ? (JSON.parse(run.coder_results) as CoderResult[]) : [];

  // Phase-scope: redux reconciles only the CURRENT phase's tasks. Earlier-phase
  // tasks are already merged on the integration branch; later-phase tasks haven't
  // run. (undefined phase normalizes to 0 for legacy/single-phase plans.)
  const phaseOf = (p: { phase?: number }): number => (Number.isInteger(p.phase) ? (p.phase as number) : 0);
  const plans = plan.plans.filter((p) => phaseOf(p) === run.current_phase);
  const phaseIds = new Set(plans.map((p) => p.task_id));
  const coders = allCoders.filter((c) => phaseIds.has(c.task_id));
  if (coders.length === 0) throw new ReduxError(`run ${run.id} has no coder results to reconcile in phase ${run.current_phase}`);

  const basePath = deps.base?.basePath ?? run.worktree_base;
  const integration = deps.base?.integration ?? run.integration_branch;
  if (!basePath || !integration) throw new ReduxError(`run ${run.id} missing integration base / branch`);

  const facts = harvestFacts(basePath, integration, coders);
  const factByTask = new Map(facts.map((f) => [f.task_id, f]));

  // P1: judge each coder vs its own plan. Deterministic outcomes override.
  const judgeP1 = deps.judgeP1 ?? defaultJudgeP1(basePath, integration);
  const p1: P1Finding[] = [];
  for (const fp of plans) {
    const f = factByTask.get(fp.task_id)!;
    let finding = await judgeP1(fp, f);
    if (f.status === 'failed') finding = { ...finding, verdict: 'failed' };
    else if (f.merge_trial === 'conflict') finding = { ...finding, verdict: 'conflict' };
    p1.push(finding);
  }

  // P2: cross-worktree — the final arbiter.
  const judgeP2 = deps.judgeP2 ?? defaultJudgeP2(basePath);
  const p2 = await judgeP2(plans, p1, facts);

  // Decide + merge.
  const { mergeOrder, held: decidedHeld } = decideMerges(plans, p1, p2);
  const branchByTask = new Map(coders.map((c) => [c.task_id, c.branch]));
  const { merged, held: mergeHeld } = runMergeQueue(basePath, integration, mergeOrder, branchByTask);
  const held = Array.from(new Set([...decidedHeld, ...mergeHeld]));

  const result: ReduxResult = { facts, p1, p2, merged, held };

  // Persist a trimmed findings blob + the remediation plan (current phase).
  updateRun(
    run.id,
    {
      redux_findings: JSON.stringify({ phase: run.current_phase, p1, system_findings: p2.system_findings, per_task: p2.per_task, merged, held, catastrophic: p2.catastrophic }),
      remediation_plan: JSON.stringify(p2.remediation),
    },
    Date.now(),
  );

  audit('pipeline.redux.complete', 'pipeline.redux', {
    runId: run.id,
    phase: run.current_phase,
    coders: coders.length,
    merged: merged.length,
    held: held.length,
    catastrophic: p2.catastrophic,
  });
  if (p2.catastrophic) {
    audit('pipeline.short_circuit', 'pipeline.redux', { runId: run.id, reason: p2.catastrophic_reason.slice(0, 300) });
  }
  return result;
}

function defaultJudgeP1(basePath: string, integration: string): NonNullable<ReduxDeps['judgeP1']> {
  return async (plan, facts) => {
    const diff = gitTry(`git diff "${integration}".."${facts.branch}"`, basePath) ?? '';
    const res = await realJudgeSpawn({
      prompt: p1Prompt(plan, facts, diff),
      model: P1_MODEL,
      workingDir: basePath,
      timeoutMs: JUDGE_TIMEOUT_MS,
      label: `redux-p1-${plan.task_id}`,
    });
    return parseP1(res.stdout, plan);
  };
}

function defaultJudgeP2(basePath: string): NonNullable<ReduxDeps['judgeP2']> {
  return async (plans, p1, facts) => {
    const res = await realJudgeSpawn({
      prompt: p2Prompt(plans, p1, facts),
      model: P2_MODEL,
      workingDir: basePath,
      timeoutMs: JUDGE_TIMEOUT_MS,
      label: 'redux-p2',
    });
    return parseP2(res.stdout, plans);
  };
}
