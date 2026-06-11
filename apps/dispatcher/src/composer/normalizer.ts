/**
 * Pre-dispatch normalizer (shadow stage) — assembler.
 *
 * `normalizeTaskSpec` runs the LLM normalizer spawn + the deterministic DAG
 * compiler, assembles a `NormalizationResult`, and derives the shadow-only
 * `would_reject` signal. It NEVER throws (catch → null) and NEVER acts on the
 * `enforced` flag.
 *
 * SHADOW-CUT INVARIANT: `enforced` is READ from config and recorded for operator
 * visibility, but is NOT acted on here. Enforcement (halt / reject / spec
 * injection) is a SEPARATE future PR. This function computes + returns a result;
 * it changes no control flow.
 */

import { randomUUID } from 'node:crypto';

import { config } from '../config.js';
import type { FailureClass } from '../outcomes.js';
import type { ParsedTask } from '../types.js';
import type { AncestorContext } from './chain-context.js';
import { buildChainDag } from './dag.js';
import {
  runNormalizerSpawn,
  type NormalizerSpawnFailureClass,
  type NormalizerSpawnOutcome,
} from './normalizer-spawner.js';
import type { ChainDag, NormalizationResult } from './types.js';

const NORMALIZE_MODEL = 'sonnet';

/** The LLM spawn seam — overridable in tests to avoid spawning `claude`. */
export type NormalizerSpawnFn = (
  task: ParsedTask,
  workingDir: string,
) => Promise<NormalizerSpawnOutcome>;

/**
 * What `normalizeTaskSpec` returns. The stage-success path carries the
 * assembled `NormalizationResult`; the stage-skip path carries the structured
 * `failure_class` so the caller can record it in the outcomes table without
 * regex-ing prose. Mirrors the spawner-level taxonomy 1:1, plus
 * `internal_error` for an unexpected throw inside this function itself.
 */
export type NormalizeStageFailureClass =
  | NormalizerSpawnFailureClass
  | 'internal_error';

export type NormalizeStageOutcome =
  | { ok: true; result: NormalizationResult }
  | { ok: false; failure_class: NormalizeStageFailureClass; detail?: string };

/**
 * Project a `NormalizeStageFailureClass` onto the global outcomes-taxonomy
 * `FailureClass`. Today every member is identical in name, but the projection
 * exists so a future stage-local class (e.g. a normalizer-specific verdict
 * disagreement) can be mapped onto a global class deliberately.
 */
export function failureClassForOutcome(c: NormalizeStageFailureClass): FailureClass {
  return c;
}

/**
 * Derive the operator-review `would_reject` signal from the verdict + DAG.
 * SHADOW: this boolean is recorded only — it does NOT reject or halt anything.
 *
 * A spec would be rejected by a future enforcer when ANY of:
 *  - it is not solvable as written (`verdict.solvable === 'no'`),
 *  - it is missing required constraints (`verdict.complete === 'no'`),
 *  - it carries explicit blocking issues, or
 *  - its dependency DAG has a cycle (the chain can't be ordered).
 */
export function deriveWouldReject(
  result: Pick<NormalizationResult, 'spec' | 'dag'>,
): { wouldReject: boolean; reason: string | null } {
  const { verdict } = result.spec;
  const reasons: string[] = [];
  if (verdict.solvable === 'no') reasons.push('not solvable as specified');
  if (verdict.complete === 'no') reasons.push('spec is incomplete (missing constraints)');
  if (verdict.blocking_issues.length > 0) {
    reasons.push(`${verdict.blocking_issues.length} blocking issue(s): ${verdict.blocking_issues.join('; ')}`);
  }
  if (result.dag?.cycle != null) {
    reasons.push(`dependency cycle: ${result.dag.cycle.join(' → ')}`);
  }
  if (reasons.length === 0) return { wouldReject: false, reason: null };
  return { wouldReject: true, reason: reasons.join('; ') };
}

/**
 * Normalize a single task spec. Returns a discriminated outcome — `ok: true`
 * with the assembled result, or `ok: false` with the structured failure_class
 * (one of the five spawn causes, or `internal_error` for an unexpected throw).
 * Never throws.
 */
export async function normalizeTaskSpec(
  task: ParsedTask,
  workingDir: string,
  ancestors: AncestorContext[],
  spawnFn: NormalizerSpawnFn = runNormalizerSpawn,
): Promise<NormalizeStageOutcome> {
  const start = Date.now();
  try {
    const spawn = await spawnFn(task, workingDir);
    if (!spawn.ok) {
      return spawn.detail !== undefined
        ? { ok: false, failure_class: spawn.failure_class, detail: spawn.detail }
        : { ok: false, failure_class: spawn.failure_class };
    }

    // Deterministic DAG compile — null when the task has no [depends:].
    let dag: ChainDag | null = null;
    try {
      dag = buildChainDag(
        task,
        ancestors.map((a) => ({ task_id: a.task_id, plan: a.plan })),
        workingDir,
      );
    } catch {
      dag = null;
    }

    const { wouldReject, reason } = deriveWouldReject({ spec: spawn.result.spec, dag });

    // SHADOW: read `enforced` for the record, but DO NOT act on it. Enforcement
    // is a future PR — no halt/reject/spec-injection happens regardless of value.
    const enforced = config.composer.normalizer.enforced;

    return {
      ok: true,
      result: {
        normalization_id: `normalize-${task.id}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        task_id: task.id,
        spec: spawn.result.spec,
        dag,
        enforced,
        would_reject: wouldReject,
        reject_reason: reason,
        duration_ms: Date.now() - start,
        model: NORMALIZE_MODEL,
        raw_response: spawn.result.rawResponse,
      },
    };
  } catch (err) {
    return { ok: false, failure_class: 'internal_error', detail: (err as Error).message };
  }
}
