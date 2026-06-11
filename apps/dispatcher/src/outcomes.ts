/**
 * Canonical action-outcome taxonomy + queryable outcomes table.
 *
 * The dispatcher emits 95+ distinct audit event names whose failure payloads
 * are ad-hoc prose. The audit chain remains the canonical immutable ledger,
 * but it is poorly shaped for the "what failed this week and why" rollup:
 * monitoring code would have to regex prose strings out of 95 different
 * payload shapes.
 *
 * This module is the structured complement. Every meaningful step on a task
 * records a (stage, outcome, failure_class | skip_reason) tuple here. The
 * tuple is the closed set; monitoring code reads ONE shape, not 95.
 *
 * Mutable storage (not hash-chained) — the audit chain stays the source of
 * truth. The outcomes table is a queryable PROJECTION over what the audit
 * events already imply, with the failure cause promoted from free text to a
 * closed enum so rollups are deterministic.
 *
 * First consumer: the shadow normalizer. Today its
 * `composer.normalize.skipped` audit row collapses four distinct causes
 * (spawn failure, missing artifact, malformed JSON, invalid shape) into one
 * prose string — they each get their own `failure_class` here.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';
import { openDb } from './db.js';

export const OUTCOMES_SCHEMA_VERSION = 1;

/**
 * Major lifecycle phases. Every code/content/analysis task moves through some
 * subset of these in order; pipelines decompose into per-stage entries too.
 * Adding a stage is additive — existing rollups keep working on the old subset.
 */
export const OUTCOME_STAGES = [
  'intake',
  'preflight',
  'composer.plan',
  'composer.run',
  'composer.normalize',
  'dispatch',
  'gate',
  'verify',
  'delivery',
  'audit',
  'wisdom',
] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

