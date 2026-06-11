/**
 * Composer layer entry point — orchestrates phase 1 (plan) and phase 2
 * (composer call), returning the validated flight plan (or null) for the
 * dispatcher to inject into phase 3 (execution).
 *
 * Stage-0 (observation-only) contract: this function NEVER throws and NEVER
 * blocks task execution. If anything fails, it audit-logs and returns null,
 * and the dispatcher proceeds with the existing execution flow as if the
 * composer layer didn't exist.
 *
 * NOTE ON CALLERS: `runComposerLayer` is currently UNCALLED. The stage-0
 * composer layer (plan-only + composer-check spawn before execution) was
 * removed from the code-task dispatch path — code tasks now run a single
 * execution spawn (see the comment in `cli/run-once.ts` `dispatchOne`). It is
 * retained here for the pipeline's composer-redux stage and as the reference
 * orchestration of all three phases. The phase-3 shadow normalizer, however,
 * IS wired into the live code-task dispatch path directly via
 * `maybeRunShadowNormalize` below — it does NOT depend on `runComposerLayer`.
 */

import { audit } from '../audit.js';
import { config } from '../config.js';
import { safeRecordOutcome } from '../outcomes.js';
import type { ParsedTask } from '../types.js';
import { gatherAncestorContext, type AncestorContext } from './chain-context.js';
import { runComposer } from './composer-runner.js';
import { saveFlightPlan, saveNormalization } from './db.js';
import {
  failureClassForOutcome,
  normalizeTaskSpec,
  type NormalizerSpawnFn,
} from './normalizer.js';
import { removeFlightPlanArtifact, runPlanSpawn } from './plan-spawner.js';
import type { FlightPlan, NormalizationResult } from './types.js';

export interface ComposerLayerResult {
  /** The plan to inject into the execution phase. null if planning failed. */
  flightPlan: FlightPlan | null;
  /** Brief status for the dispatcher's audit trail. */
  status:
    | 'ok'
    | 'plan_missing'
    | 'plan_invalid'
    | 'plan_spawn_failed'
    | 'plan_save_failed'
    | 'composer_threw';
}

/**
 * Run the composer layer for a code task. Always returns — never throws. The
 * dispatcher's downstream flow is unaffected by composer failures.
 */
export async function runComposerLayer(
  task: ParsedTask,
  workingDir: string,
): Promise<ComposerLayerResult> {
  // ── Phase 1: plan-only spawn ──
  let planResult;
  try {
    planResult = await runPlanSpawn(task, workingDir);
  } catch (err) {
    audit('composer.skipped', 'composer.orchestrate', {
      taskId: task.id,
      stage: 'plan_spawn',
      reason: `threw: ${(err as Error).message}`,
    });
    removeFlightPlanArtifact(workingDir);
    return { flightPlan: null, status: 'composer_threw' };
  }

  if (planResult.status !== 'ok' || !planResult.plan) {
    const event =
      planResult.status === 'missing'
        ? 'task.flight_plan.missing'
        : planResult.status === 'invalid_json'
          ? 'task.flight_plan.invalid_json'
          : 'task.flight_plan.spawn_failed';
    audit(event, 'composer.orchestrate', {
      taskId: task.id,
      duration_ms: planResult.durationMs,
      exit_code: planResult.exitCode,
      parse_error: planResult.parseError ?? null,
      raw_content_excerpt: planResult.rawContent?.slice(0, 500) ?? null,
      stderr_excerpt: planResult.stderr.slice(-500),
    });
    removeFlightPlanArtifact(workingDir);
    const statusMap: Record<string, ComposerLayerResult['status']> = {
      missing: 'plan_missing',
      invalid_json: 'plan_invalid',
      spawn_failed: 'plan_spawn_failed',
    };
    return { flightPlan: null, status: statusMap[planResult.status] ?? 'plan_spawn_failed' };
  }

  // Persist the plan + audit-log submission, then clean the artifact from the
  // working dir so phase 3 sees a clean tree.
  const plan = planResult.plan;
  try {
    saveFlightPlan(plan);
  } catch (err) {
    // The plan was NOT persisted, so a later ancestor lookup via
    // getLatestFlightPlan(task.id) will not find it. We still proceed with the
    // in-memory plan for THIS run's execution, but flag the divergence
    // explicitly (distinct status + audit note) so the chain's recorded state
    // vs. the executing state is explainable — never silently conflated with a
    // phase-2 composer-call failure ('composer_threw'), which DID persist.
    audit('composer.skipped', 'composer.orchestrate', {
      taskId: task.id,
      stage: 'save_plan',
      reason: `saveFlightPlan threw: ${(err as Error).message}`,
      using_unpersisted_plan: true,
    });
    removeFlightPlanArtifact(workingDir);
    return { flightPlan: plan, status: 'plan_save_failed' };
  }
  audit('task.flight_plan.submitted', 'composer.orchestrate', {
    taskId: task.id,
    duration_ms: planResult.durationMs,
    file_count_create: plan.files.create.length,
    file_count_modify: plan.files.modify.length,
    file_count_delete: plan.files.delete.length,
    export_count: plan.exports.length,
    import_count: plan.imports_from_chain.length,
    doc_update_count: plan.doc_updates.length,
    estimated_risk: plan.estimated_risk,
  });
  removeFlightPlanArtifact(workingDir);

  // Gathered once; reused by phase 2 (composer) and phase 3 (normalizer).
  let ancestors: AncestorContext[] = [];
  try {
    ancestors = gatherAncestorContext(task, workingDir);
  } catch {
    ancestors = [];
  }

  // ── Phase 2: composer call ──
  let composerThrew = false;
  try {
    await runComposer({ task, plan, ancestors });
  } catch (err) {
    // Composer failure is non-blocking — we already have the plan for phase 3.
    audit('composer.skipped', 'composer.orchestrate', {
      taskId: task.id,
      stage: 'composer_run',
      reason: `runComposer threw: ${(err as Error).message}`,
    });
    composerThrew = true;
  }

  // ── Phase 3: pre-dispatch normalizer (SHADOW ONLY) ──
  // Extracted into a void-returning helper so it is STRUCTURALLY impossible for
  // it to influence this function's return value or status. See its doc comment.
  await runShadowNormalizePhase(task, workingDir, ancestors);

  // Return value is UNCHANGED by phase 3 — exactly as the stage-0 contract
  // before the normalizer existed: { flightPlan: plan, status }.
  return { flightPlan: plan, status: composerThrew ? 'composer_threw' : 'ok' };
}

