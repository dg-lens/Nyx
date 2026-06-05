/**
 * Pipeline orchestrator — advances a run through the state machine.
 *
 * A pipeline run is stateful across many ticks. `advancePipeline` runs
 * autonomous segments back-to-back until it hits a terminal status OR a gate
 * with no operator decision (a human pause), then returns — the run row holds
 * the state a later tick resumes from.
 *
 * ─── STEP 2 (preview gate live) ───
 * Planning (②③④) is REAL: agents spawn in a clone of the target repo and emit a
 * task DAG + flight-plan contracts + an alignment/preflight report (planning.ts).
 * The run then PAUSES at `awaiting_preview` — brief written to disk, Slack ping
 * fired — until the operator answers (go/revise/abort) via the portal or
 * `nyx pipeline …`. A later tick's resume scan advances it.
 *
 * Executing + shipping are STILL skeleton stubs (build steps 3–5): once the
 * preview is approved the run walks to `done` without real coders/redux. So a
 * step-2 run is "real planning + a real human gate + a stub delivery."
 *
 * Planning is dependency-injected (`AdvanceDeps.plan`) so the state-machine
 * orchestration is unit-testable with a canned PlanningResult — no clone, no
 * spawn. Production wires the real `runPlanning`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import * as notify from '../notifier.js';
import type { ParsedTask } from '../types.js';
import { createRun, getRun, getRunByTaskId, runsAwaitingDecision, updateRun } from './db.js';
import { runExecuting, type ExecuteResult } from './execute.js';
import { buildPreviewBrief, freezePlan, groupPhases, hasBlockingConflicts, parsePlanJson, previewRecommendation, type PlanningResult } from './flight-plan.js';
import { runPlanning, type PlanTarget } from './planning.js';
import { runRedux, type ReduxResult } from './redux.js';
import { MAX_AUTONOMOUS_DIAGNOSTIC_ROUNDS, buildReviewBrief, reviewRecommendation, runDiagnosticRound, runShipping, type ShipOutcome } from './shipping.js';
import { cleanupRunArtifacts, runDelivery, type DeliveryResult } from './delivery.js';
import { assertTransition } from './state-machine.js';
import { isAwaiting, isTerminal, type PipelineRun, type PipelineStatus } from './types.js';

/** Bound the advance loop — terminal/pause is the real exit; this guards a bug. */
const MAX_SEGMENTS_PER_ADVANCE = 32;

function now(): number {
  return Date.now();
}

// ─── Brief output (test seam) ─────────────────────────────────────────────────

let briefsDir = resolve(config.dataDir, 'data', 'pipeline-briefs');
/** Test seam — redirect gate briefs away from the real data dir. */
export function _setBriefsDir(dir: string): void {
  briefsDir = dir;
}

function writeBriefFile(runId: string, markdown: string): string {
  mkdirSync(briefsDir, { recursive: true });
  const path = resolve(briefsDir, `${runId}.md`);
  writeFileSync(path, markdown, 'utf8');
  return path;
}

function writeBrief(runId: string, prompt: string, result: PlanningResult): string {
  return writeBriefFile(runId, buildPreviewBrief(runId, prompt, result));
}

// ─── Dependency injection ─────────────────────────────────────────────────────

export interface AdvanceDeps {
  /** Override planning (tests inject a canned PlanningResult). */
  plan?: (run: PipelineRun) => Promise<PlanningResult>;
  /** Override executing (the current phase's coders — tests inject canned results). */
  execute?: (run: PipelineRun) => Promise<ExecuteResult>;
  /** Override composer redux for the current phase (tests inject reconciliation). */
  redux?: (run: PipelineRun) => Promise<ReduxResult>;
  /** Override one diagnostic round on the current phase's held tasks. */
  diagnose?: (run: PipelineRun, round: number) => Promise<void>;
  /** Override shipping (tests inject a green/review outcome — no diagnose/smoke). */
  ship?: (run: PipelineRun) => Promise<ShipOutcome>;
  /** Override delivery (tests inject a canned PR result — no push/cleanup). */
  deliver?: (run: PipelineRun) => Promise<DeliveryResult>;
}

