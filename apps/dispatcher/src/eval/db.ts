/**
 * Eval storage — the `eval_scores` table (G-A, stage EVAL).
 *
 * Evaluation is a SEPARATE control plane ON TOP of the trace. The audit chain
 * records WHAT happened (tamper-evident, hash-chained); a quality SCORE is a
 * judgement ABOUT what happened and must NOT live in the chain — re-scoring a
 * run, or a judge that drifts, would otherwise rewrite the immutable ledger.
 * So scores live here, exactly like `composer_findings`: mutable, queryable,
 * off-chain, joined back to the run by correlation id. The audit chain only
 * carries the lifecycle markers (eval.online.scored, eval.drift.regressed).
 *
 * Schema is idempotent — safe to call on every dispatcher startup. Connection is
 * reused; node:sqlite is process-local. Mirrors composer/db.ts in shape + the
 * `_setEvalDb` test hook (parallels `_setAuditDb` / `_setComposerDb`).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.js';
import { openDb } from '../db.js';

export interface EvalScore {
  /** Correlation id of the scored run (taskId or pipeline runId). */
  correlationId: string;
  /** Task type the run belonged to (code/analysis/assistant/content/pipeline) —
   * drift baselines are per-type, so this is the slice key. */
  taskType: string;
  /** 0..1 quality score from the judge. */
  score: number;
  /** Why the run was sampled: a clean run hit the sampling %, or it was flagged
   * (halt/audit/stall → always scored). Drives the anti-Klarna-trap accounting. */
  reason: 'sampled' | 'flagged';
  /** The judge model used (e.g. 'haiku') — so a model swap is visible in history. */
  judgeModel: string;
  /** The judge's one-line rationale (CoT-before-verdict tail), or null. */
  rationale: string | null;
}

let db: DatabaseSync | null = null;
let insertScoreStmt: StatementSync | null = null;
let scoredIdsStmt: StatementSync | null = null;
let windowScoresStmt: StatementSync | null = null;

/** Test hook — swap in an in-memory DB. Production code never calls this. */
export function _setEvalDb(newDb: DatabaseSync | null): void {
  db = newDb;
  insertScoreStmt = null;
  scoredIdsStmt = null;
  windowScoresStmt = null;
}

function open(): DatabaseSync {
  if (db && insertScoreStmt) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_scores (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT    NOT NULL,
      task_type      TEXT    NOT NULL,
      score          REAL    NOT NULL,
      reason         TEXT    NOT NULL,
      judge_model    TEXT    NOT NULL,
      rationale      TEXT,
      scored_at      TEXT    NOT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_scores_corr ON eval_scores(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_eval_scores_type_at ON eval_scores(task_type, scored_at DESC);
  `);
  insertScoreStmt = db.prepare(
    `INSERT INTO eval_scores (correlation_id, task_type, score, reason, judge_model, rationale, scored_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A run is scored at most once — the sampler skips ids already present so a
  // re-tick doesn't double-count an already-judged run into the drift mean.
  scoredIdsStmt = db.prepare(`SELECT correlation_id FROM eval_scores WHERE scored_at >= ?`);
  windowScoresStmt = db.prepare(
    `SELECT score FROM eval_scores WHERE task_type = ? AND scored_at >= ? AND scored_at < ?`,
  );
  return db;
}

export function saveEvalScore(s: EvalScore): void {
  open();
  const now = new Date().toISOString();
  insertScoreStmt!.run(
    s.correlationId,
    s.taskType,
    s.score,
    s.reason,
    s.judgeModel,
    s.rationale,
    now,
    Date.now(),
  );
}

/** Correlation ids already scored on/after `sinceIso` — the sampler's dedup set. */
export function scoredCorrelationIds(sinceIso: string): Set<string> {
  open();
  const rows = scoredIdsStmt!.all(sinceIso) as Array<{ correlation_id: string }>;
  return new Set(rows.map((r) => r.correlation_id));
}

/** All scores for a task type within [startIso, endIso) — the drift window. */
export function scoresInWindow(taskType: string, startIso: string, endIso: string): number[] {
  open();
  const rows = windowScoresStmt!.all(taskType, startIso, endIso) as Array<{ score: number }>;
  return rows.map((r) => r.score);
}