/**
 * Phase 3 — the SHADOW normalizer side effect. Returns `void`: it computes,
 * persists, and audit-logs the normalization, and that is ALL it does. It MUST
 * NOT halt/reject/re-park anything, MUST NOT alter the spec the executor sees,
 * and — being void — CANNOT change `runComposerLayer`'s return value or status.
 * Enforcement (acting on `would_reject` / `enforced`) is a SEPARATE future PR.
 *
 * Guarded end-to-end: disabled by config → no-op; spawn null → audit skipped;
 * any throw → audit skipped. Never propagates.
 *
 * `spawnFn` is a test seam (default = the real LLM spawn) so the invariance test
 * can drive this deterministically without spawning `claude`.
 */
export async function runShadowNormalizePhase(
  task: ParsedTask,
  workingDir: string,
  ancestors: AncestorContext[],
  spawnFn?: NormalizerSpawnFn,
): Promise<void> {
  if (!config.composer.normalizer.enabled) return;
  // The shadow recording (persist + audit + outcome) lives in `recordNormalization`
  // so BOTH the shadow path (here) and the enforcement path consume IDENTICAL
  // recording — enforcement never skips the shadow record. Discard the result so
  // this function stays `void`: it can structurally influence nothing.
  await recordNormalization(task, workingDir, ancestors, spawnFn);
}

/**
 * Run the normalizer + perform ALL the shadow side effects (persist the
 * normalization, emit `composer.normalize.completed`/`.skipped`, record the
 * outcome row) and RETURN the assembled `NormalizationResult` — or `null` when
 * the normalizer failed/skipped or an internal error occurred.
 *
 * This is the single source of the shadow recording. The void shadow path
 * discards the return; the enforcement path reads it to decide inject/reject.
 * Enforcement NEVER bypasses this recording — "remove the shadow recording" is
 * an explicit non-goal. Never throws (it owns the same try/catch the shadow path
 * had); a throw inside recording is logged and yields `null`.
 *
 * `enabled` is checked by the callers, not here — both call this only when the
 * normalizer is enabled.
 */