/** Production planning: build a target from the run, run the real engine. */
function realPlan(run: PipelineRun): Promise<PlanningResult> {
  const target: PlanTarget = { id: run.task_id, description: run.prompt, ...(run.repo ? { repo: run.repo } : {}) };
  const revisionNote =
    run.operator_decision?.kind === 'revise' ? run.operator_decision.note ?? null : null;
  return runPlanning(run, target, revisionNote ? { revisionNote } : {});
}

// ─── Transition helper ────────────────────────────────────────────────────────

function transition(run: PipelineRun, to: PipelineStatus, patch: Partial<PipelineRun> = {}): PipelineRun {
  assertTransition(run.status, to);
  const updated = updateRun(run.id, { ...patch, status: to }, now());
  if (!updated) throw new Error(`pipeline run vanished mid-transition: ${run.id}`);
  audit('pipeline.stage.advanced', 'pipeline', {
    runId: run.id,
    from: run.status,
    to,
    ...(patch.current_stage ? { stage: patch.current_stage } : {}),
  });
  return updated;
}

/** Create a fresh run for a pipeline task and emit `pipeline.run.started`. */
export function createPipelineRun(task: ParsedTask): PipelineRun {
  const id = `pr_${task.id}_${now().toString(36)}`;
  const run = createRun({ id, taskId: task.id, prompt: task.description, repo: task.repo ?? null, now: now() });
  audit('pipeline.run.started', 'pipeline', { runId: id, taskId: task.id, repo: task.repo ?? null });
  void notify.pipelineRunStarted(id, task.id, task.repo ?? null);
  return run;
}

// ─── Stage segments ───────────────────────────────────────────────────────────

/** Planning (②③④) → freeze proposed plan, write brief, PAUSE at preview gate. */
async function stagePlanning(run: PipelineRun, deps: ResolvedDeps): Promise<PipelineRun> {
  const result = await deps.plan(run);
  const briefPath = writeBrief(run.id, run.prompt, result);
  const r = transition(run, 'awaiting_preview', {
    plan_json: freezePlan(result),
    bz_brief_path: briefPath,
    current_stage: 'preview_gate',
    operator_decision: null,
  });
  audit('pipeline.preview.delivered', 'pipeline', {
    runId: r.id,
    tasks: result.dag.nodes.length,
    blocking: hasBlockingConflicts(result),
  });
  void notify.pipelineAwaitingGate(r.id, r.task_id, 'preview', previewRecommendation(result));
  return r;
}

/** Re-run planning with the operator's revise note, re-present at the gate. */
async function stageReplanning(run: PipelineRun, deps: ResolvedDeps): Promise<PipelineRun> {
  const result = await deps.plan(run); // realPlan reads the revise note off operator_decision
  const briefPath = writeBrief(run.id, run.prompt, result);
  const r = transition(run, 'awaiting_preview', {
    plan_json: freezePlan(result),
    bz_brief_path: briefPath,
    current_stage: 'preview_gate',
    operator_decision: null, // consume the revise note
  });
  audit('pipeline.preview.delivered', 'pipeline', { runId: r.id, revised: true, tasks: result.dag.nodes.length });
  void notify.pipelineAwaitingGate(r.id, r.task_id, 'preview', `revised — ${previewRecommendation(result)}`);
  return r;
}

function handlePreviewDecision(run: PipelineRun): PipelineRun {
  const d = run.operator_decision!;
  void notify.pipelineResumed(run.id, run.task_id, 'preview', d.kind);
  if (d.kind === 'abort') {
    audit('pipeline.aborted', 'pipeline', { runId: run.id, at: 'preview' });
    cleanupRunArtifacts(run);
    return transition(run, 'aborted', { operator_decision: null });
  }
  if (d.kind === 'revise') {
    audit('pipeline.preview.revised', 'pipeline', { runId: run.id, note: (d.note ?? '').slice(0, 200) });
    // KEEP operator_decision so stageReplanning can read the note; it clears it.
    return transition(run, 'replanning', { current_stage: 'replanning' });
  }
  // go — the plan was frozen at planning time; begin execution.
  audit('pipeline.preview.approved', 'pipeline', { runId: run.id });
  return transition(run, 'executing', { operator_decision: null, current_stage: 'executing' });
}

