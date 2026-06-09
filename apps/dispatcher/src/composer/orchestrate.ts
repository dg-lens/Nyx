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
import type { ParsedTask } from '../types.js';
import { gatherAncestorContext, type AncestorContext } from './chain-context.js';
import { runComposer } from './composer-runner.js';
import { saveFlightPlan, saveNormalization } from './db.js';
import { normalizeTaskSpec, type NormalizerSpawnFn } from './normalizer.js';
import { removeFlightPlanArtifact, runPlanSpawn } from './plan-spawner.js';
import type { FlightPlan } from './types.js';

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
  try {
    const norm = await normalizeTaskSpec(task, workingDir, ancestors, spawnFn);
    if (norm) {
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
    } else {
      audit('composer.normalize.skipped', 'composer.orchestrate', {
        taskId: task.id,
        reason: 'normalizer returned null (spawn produced no usable spec)',
      });
    }
  } catch (err) {
    audit('composer.normalize.skipped', 'composer.orchestrate', {
      taskId: task.id,
      reason: `normalize threw: ${(err as Error).message}`,
    });
  }
}

/**
 * Dispatch-path entry point for the shadow normalizer. This is the function the
 * live code-task dispatch path (`attemptTask` in `cli/run-once.ts`) calls,
 * BEFORE the main execution spawn — the normalizer is a PRE-dispatch step.
 *
 * Behaviorally inert by default and fully additive:
 *   - When `config.composer.normalizer.enabled` is false (the SHIPPED default),
 *     this returns immediately having done NOTHING — no ancestor gathering, no
 *     spawn, no audit. The dispatch path is identical to a build without it.
 *   - When enabled, it gathers ancestor context and runs the shadow normalizer
 *     (one extra sonnet planning spawn per code task — the documented cost).
 *
 * It returns `void` and is double-guarded: `runShadowNormalizePhase` is itself
 * void + internally try/catch'd, and this wrapper wraps the whole thing again so
 * a throw from ancestor-gathering or anywhere else can NEVER reach the caller.
 * It MUST NOT influence control flow, the gate decision, or the task outcome.
 *
 * `deps` is a test seam (defaults = the real implementations) so the wiring
 * contract — off→not-invoked, on→a-throw-is-swallowed — can be driven
 * deterministically without spawning `claude` or importing the dispatch loop.
 */
export async function maybeRunShadowNormalize(
  task: ParsedTask,
  workingDir: string,
  deps: {
    gatherAncestors?: (task: ParsedTask, workingDir: string) => AncestorContext[];
    runShadow?: (
      task: ParsedTask,
      workingDir: string,
      ancestors: AncestorContext[],
    ) => Promise<void>;
  } = {},
): Promise<void> {
  if (!config.composer.normalizer.enabled) return;
  const gatherAncestors = deps.gatherAncestors ?? gatherAncestorContext;
  const runShadow = deps.runShadow ?? runShadowNormalizePhase;
  try {
    let ancestors: AncestorContext[] = [];
    try {
      ancestors = gatherAncestors(task, workingDir);
    } catch {
      ancestors = [];
    }
    await runShadow(task, workingDir, ancestors);
  } catch (err) {
    audit('composer.normalize.skipped', 'composer.orchestrate', {
      taskId: task.id,
      reason: `shadow-normalize wiring threw: ${(err as Error).message}`,
    });
  }
}
