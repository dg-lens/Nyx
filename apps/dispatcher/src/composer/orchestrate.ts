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
 * Called from `dispatchOne` in `cli/run-once.ts` for `type: code` tasks only.
 */

import { audit } from '../audit.js';
import type { ParsedTask } from '../types.js';
import { gatherAncestorContext } from './chain-context.js';
import { runComposer } from './composer-runner.js';
import { saveFlightPlan } from './db.js';
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

  // ── Phase 2: composer call ──
  try {
    const ancestors = gatherAncestorContext(task, workingDir);
    await runComposer({ task, plan, ancestors });
  } catch (err) {
    // Composer failure is non-blocking — we already have the plan for phase 3.
    audit('composer.skipped', 'composer.orchestrate', {
      taskId: task.id,
      stage: 'composer_run',
      reason: `runComposer threw: ${(err as Error).message}`,
    });
    return { flightPlan: plan, status: 'composer_threw' };
  }

  return { flightPlan: plan, status: 'ok' };
}