/** Held-task count from the last (phase-scoped) redux. */
function heldCount(run: PipelineRun): number {
  if (!run.redux_findings) return 0;
  try {
    const f = JSON.parse(run.redux_findings) as { held?: unknown };
    return Array.isArray(f.held) ? f.held.length : 0;
  } catch {
    return 0;
  }
}
function findingsCatastrophic(run: PipelineRun): boolean {
  if (!run.redux_findings) return false;
  try {
    return (JSON.parse(run.redux_findings) as { catastrophic?: unknown }).catastrophic === true;
  } catch {
    return false;
  }
}

/**
 * Executing (⑤⑥), ONE PHASE PER TICK. Runs the current phase's coders (off the
 * live integration branch, which already carries earlier phases' merged code),
 * reconciles via redux, and runs the per-phase diagnostic recovery loop (R1/R2)
 * until the phase merges clean or the cap is hit. Then:
 *   - clean + more phases → advance current_phase, YIELD (status unchanged → the
 *     advance loop releases the tick; the next tick runs the next phase).
 *   - clean + last phase → shipping (final smoke).
 *   - still held after R1/R2, or catastrophic → review gate.
 */
async function stageExecuting(run: PipelineRun, deps: ResolvedDeps): Promise<PipelineRun> {
  const plan = parsePlanJson(run.plan_json);
  const phases = plan ? groupPhases(plan.plans) : [];
  const k = run.current_phase;
  if (k === 0) audit('pipeline.executing.started', 'pipeline', { runId: run.id, phases: phases.length });
  if (phases.length === 0 || k >= phases.length) {
    return transition(run, 'shipping', { current_stage: 'shipping' });
  }
  audit('pipeline.stage.advanced', 'pipeline', { runId: run.id, stage: `phase.${k}.started`, tasks: phases[k]!.length });

  // Clear a consumed corrective-wave directive (only applies to the first phase
  // of a fix re-run).
  if (run.fix_directive && k === 0) updateRun(run.id, { fix_directive: null }, now());

  await deps.execute(run); // phase-k coders
  let cur = getRun(run.id) ?? run;
  await deps.redux(cur); // merge phase-k clean
  cur = getRun(run.id) ?? cur;

  // Per-phase recovery: diagnose held → re-redux, up to the autonomous cap.
  let round = cur.diagnostic_round;
  while (heldCount(cur) > 0 && !findingsCatastrophic(cur) && round < MAX_AUTONOMOUS_DIAGNOSTIC_ROUNDS) {
    round++;
    audit('pipeline.diagnostic.started', 'pipeline', { runId: cur.id, phase: k, round, held: heldCount(cur) });
    await deps.diagnose(cur, round);
    updateRun(cur.id, { diagnostic_round: round }, now());
    cur = getRun(run.id) ?? cur;
    await deps.redux(cur);
    cur = getRun(run.id) ?? cur;
    audit('pipeline.diagnostic.finished', 'pipeline', { runId: cur.id, phase: k, round, held: heldCount(cur) });
  }

  audit('pipeline.stage.advanced', 'pipeline', { runId: cur.id, stage: `phase.${k}.done`, held: heldCount(cur) });

  if (heldCount(cur) === 0) {
    if (k + 1 < phases.length) {
      // Advance + YIELD: stay `executing`, reset the per-phase round counter.
      return updateRun(cur.id, { current_phase: k + 1, diagnostic_round: 0 }, now())!;
    }
    return transition(cur, 'shipping', { current_stage: 'shipping' });
  }
  return escalateToReview(cur, findingsCatastrophic(cur) ? 'catastrophic' : 'unresolved');
}