async function recordNormalization(
  task: ParsedTask,
  workingDir: string,
  ancestors: AncestorContext[],
  spawnFn?: NormalizerSpawnFn,
): Promise<NormalizationResult | null> {
  const stageStart = Date.now();
  try {
    const outcome = await normalizeTaskSpec(task, workingDir, ancestors, spawnFn);
    if (outcome.ok) {
      const norm = outcome.result;
      saveNormalization(norm);
      audit('composer.normalize.completed', 'composer.orchestrate', {
        taskId: task.id,
        normalization_id: norm.normalization_id,
        solvable: norm.spec.verdict.solvable,
        complete: norm.spec.verdict.complete,
        redundant_count: norm.spec.verdict.redundant_with.length,
        blocking_count: norm.spec.verdict.blocking_issues.length,
        would_reject: norm.would_reject,
        enforced: norm.enforced,
        predicted_conflict_count: norm.dag?.predicted_conflicts.length ?? 0,
        dag_cycle: norm.dag?.cycle != null,
      });
      safeRecordOutcome({
        task_id: task.id,
        stage: 'composer.normalize',
        outcome: 'ok',
        detail: norm.would_reject ? `would_reject: ${norm.reject_reason ?? ''}` : null,
        payload: {
          normalization_id: norm.normalization_id,
          would_reject: norm.would_reject,
          solvable: norm.spec.verdict.solvable,
          complete: norm.spec.verdict.complete,
        },
        duration_ms: norm.duration_ms,
      });
      return norm;
    }
    const failure_class = failureClassForOutcome(outcome.failure_class);
    audit('composer.normalize.skipped', 'composer.orchestrate', {
      taskId: task.id,
      failure_class,
      reason: outcome.detail ?? failure_class,
    });
    safeRecordOutcome({
      task_id: task.id,
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class,
      detail: outcome.detail ?? null,
      duration_ms: Date.now() - stageStart,
    });
    return null;
  } catch (err) {
    // normalizeTaskSpec already catches its own throws, so reaching here means
    // saveNormalization/audit threw. Record + propagate-into-audit only.
    audit('composer.normalize.skipped', 'composer.orchestrate', {
      taskId: task.id,
      failure_class: 'internal_error',
      reason: `normalize threw: ${(err as Error).message}`,
    });
    // safeRecordOutcome never throws — the shadow stage cannot propagate a
    // monitoring-write failure into dispatch.
    safeRecordOutcome({
      task_id: task.id,
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class: 'internal_error',
      detail: (err as Error).message,
      duration_ms: Date.now() - stageStart,
    });
    return null;
  }
}

/**
 * Format the "## NORMALIZED SPEC (composer-compiled)" block injected ahead of
 * the raw task body when enforcement is ON and the spec normalized cleanly.
 * Carries the tightened body + acceptance criteria + anti-examples — the three
 * fields a coder needs to execute the compiled spec. Pure / deterministic so the
 * enforcement test can assert on its exact contents.
 */
export function formatNormalizedSpecBlock(norm: NormalizationResult): string {
  const s = norm.spec;
  const lines: string[] = [];
  lines.push('## NORMALIZED SPEC (composer-compiled)');
  lines.push('');
  lines.push(
    'The composer normalizer compiled the task spec below into a tightened, ' +
      'executable form BEFORE you were spawned. Execute THIS — it is the ' +
      'authoritative instruction set. The raw task body that follows is context.',
  );
  lines.push('');
  lines.push('### Tightened body');
  lines.push(s.tightened_body || '(none provided)');
  lines.push('');
  lines.push('### Acceptance criteria');
  if (s.acceptance_criteria.length > 0) {
    for (const c of s.acceptance_criteria) lines.push(`- ${c}`);
  } else {
    lines.push('- (none provided)');
  }
  lines.push('');
  lines.push('### Anti-examples (do NOT do these)');
  if (s.anti_examples.length > 0) {
    for (const a of s.anti_examples) lines.push(`- ${a}`);
  } else {
    lines.push('- (none provided)');
  }
  return lines.join('\n');
}

/**
 * The pre-dispatch decision the normalizer hands back to `attemptTask`.
 *
 * RED LINE — PRE-DISPATCH ONLY: every action here is decided and applied BEFORE
 * the coder spawns. There is NO post-execution / findings variant; the composer
 * never gates on what the coder produced. Enforcement is read-only-on-the-spec.
 *
 *   - `proceed`  — spawn the coder with an UNMODIFIED prompt. The state for
 *                  shadow mode (enforced=false), normalizer-disabled (unreachable
 *                  here — the caller short-circuits), and normalizer null
 *                  (failed/skipped: NEVER block on the normalizer's own failure).
 *   - `inject`   — enforced=true + clean verdict: spawn the coder with
 *                  `normalizedSpecBlock` prepended ahead of the raw task body.
 *   - `reject`   — enforced=true + would_reject=true: do NOT spawn the coder;
 *                  the caller halts the task pre-dispatch.
 */
