/**
 * Pipeline orchestrator types — the `[type: pipeline]` flow.
 *
 * A pipeline is a single operator prompt turned into a reconciled, gate-green,
 * PR-ready feature via autonomous coding + composer self-reconciliation between
 * two human gates (preview always; review only-if-unreconciled). See
 * scaffold/prompt-to-product-pipeline.md for the full design.
 *
 * This file is the type backbone. `state-machine.ts` encodes legal transitions,
 * `db.ts` persists `PipelineRun` rows, `orchestrator.ts` advances a run across
 * ticks. Step 1 (this commit) is a walking skeleton: a run advances through the
 * real state machine straight to `done`. Stages are stubs filled in later steps.
 */

export type PipelineStatus =
  | 'planning'          // stages 2–4 autonomous (decompose → flight-plans → align)
  | 'awaiting_preview'  // preview brief delivered, paused for operator
  | 'replanning'        // re-run flight-plan + align with operator info
  | 'executing'         // stages 5–6: parallel coders + composer redux
  | 'shipping'          // stages 7–8: R1 → smoke/gate → R2 (⇄ redux)
  | 'awaiting_review'   // review brief delivered, paused for operator
  | 'done'              // terminal — PR-ready + gate-green
  | 'aborted'           // terminal — operator aborted
  | 'failed';           // terminal — unrecoverable error

export const TERMINAL_STATUSES: readonly PipelineStatus[] = ['done', 'aborted', 'failed'];
export const AWAITING_STATUSES: readonly PipelineStatus[] = ['awaiting_preview', 'awaiting_review'];

export function isTerminal(s: PipelineStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}
export function isAwaiting(s: PipelineStatus): boolean {
  return (AWAITING_STATUSES as readonly string[]).includes(s);
}

/**
 * Operator decisions at the two gates. Preview gate: `go` / `revise` / `abort`.
 * Review gate: `proceed` / `fix` / `rollback` / `abort`. The orchestrator clears
 * `operator_decision` to null the moment it consumes one, so a stale decision
 * can never be re-applied on a later tick.
 */
export type DecisionKind = 'go' | 'revise' | 'abort' | 'proceed' | 'fix' | 'rollback';

export interface OperatorDecision {
  kind: DecisionKind;
  /** Revise info, fix directives, abort reason — free text from the operator. */
  note?: string;
  /** True when the dispatcher synthesized the decision (step-1 skeleton auto-approve). */
  auto?: boolean;
  at: string;
}

/**
 * Mutable run state. The audit chain holds
 * the append-only `pipeline.*` event record; this row holds current state.
 */
export interface PipelineRun {
  id: string;
  task_id: string;
  prompt: string;
  /** Target repo (`org/name`) the planning/coder agents clone. Null → ~/Nyx. */
  repo: string | null;
  status: PipelineStatus;
  current_stage: string | null;
  /** Frozen at preview "go" — the scope-creep contract for execution. */
  plan_json: string | null;
  /** Per-run design-voice policy (agent_can_decide vs must_escalate). JSON. */
  authorities: string | null;
  /** Path to the current gate brief on disk. */
  bz_brief_path: string | null;
  /** Null while running; set when the operator answers a gate. Cleared on consume. */
  operator_decision: OperatorDecision | null;
  integration_branch: string | null;
  /** Composer redux findings. JSON. */
  redux_findings: string | null;
  /** Cross-worktree remediation directives. JSON. */
  remediation_plan: string | null;
  /** Diagnostic rounds run within the current phase (R1+R2 autonomous). Resets per phase. */
  diagnostic_round: number;
  /** 0-based index of the phase currently executing (one phase per tick). */
  current_phase: number;
  /** Wall-clock + spawn count (NOT dollars — Max-plan reality). JSON. */
  cost_actuals: string | null;
  worktree_base: string | null;
  /** Per-coder execution results (branch/commit/status). JSON. Feeds redux. */
  coder_results: string | null;
  /** Operator's review-gate `fix` directive, threaded into the corrective wave. */
  fix_directive: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}