/** Park at the review gate with a brief + Slack ping. */
function escalateToReview(run: PipelineRun, reason: 'catastrophic' | 'unresolved'): PipelineRun {
  const briefPath = writeBriefFile(run.id, buildReviewBrief(run, reason, null));
  const r = transition(run, 'awaiting_review', {
    bz_brief_path: briefPath,
    operator_decision: null,
    current_stage: 'review_gate',
  });
  audit('pipeline.review.delivered', 'pipeline', { runId: r.id, reason });
  void notify.pipelineAwaitingGate(r.id, r.task_id, 'review', reviewRecommendation(run, reason, null));
  return r;
}

/**
 * Shipping (⑦⑧): drive held tasks to green via R1/R2 diagnostics + an
 * independent smoke supervisor, or escalate to the review gate (unresolved or
 * the redux catastrophic short-circuit). Green → done (delivery PR is step 6).
 */
async function stageShipping(run: PipelineRun, deps: ResolvedDeps): Promise<PipelineRun> {
  // Debug run (DEBUG-GATE): skip the real smoke spawn and finish cleanly so the
  // gate is safe to approve.
  if (run.prompt.startsWith('DEBUG-GATE')) {
    audit('pipeline.smoke.completed', 'pipeline.shipping', { runId: run.id, round: 'debug', passed: true });
    return deliverAndFinish(run, deps, 'debug');
  }
  const outcome = await deps.ship(run);
  if (outcome.kind === 'green') {
    // Strict review (Settings -> pipeline.reviewStrictness) pauses even a fully
    // green run for explicit operator approval. normal/lenient auto-deliver.
    if (config.settings.pipeline.reviewStrictness !== 'strict') {
      return deliverAndFinish(run, deps);
    }
    const greenBrief = writeBriefFile(
      run.id,
      'All tasks are green. Review strictness is "strict", so delivery awaits your explicit approval.',
    );
    const gr = transition(run, 'awaiting_review', {
      bz_brief_path: greenBrief,
      operator_decision: null,
      current_stage: 'review_gate',
    });
    audit('pipeline.review.delivered', 'pipeline', { runId: gr.id, reason: 'strict-review-of-green' });
    void notify.pipelineAwaitingGate(gr.id, gr.task_id, 'review', 'Green — awaiting approval (strict mode)');
    return gr;
  }
  const briefPath = writeBriefFile(run.id, outcome.brief);
  const r = transition(run, 'awaiting_review', {
    bz_brief_path: briefPath,
    operator_decision: null,
    current_stage: 'review_gate',
  });
  audit('pipeline.review.delivered', 'pipeline', { runId: r.id, reason: outcome.reason });
  void notify.pipelineAwaitingGate(r.id, r.task_id, 'review', outcome.headline);
  return r;
}

/** Delivery (⑨) + terminal done. Emits the `pipeline.delivered` marker. */
async function deliverAndFinish(run: PipelineRun, deps: ResolvedDeps, via?: string): Promise<PipelineRun> {
  const result = await deps.deliver(run);
  const done = transition(run, 'done', { operator_decision: null, current_stage: 'done' });
  audit('pipeline.delivered', 'pipeline', {
    runId: done.id,
    pr_url: result.pr_url ?? null,
    deploy_targets: result.deploy_targets,
    ...(via ? { via } : {}),
  });
  void notify.pipelineDelivered(done.id, done.task_id, result.pr_url, result.deploy_targets);
  return done;
}

