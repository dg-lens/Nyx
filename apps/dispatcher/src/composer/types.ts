/**
 * Composer types — flight plans, findings, chain context.
 *
 * Stage 0 (observation-only): the composer LOGS conflicts to the
 * `composer_findings` table. It does NOT block task execution.
 *
 * See `apps/dispatcher/src/composer/CLAUDE.md` (T3) for the architecture
 * + the stage roadmap.
 */

export const FLIGHT_PLAN_SCHEMA_VERSION = 1;

export interface ExportedSymbol {
  file: string;
  symbol: string;
  signature: string;
  purpose: string;
}

export interface ChainImport {
  from_task: string;
  file: string;
  symbol: string;
  expected_signature: string;
}

export interface DocUpdate {
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  path: string;
  section: string;
  change_summary: string;
}

export interface FlightPlan {
  schema_version: 1;
  task_id: string;
  task_summary: string;
  /** ISO-8601 timestamp the planning agent wrote this. */
  drafted_at: string;
  files: {
    create: string[];
    modify: string[];
    delete: string[];
  };
  exports: ExportedSymbol[];
  /** Mirrors task.depends[] — copied here for composer's convenience. */
  depends_on_tasks: string[];
  imports_from_chain: ChainImport[];
  doc_updates: DocUpdate[];
  /** True if a revision pass is possible; stage 0 records but doesn't act on this. */
  revisable: boolean;
  /** If this plan is a revision of an earlier one, the prior plan's id; else null. */
  revision_of: string | null;
  estimated_risk: 'low' | 'medium' | 'high';
  /** Freeform context the planning agent wants the composer to know. */
  notes: string;
}

// ── Composer findings ─────────────────────────────────────────────────

export type FindingKind =
  | 'file_conflict'
  | 'interface_mismatch'
  | 'circular_dependency'
  | 'missing_doc_update'
  | 'plan_actual_divergence'
  | 'unresolved_dependency';

export type FindingSeverity = 'info' | 'warn' | 'block_recommended';

export interface ComposerFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  /** Human-readable one-paragraph description. */
  detail: string;
  /** Task IDs involved in this finding (new + ancestor). */
  involved: string[];
  /** Structured detail for downstream tooling. Free-shape JSON. */
  payload: Record<string, unknown>;
}

export interface ComposerRunResult {
  composer_run_id: string;
  task_id: string;
  ancestor_task_ids: string[];
  findings: ComposerFinding[];
  /** Full stdout from the composer claude -p call. Saved for v1+ training. */
  raw_response: string;
  duration_ms: number;
  model: string;
}

// ── Pre-dispatch normalizer (shadow stage) ────────────────────────────
//
// The normalizer is the composer's intended canonical role: a PRE-DISPATCH
// spec compiler. Given one task spec, it (a) detects ambiguities /
// contradictions / missing constraints, (b) tightens the spec deterministically
// (exact symbols, verbatim acceptance criteria, anti-examples), (c) compiles
// the [depends:] dependency DAG + predicts merge conflicts, and (d) computes a
// would-reject verdict for un-normalizable specs.
//
// THIS CUT IS SHADOW-ONLY: the normalizer COMPUTES + PERSISTS + AUDIT-LOGS its
// output and returns control unchanged. It MUST NOT halt, reject, re-park, alter
// the spec the executor sees, or change any task's control flow. `enforced` is
// read from config but NOT acted on — enforcement is a separate future PR. The
// only new signal is the recorded `would_reject` boolean for operator review.

export const NORMALIZATION_SCHEMA_VERSION = 1;

export interface NormalizationVerdict {
  /** Can this task be completed as specified? */
  solvable: 'yes' | 'no' | 'uncertain';
  /** Does the spec carry every constraint needed to execute deterministically? */
  complete: 'yes' | 'no';
  /** Task IDs whose work this spec appears to duplicate. */
  redundant_with: string[];
  /** Contradictions / missing constraints that block clean normalization. */
  blocking_issues: string[];
}

export interface NormalizedSpec {
  task_id: string;
  /** The deterministically-tightened task body the future enforcer would emit. */
  tightened_body: string;
  /** Concrete, checkable acceptance criteria. */
  acceptance_criteria: string[];
  /** Anti-examples — wrong approaches the agent must NOT take. */
  anti_examples: string[];
  /** Every file path / symbol the task references, with an existence flag. */
  resolved_paths: { path: string; exists: boolean }[];
  verdict: NormalizationVerdict;
}

export interface ChainDag {
  /** All task IDs in this task's immediate [depends:] closure (self + deps). */
  nodes: string[];
  /** Directed edges [from, to] meaning `from` depends on `to`. */
  edges: [string, string][];
  /** Kahn topological order, or null when a cycle is present. */
  topo_order: string[] | null;
  /** The detected cycle's node list, or null when acyclic. */
  cycle: string[] | null;
  /** Predicted merge conflicts between pairs of chained tasks. */
  predicted_conflicts: { between: [string, string]; files: string[] }[];
}

export interface NormalizationResult {
  normalization_id: string;
  task_id: string;
  spec: NormalizedSpec;
  /** null when the task declares no [depends:]. */
  dag: ChainDag | null;
  /**
   * Mirrors config.composer.normalizer.enforced at compute time. SHADOW CUT:
   * recorded for operator visibility only — never acted on. Enforcement is a
   * future PR.
   */
  enforced: boolean;
  /**
   * Operator-review signal: true when the spec is un-normalizable as-is. SHADOW
   * CUT: recorded only — does NOT halt/reject/re-park anything.
   */
  would_reject: boolean;
  /** One-line summary of why would_reject is true, else null. */
  reject_reason: string | null;
  duration_ms: number;
  model: string;
  /** Full stdout/artifact text from the normalizer spawn. Saved for v1+ training. */
  raw_response: string;
}
