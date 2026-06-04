/**
 * Pipeline state machine — the legal-transition table from
 * scaffold/prompt-to-product-pipeline.md, encoded as data.
 *
 * Pure. No I/O. The orchestrator calls `assertTransition` before every
 * `updateRun` so an illegal transition (a stage bug) throws loudly instead of
 * silently corrupting run state. Tests exercise the table directly.
 */

import type { PipelineStatus } from './types.js';

/**
 * from → set of legal next statuses. Mirrors the state-machine table in the
 * spec exactly:
 *   planning          → awaiting_preview
 *   awaiting_preview  → replanning (revise) · executing (go) · aborted
 *   replanning        → awaiting_preview
 *   executing         → shipping
 *   shipping          → done (green) · awaiting_review (unresolved)
 *   awaiting_review   → shipping (proceed/R3) · executing (fix) · planning (rollback) · aborted
 *
 * `failed` is reachable from any non-terminal status (unrecoverable error).
 * `aborted` is reachable from any non-terminal status (operator abort).
 */
const TRANSITIONS: Record<PipelineStatus, readonly PipelineStatus[]> = {
  planning: ['awaiting_preview'],
  awaiting_preview: ['replanning', 'executing'],
  replanning: ['awaiting_preview'],
  // executing → awaiting_review is the in-phase escalation: a phase that can't
  // merge clean after R1/R2 (or a catastrophic redux) goes straight to review.
  executing: ['shipping', 'awaiting_review'],
  shipping: ['done', 'awaiting_review'],
  // proceed → done (accept/ship), fix → executing (fresh corrective wave),
  // rollback → planning (replan). shipping is reachable too for symmetry.
  awaiting_review: ['done', 'shipping', 'executing', 'planning'],
  done: [],
  aborted: [],
  failed: [],
};

const TERMINAL = new Set<PipelineStatus>(['done', 'aborted', 'failed']);

/**
 * `failed` and `aborted` are universal sinks from any non-terminal status —
 * an unrecoverable error or an operator abort can land anywhere. They are NOT
 * listed per-row above to keep the happy-path table readable.
 */
export function canTransition(from: PipelineStatus, to: PipelineStatus): boolean {
  if (TERMINAL.has(from)) return false;
  if (to === 'failed' || to === 'aborted') return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: PipelineStatus, to: PipelineStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal pipeline transition: ${from} → ${to}`);
  }
}

export function legalNext(from: PipelineStatus): readonly PipelineStatus[] {
  return TRANSITIONS[from] ?? [];
}