async function handleReviewDecision(run: PipelineRun, deps: ResolvedDeps): Promise<PipelineRun> {
  const d = run.operator_decision!;
  void notify.pipelineResumed(run.id, run.task_id, 'review', d.kind);
  if (d.kind === 'abort') {
    audit('pipeline.aborted', 'pipeline', { runId: run.id, at: 'review' });
    cleanupRunArtifacts(run);
    return transition(run, 'aborted', { operator_decision: null });
  }
  if (d.kind === 'fix') {
    // Corrective wave — fresh autonomous attempt. Thread the operator's directive
    // into the coders (consumed + cleared after the executing stage); reset the
    // diagnostic counter so R1/R2 budget is fresh.
    audit('pipeline.review.fix', 'pipeline', { runId: run.id, note: (d.note ?? '').slice(0, 200) });
    return transition(run, 'executing', {
      operator_decision: null,
      current_stage: 'executing',
      diagnostic_round: 0,
      current_phase: 0,
      fix_directive: d.note ?? null,
    });
  }
  if (d.kind === 'rollback') {
    audit('pipeline.review.rollback', 'pipeline', { runId: run.id });
    return transition(run, 'planning', { operator_decision: null, current_stage: 'planning', plan_json: null, diagnostic_round: 0, current_phase: 0, fix_directive: null });
  }
  // proceed — accept + ship what integrated → deliver → done.
  audit('pipeline.review.proceed', 'pipeline', { runId: run.id });
  return deliverAndFinish(run, deps, 'review-proceed');
}


// ─── Advance loop ─────────────────────────────────────────────────────────────

interface ResolvedDeps {
  plan: (run: PipelineRun) => Promise<PlanningResult>;
  execute: (run: PipelineRun) => Promise<ExecuteResult>;
  redux: (run: PipelineRun) => Promise<ReduxResult>;
  diagnose: (run: PipelineRun, round: number) => Promise<void>;
  ship: (run: PipelineRun) => Promise<ShipOutcome>;
  deliver: (run: PipelineRun) => Promise<DeliveryResult>;
}

async function runSegment(run: PipelineRun, deps: ResolvedDeps): Promise<PipelineRun> {
  switch (run.status) {
    case 'planning':
      return stagePlanning(run, deps);
    case 'replanning':
      return stageReplanning(run, deps);
    case 'awaiting_preview':
      return handlePreviewDecision(run);
    case 'executing':
      return stageExecuting(run, deps);
    case 'shipping':
      return stageShipping(run, deps);
    case 'awaiting_review':
      return handleReviewDecision(run, deps);
    default:
      return run;
  }
}

/**
 * Advance a run as far as it will go this tick: run segments until a terminal
 * status or a gate with no decision (human pause). Returns the final run state.
 */
export async function advancePipeline(run: PipelineRun, deps: AdvanceDeps = {}): Promise<PipelineRun> {
  const resolved: ResolvedDeps = {
    plan: deps.plan ?? realPlan,
    execute: deps.execute ?? ((r) => runExecuting(r)),
    redux: deps.redux ?? ((r) => runRedux(r)),
    diagnose: deps.diagnose ?? ((r, round) => runDiagnosticRound(r, round)),
    ship: deps.ship ?? ((r) => runShipping(r)),
    deliver: deps.deliver ?? ((r) => runDelivery(r)),
  };
  let current = run;
  for (let guard = 0; guard < MAX_SEGMENTS_PER_ADVANCE; guard++) {
    if (isTerminal(current.status)) break;
    if (isAwaiting(current.status) && !current.operator_decision) break;
    const before = current.status;
    current = await runSegment(current, resolved);
    // Autonomous yield: a segment that returns its own status unchanged (the
    // phase boundary — executing advanced current_phase but stays executing)
    // releases the tick; a later tick resumes the next phase.
    if (current.status === before) break;
  }
  return current;
}

/**
 * Tick priority 1: advance every run parked at a gate whose decision arrived.
 * Returns the runs after advancement so the caller can reconcile the queue.
 */
export async function resumeDecidedRuns(deps: AdvanceDeps = {}): Promise<PipelineRun[]> {
  const out: PipelineRun[] = [];
  for (const run of runsAwaitingDecision()) {
    out.push(await advancePipeline(run, deps));
  }
  return out;
}

export { getRunByTaskId };
