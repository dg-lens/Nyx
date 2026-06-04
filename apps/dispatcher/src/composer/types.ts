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