export type ShadowNormalizeResult =
  | { action: 'proceed' }
  | { action: 'inject'; normalizedSpecBlock: string }
  | { action: 'reject'; blockingIssues: string[]; rejectReason: string | null };

/**
 * Dispatch-path entry point for the pre-dispatch normalizer. This is the function
 * the live code-task dispatch path (`attemptTask` in `cli/run-once.ts`) calls,
 * BEFORE the main execution spawn — the normalizer is a PRE-dispatch step.
 *
 * Behaviorally inert by default and fully additive:
 *   - When `config.composer.normalizer.enabled` is false (the SHIPPED default),
 *     this returns `{ action: 'proceed' }` having done NOTHING — no ancestor
 *     gathering, no spawn, no audit. The dispatch path is identical to a build
 *     without it.
 *   - When enabled, it gathers ancestor context, runs the normalizer (one extra
 *     sonnet planning spawn per code task — the documented cost), performs the
 *     SHADOW recording (persist + audit + outcome — preserved in BOTH modes),
 *     and then decides the pre-dispatch action:
 *       · `enforced=false` (SHADOW): always `{ action: 'proceed' }`. The shadow
 *         record is written but the spec the coder sees is byte-identical to a
 *         build without enforcement — this is the byte-identical-to-shadow
 *         guarantee.
 *       · `enforced=true` + normalizer null (failed/skipped): `proceed`. We
 *         NEVER block on the normalizer's OWN failure.
 *       · `enforced=true` + clean verdict (would_reject=false): `inject` with the
 *         compiled spec block.
 *       · `enforced=true` + would_reject=true: `reject` — the caller halts
 *         pre-dispatch; the coder never spawns.
 *
 * Double-guarded: `recordNormalization` is internally try/catch'd, and this
 * wrapper wraps the whole thing again so a throw from ancestor-gathering or
 * anywhere else can NEVER reach the caller — a throw degrades to `proceed`
 * (fail-open: a wiring fault must never block dispatch).
 *
 * `deps` is a test seam (defaults = the real implementations) so the wiring
 * contract can be driven deterministically without spawning `claude` or
 * importing the dispatch loop.
 */
export async function maybeRunShadowNormalize(
  task: ParsedTask,
  workingDir: string,
  deps: {
    gatherAncestors?: (task: ParsedTask, workingDir: string) => AncestorContext[];
    record?: (
      task: ParsedTask,
      workingDir: string,
      ancestors: AncestorContext[],
    ) => Promise<NormalizationResult | null>;
  } = {},
): Promise<ShadowNormalizeResult> {
  if (!config.composer.normalizer.enabled) return { action: 'proceed' };
  const gatherAncestors = deps.gatherAncestors ?? gatherAncestorContext;
  const record = deps.record ?? recordNormalization;
  try {
    let ancestors: AncestorContext[] = [];
    try {
      ancestors = gatherAncestors(task, workingDir);
    } catch {
      ancestors = [];
    }
    const norm = await record(task, workingDir, ancestors);

    // ENFORCEMENT gate — PRE-DISPATCH ONLY. When enforcement is off, the shadow
    // record above is the ONLY effect: the coder's prompt is unchanged (byte-
    // identical-to-shadow). The reject/inject branches below are reachable ONLY
    // when enforced=true.
    if (!config.composer.normalizer.enforced) return { action: 'proceed' };
    // NEVER block on the normalizer's own failure: a null result (spawn failed,
    // artifact malformed, internal error) proceeds exactly as shadow does.
    if (!norm) return { action: 'proceed' };
    if (norm.would_reject) {
      return {
        action: 'reject',
        blockingIssues: norm.spec.verdict.blocking_issues,
        rejectReason: norm.reject_reason,
      };
    }
    return { action: 'inject', normalizedSpecBlock: formatNormalizedSpecBlock(norm) };
  } catch (err) {
    audit('composer.normalize.skipped', 'composer.orchestrate', {
      taskId: task.id,
      reason: `shadow-normalize wiring threw: ${(err as Error).message}`,
    });
    // Fail-open: a wiring fault degrades to the unmodified dispatch path.
    return { action: 'proceed' };
  }
}
