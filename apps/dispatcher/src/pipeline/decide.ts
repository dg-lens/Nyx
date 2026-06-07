/**
 * Operator-decision intake for pipeline gates — the single chokepoint for
 * pipeline gate decisions (today the `nyx pipeline …` CLI; a future remote
 * plugin reuses the same entry point). It validates the decision against the
 * run's current gate, records it on the run, and emits
 * `pipeline.decision.submitted`. The NEXT tick's resume scan
 * (`resumeDecidedRuns`) is what actually advances the run — this only arms it.
 *
 * Keeping validation here (not in the caller) means every surface rejects the
 * same illegal decisions identically.
 */

import { audit } from '../audit.js';
import { getRun, updateRun } from './db.js';
import { isAwaiting, type DecisionKind, type OperatorDecision, type PipelineRun } from './types.js';

export const PREVIEW_KINDS: readonly DecisionKind[] = ['go', 'revise', 'abort'];
export const REVIEW_KINDS: readonly DecisionKind[] = ['accept', 'proceed', 'fix', 'rollback', 'abort'];

export interface SubmitResult {
  ok: boolean;
  message: string;
  run?: PipelineRun;
}

export function submitDecision(
  runId: string,
  kind: DecisionKind,
  opts: { note?: string; source?: string } = {},
): SubmitResult {
  const run = getRun(runId);
  if (!run) return { ok: false, message: `no pipeline run '${runId}'` };
  if (!isAwaiting(run.status)) {
    return { ok: false, message: `run ${runId} is '${run.status}', not waiting at a gate` };
  }
  if (run.operator_decision) {
    return {
      ok: false,
      message: `a '${run.operator_decision.kind}' decision is already armed for ${runId}; wait for the next tick to apply it`,
    };
  }
  const gate = run.status === 'awaiting_preview' ? 'preview' : 'review';
  const allowed = gate === 'preview' ? PREVIEW_KINDS : REVIEW_KINDS;
  if (!allowed.includes(kind)) {
    return {
      ok: false,
      message: `'${kind}' is not valid at the ${gate} gate (allowed: ${allowed.join(', ')})`,
    };
  }
  const note = opts.note?.trim() ?? '';
  if (kind === 'revise' && !note) {
    return { ok: false, message: `revise requires a note explaining what to change` };
  }
  if (kind === 'fix' && !note) {
    return { ok: false, message: `fix requires a note describing the corrective work` };
  }
  const decision: OperatorDecision = { kind, at: new Date().toISOString(), ...(note ? { note } : {}) };
  const updated = updateRun(runId, { operator_decision: decision }, Date.now());
  audit('pipeline.decision.submitted', 'pipeline.decide', {
    runId,
    gate,
    kind,
    source: opts.source ?? 'cli',
    note: note.slice(0, 200),
  });
  return {
    ok: true,
    message: `'${kind}' recorded for ${runId} — the next tick will resume it`,
    ...(updated ? { run: updated } : {}),
  };
}