export const OUTCOMES = ['ok', 'skipped', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Closed set of failure causes. Pick the most specific class that applies;
 * fall back to `unknown` only when none fits — that is the signal to add a
 * new class. Keeping this set closed (vs. free strings) is the entire point:
 * the rollup count of `unknown` is a backlog of taxonomy gaps.
 */
export const FAILURE_CLASSES = [
  'spawn_failed',
  'spawn_timeout',
  'spawn_stalled',
  'spawn_nonzero_exit',
  'artifact_missing',
  'artifact_unreadable',
  'artifact_malformed_json',
  'artifact_invalid_shape',
  'internal_error',
  'config_missing',
  'env_var_missing',
  'dependency_unmet',
  'repo_not_found',
  'git_conflict',
  'typecheck_failed',
  'tests_failed',
  'lint_failed',
  'tests_flaky',
  'expects_unmet',
  'doc_sweep_unmet',
  'judge_concern',
  'network_error',
  'rate_limited',
  'safety_filter',
  'unknown',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Closed set of skip reasons. A skip is NOT a failure — it's a stage that did
 * not run, for a known structural reason. Distinguishing skips from failures
 * is the whole reason rollups need `outcome` as a separate axis from
 * `failure_class`.
 */
export const SKIP_REASONS = [
  'disabled',
  'not_applicable',
  'depends_unmet',
  'already_done',
  'in_flight',
  'iso_cap',
  'concurrent_claude',
  'rate_limit_cooldown',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface RecordOutcomeInput {
  task_id: string;
  stage: OutcomeStage;
  outcome: Outcome;
  /** Required when `outcome === 'failed'`; must be null/absent otherwise. */
  failure_class?: FailureClass | null;
  /** Required when `outcome === 'skipped'`; must be null/absent otherwise. */
  skip_reason?: SkipReason | null;
  /** Short prose context. Free-form, intended for human eyeballs. */
  detail?: string | null;
  /** Structured extras (JSON-stringified into payload_json). */
  payload?: Record<string, unknown> | null;
  /** Stage wall-clock cost, when known. */
  duration_ms?: number | null;
}

export interface TaskOutcomeRow {
  id: number;
  at: string;
  task_id: string;
  stage: OutcomeStage;
  outcome: Outcome;
  failure_class: FailureClass | null;
  skip_reason: SkipReason | null;
  detail: string | null;
  payload: Record<string, unknown> | null;
  duration_ms: number | null;
}

export interface OutcomesRollupRow {
  stage: OutcomeStage;
  outcome: Outcome;
  failure_class: FailureClass | null;
  skip_reason: SkipReason | null;
  count: number;
}

let db: DatabaseSync | null = null;
let insertStmt: StatementSync | null = null;
let selectByTaskStmt: StatementSync | null = null;
let selectByStageStmt: StatementSync | null = null;
let selectRecentFailuresStmt: StatementSync | null = null;
let selectRecentFailuresByClassStmt: StatementSync | null = null;
let selectRecentFailuresByStageStmt: StatementSync | null = null;
let selectRecentFailuresByStageAndClassStmt: StatementSync | null = null;

/**
 * Test hook — swap in an in-memory DB. Mirrors `_setAuditDb` / `_setComposerDb`
 * pattern. Production code never calls this.
 */
export function _setOutcomesDb(newDb: DatabaseSync | null): void {
  db = newDb;
  insertStmt = null;
  selectByTaskStmt = null;
  selectByStageStmt = null;
  selectRecentFailuresStmt = null;
  selectRecentFailuresByClassStmt = null;
  selectRecentFailuresByStageStmt = null;
  selectRecentFailuresByStageAndClassStmt = null;
}

function open(): DatabaseSync {
  if (db && insertStmt) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_outcomes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      at              TEXT    NOT NULL,
      task_id         TEXT    NOT NULL,
      stage           TEXT    NOT NULL,
      outcome         TEXT    NOT NULL,
      failure_class   TEXT,
      skip_reason     TEXT,
      detail          TEXT,
      payload_json    TEXT,
      duration_ms     INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_outcomes_task
      ON task_outcomes(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_outcomes_stage
      ON task_outcomes(stage, outcome, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_outcomes_failure_class
      ON task_outcomes(failure_class, created_at DESC);
  `);
  insertStmt = db.prepare(
    `INSERT INTO task_outcomes
       (at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  selectByTaskStmt = db.prepare(
    `SELECT id, at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms
       FROM task_outcomes WHERE task_id = ? ORDER BY id DESC`,
  );
  selectByStageStmt = db.prepare(
    `SELECT id, at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms
       FROM task_outcomes WHERE stage = ? ORDER BY id DESC LIMIT ?`,
  );
  selectRecentFailuresStmt = db.prepare(
    `SELECT id, at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms
       FROM task_outcomes WHERE outcome = 'failed' ORDER BY id DESC LIMIT ?`,
  );
  selectRecentFailuresByClassStmt = db.prepare(
    `SELECT id, at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms
       FROM task_outcomes
       WHERE outcome = 'failed' AND failure_class = ?
       ORDER BY id DESC LIMIT ?`,
  );
  selectRecentFailuresByStageStmt = db.prepare(
    `SELECT id, at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms
       FROM task_outcomes
       WHERE outcome = 'failed' AND stage = ?
       ORDER BY id DESC LIMIT ?`,
  );
  selectRecentFailuresByStageAndClassStmt = db.prepare(
    `SELECT id, at, task_id, stage, outcome, failure_class, skip_reason, detail, payload_json, duration_ms
       FROM task_outcomes
       WHERE outcome = 'failed' AND stage = ? AND failure_class = ?
       ORDER BY id DESC LIMIT ?`,
  );
  return db;
}

/**
 * Enforce the taxonomy invariants the table depends on for rollups:
 *  - `failed` MUST carry a `failure_class` (and no `skip_reason`).
 *  - `skipped` MUST carry a `skip_reason` (and no `failure_class`).
 *  - `ok` MUST carry neither.
 *  - `stage` / `failure_class` / `skip_reason` MUST be one of the closed sets.
 *
 * Returns a structured error string on violation; null on pass. Exported so
 * callers and tests can validate inputs without writing to the DB.
 */
export function validateOutcomeInput(input: RecordOutcomeInput): string | null {
  if (!input.task_id || typeof input.task_id !== 'string') {
    return 'task_id is required';
  }
  if (!(OUTCOME_STAGES as readonly string[]).includes(input.stage)) {
    return `unknown stage: ${input.stage}`;
  }
  if (!(OUTCOMES as readonly string[]).includes(input.outcome)) {
    return `unknown outcome: ${input.outcome}`;
  }
  const fc = input.failure_class ?? null;
  const sr = input.skip_reason ?? null;
  if (fc != null && !(FAILURE_CLASSES as readonly string[]).includes(fc)) {
    return `unknown failure_class: ${fc}`;
  }
  if (sr != null && !(SKIP_REASONS as readonly string[]).includes(sr)) {
    return `unknown skip_reason: ${sr}`;
  }
  switch (input.outcome) {
    case 'failed':
      if (fc == null) return 'outcome=failed requires failure_class';
      if (sr != null) return 'outcome=failed must not carry skip_reason';
      return null;
    case 'skipped':
      if (sr == null) return 'outcome=skipped requires skip_reason';
      if (fc != null) return 'outcome=skipped must not carry failure_class';
      return null;
    case 'ok':
      if (fc != null) return 'outcome=ok must not carry failure_class';
      if (sr != null) return 'outcome=ok must not carry skip_reason';
      return null;
  }
}

/**
 * Persist one task outcome. Throws on a taxonomy violation rather than silently
 * writing garbage — a malformed input is a programming error, not data.
 */
export function recordOutcome(input: RecordOutcomeInput): void {
  const violation = validateOutcomeInput(input);
  if (violation) throw new Error(`recordOutcome: ${violation}`);
  open();
  const now = Date.now();
  const at = new Date(now).toISOString();
  insertStmt!.run(
    at,
    input.task_id,
    input.stage,
    input.outcome,
    input.failure_class ?? null,
    input.skip_reason ?? null,
    input.detail ?? null,
    input.payload != null ? JSON.stringify(input.payload) : null,
    input.duration_ms ?? null,
    now,
  );
}

interface RawRow {
  id: number;
  at: string;
  task_id: string;
  stage: string;
  outcome: string;
  failure_class: string | null;
  skip_reason: string | null;
  detail: string | null;
  payload_json: string | null;
  duration_ms: number | null;
}

function hydrate(row: RawRow): TaskOutcomeRow {
  let payload: Record<string, unknown> | null = null;
  if (row.payload_json) {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    at: row.at,
    task_id: row.task_id,
    stage: row.stage as OutcomeStage,
    outcome: row.outcome as Outcome,
    failure_class: row.failure_class as FailureClass | null,
    skip_reason: row.skip_reason as SkipReason | null,
    detail: row.detail,
    payload,
    duration_ms: row.duration_ms,
  };
}

/** All outcomes for one task, newest first. */
export function getOutcomesForTask(taskId: string): TaskOutcomeRow[] {
  open();
  const rows = selectByTaskStmt!.all(taskId) as unknown as RawRow[];
  return rows.map(hydrate);
}

/** Most recent outcomes for one stage (any outcome), newest first. */
export function getRecentOutcomesByStage(stage: OutcomeStage, limit: number): TaskOutcomeRow[] {
  open();
  const rows = selectByStageStmt!.all(stage, limit) as unknown as RawRow[];
  return rows.map(hydrate);
}

export interface RecentFailuresFilter {
  stage?: OutcomeStage;
  failure_class?: FailureClass;
  limit: number;
}

/** Most recent failures, optionally narrowed by stage and/or failure_class. */
export function getRecentFailures(filter: RecentFailuresFilter): TaskOutcomeRow[] {
  open();
  let rows: RawRow[];
  if (filter.stage && filter.failure_class) {
    rows = selectRecentFailuresByStageAndClassStmt!.all(
      filter.stage,
      filter.failure_class,
      filter.limit,
    ) as unknown as RawRow[];
  } else if (filter.stage) {
    rows = selectRecentFailuresByStageStmt!.all(filter.stage, filter.limit) as unknown as RawRow[];
  } else if (filter.failure_class) {
    rows = selectRecentFailuresByClassStmt!.all(
      filter.failure_class,
      filter.limit,
    ) as unknown as RawRow[];
  } else {
    rows = selectRecentFailuresStmt!.all(filter.limit) as unknown as RawRow[];
  }
  return rows.map(hydrate);
}

/**
 * Group outcomes by (stage, outcome, failure_class | skip_reason) and count.
 * Built dynamically (not a prepared stmt) so the optional `sinceIso` window
 * stays clean. The answer-shape is what the "what failed this week and why"
 * Slack digest needs.
 */
export function rollupByStage(opts: { sinceIso?: string } = {}): OutcomesRollupRow[] {
  const d = open();
  const where = opts.sinceIso ? ` WHERE at >= ?` : '';
  const args = opts.sinceIso ? [opts.sinceIso] : [];
  const rows = d
    .prepare(
      `SELECT stage, outcome, failure_class, skip_reason, COUNT(*) AS n
         FROM task_outcomes${where}
        GROUP BY stage, outcome, failure_class, skip_reason
        ORDER BY n DESC`,
    )
    .all(...args) as unknown as Array<{
    stage: string;
    outcome: string;
    failure_class: string | null;
    skip_reason: string | null;
    n: number;
  }>;
  return rows.map((r) => ({
    stage: r.stage as OutcomeStage,
    outcome: r.outcome as Outcome,
    failure_class: r.failure_class as FailureClass | null,
    skip_reason: r.skip_reason as SkipReason | null,
    count: r.n,
  }));
}
