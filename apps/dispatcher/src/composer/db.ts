/**
 * Composer storage — flight_plans + composer_runs + composer_findings tables.
 *
 * Mutable state (not hash-chained). The audit chain records task-lifecycle
 * events around these (task.flight_plan.submitted, composer.run.completed)
 * but NOT the finding payloads themselves — those live here so they're
 * queryable structured data for the v1+ design phase (per operator decision 4:
 * "findings are training for the full rollout, not audit logs for the current
 * queue").
 *
 * Schema is idempotent — safe to call on every dispatcher startup. The DB
 * connection is reused; node:sqlite is process-local.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.js';
import { openDb } from '../db.js';
import type { ComposerRunResult, FlightPlan } from './types.js';

let db: DatabaseSync | null = null;
let insertFlightPlanStmt: StatementSync | null = null;
let getLatestFlightPlanStmt: StatementSync | null = null;
let insertRunStmt: StatementSync | null = null;
let insertFindingStmt: StatementSync | null = null;

/**
 * Test hook — swap in an in-memory DB. Mirrors `_setAuditDb` / `_setSecretsDb`
 * pattern. Production code never calls this.
 */
export function _setComposerDb(newDb: DatabaseSync | null): void {
  db = newDb;
  insertFlightPlanStmt = null;
  getLatestFlightPlanStmt = null;
  insertRunStmt = null;
  insertFindingStmt = null;
}

function open(): DatabaseSync {
  if (db && insertFlightPlanStmt) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS flight_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      drafted_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      plan_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flight_plans_task ON flight_plans(task_id, drafted_at DESC);

    CREATE TABLE IF NOT EXISTS composer_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      ancestor_task_ids_json TEXT NOT NULL,
      model TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      raw_response TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_composer_runs_task ON composer_runs(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS composer_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      composer_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT NOT NULL,
      involved_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (composer_run_id) REFERENCES composer_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_composer_findings_run ON composer_findings(composer_run_id);
    CREATE INDEX IF NOT EXISTS idx_composer_findings_kind ON composer_findings(kind, created_at DESC);
  `);
  insertFlightPlanStmt = db.prepare(
    `INSERT INTO flight_plans (task_id, drafted_at, schema_version, plan_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  getLatestFlightPlanStmt = db.prepare(
    `SELECT plan_json FROM flight_plans WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
  );
  insertRunStmt = db.prepare(
    `INSERT INTO composer_runs (id, task_id, ancestor_task_ids_json, model, duration_ms, raw_response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertFindingStmt = db.prepare(
    `INSERT INTO composer_findings (composer_run_id, task_id, kind, severity, detail, involved_json, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return db;
}

export function saveFlightPlan(plan: FlightPlan): void {
  open();
  insertFlightPlanStmt!.run(
    plan.task_id,
    plan.drafted_at,
    plan.schema_version,
    JSON.stringify(plan),
    Date.now(),
  );
}

export function getLatestFlightPlan(taskId: string): FlightPlan | null {
  open();
  const row = getLatestFlightPlanStmt!.get(taskId) as { plan_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.plan_json) as FlightPlan;
  } catch {
    return null;
  }
}

export function saveComposerRun(result: ComposerRunResult): void {
  open();
  const now = Date.now();
  insertRunStmt!.run(
    result.composer_run_id,
    result.task_id,
    JSON.stringify(result.ancestor_task_ids),
    result.model,
    result.duration_ms,
    result.raw_response,
    now,
  );
  for (const f of result.findings) {
    insertFindingStmt!.run(
      result.composer_run_id,
      result.task_id,
      f.kind,
      f.severity,
      f.detail,
      JSON.stringify(f.involved),
      JSON.stringify(f.payload),
      now,
    );
  }
}
