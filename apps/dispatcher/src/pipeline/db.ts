/**
 * Pipeline storage — the `pipeline_runs` mutable-state table.
 *
 * Mutable state (not hash-chained), same posture as composer/db.ts. The audit
 * chain records the append-only `pipeline.*` lifecycle events; this row holds
 * the current state a tick reads to decide what to do next.
 *
 * Schema is idempotent — safe to call on every dispatcher startup. The DB
 * connection is reused; node:sqlite is process-local.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.js';
import type { OperatorDecision, PipelineRun, PipelineStatus } from './types.js';

let db: DatabaseSync | null = null;
let prepared = false;

/**
 * Test hook — swap in an in-memory DB. Mirrors `_setAuditDb` / `_setComposerDb`.
 * Production code never calls this.
 */
export function _setPipelineDb(newDb: DatabaseSync | null): void {
  db = newDb;
  prepared = false;
}

function open(): DatabaseSync {
  if (db && prepared) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
    db.exec(`PRAGMA journal_mode = WAL;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id                 TEXT PRIMARY KEY,
      task_id            TEXT NOT NULL,
      prompt             TEXT NOT NULL,
      repo               TEXT,
      status             TEXT NOT NULL,
      current_stage      TEXT,
      plan_json          TEXT,
      authorities        TEXT,
      bz_brief_path      TEXT,
      operator_decision  TEXT,
      integration_branch TEXT,
      redux_findings     TEXT,
      remediation_plan   TEXT,
      diagnostic_round   INTEGER NOT NULL DEFAULT 0,
      current_phase      INTEGER NOT NULL DEFAULT 0,
      cost_actuals       TEXT,
      worktree_base      TEXT,
      coder_results      TEXT,
      fix_directive      TEXT,
      error              TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task   ON pipeline_runs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
  `);
  // Idempotent column migration. CREATE TABLE IF NOT EXISTS never alters an
  // existing table, so columns added after a table was first created (e.g. a
  // live launchd tick created pipeline_runs at the step-1 schema) are missing.
  // Add any that aren't present. SQLite has no ADD COLUMN IF NOT EXISTS, so we
  // check PRAGMA table_info first. Each ALTER is a no-op once applied.
  ensureColumns(db, 'pipeline_runs', [
    ['repo', 'TEXT'],
    ['coder_results', 'TEXT'],
    ['fix_directive', 'TEXT'],
    ['current_phase', 'INTEGER NOT NULL DEFAULT 0'],
  ]);
  prepared = true;
  return db;
}

function ensureColumns(d: DatabaseSync, table: string, cols: Array<[string, string]>): void {
  const present = new Set(
    (d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
  );
  for (const [name, ddl] of cols) {
    if (!present.has(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
}

interface Row {
  id: string;
  task_id: string;
  prompt: string;
  repo: string | null;
  status: string;
  current_stage: string | null;
  plan_json: string | null;
  authorities: string | null;
  bz_brief_path: string | null;
  operator_decision: string | null;
  integration_branch: string | null;
  redux_findings: string | null;
  remediation_plan: string | null;
  diagnostic_round: number;
  current_phase: number;
  cost_actuals: string | null;
  worktree_base: string | null;
  coder_results: string | null;
  fix_directive: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToRun(r: Row): PipelineRun {
  let decision: OperatorDecision | null = null;
  if (r.operator_decision) {
    try {
      decision = JSON.parse(r.operator_decision) as OperatorDecision;
    } catch {
      decision = null;
    }
  }
  return {
    id: r.id,
    task_id: r.task_id,
    prompt: r.prompt,
    repo: r.repo,
    status: r.status as PipelineStatus,
    current_stage: r.current_stage,
    plan_json: r.plan_json,
    authorities: r.authorities,
    bz_brief_path: r.bz_brief_path,
    operator_decision: decision,
    integration_branch: r.integration_branch,
    redux_findings: r.redux_findings,
    remediation_plan: r.remediation_plan,
    diagnostic_round: r.diagnostic_round,
    current_phase: r.current_phase,
    cost_actuals: r.cost_actuals,
    worktree_base: r.worktree_base,
    coder_results: r.coder_results,
    fix_directive: r.fix_directive,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function createRun(args: {
  id: string;
  taskId: string;
  prompt: string;
  repo?: string | null;
  now: number;
}): PipelineRun {
  const d = open();
  d.prepare(
    `INSERT INTO pipeline_runs (id, task_id, prompt, repo, status, diagnostic_round, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'planning', 0, ?, ?)`,
  ).run(args.id, args.taskId, args.prompt, args.repo ?? null, args.now, args.now);
  return getRun(args.id)!;
}

export function getRun(id: string): PipelineRun | null {
  const d = open();
  const row = d.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToRun(row) : null;
}

/** Latest run for a task (a task gets one run; latest guards re-queues). */
export function getRunByTaskId(taskId: string): PipelineRun | null {
  const d = open();
  const row = d
    .prepare(`SELECT * FROM pipeline_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(taskId) as Row | undefined;
  return row ? rowToRun(row) : null;
}

/**
 * Columns the orchestrator may patch. `operator_decision` is serialized to JSON;
 * everything else maps 1:1. `status`/`diagnostic_round` included so transitions
 * and the diagnostic counter persist. Whitelisted — no caller-controlled keys
 * reach the SQL.
 */
const UPDATABLE = [
  'status',
  'current_stage',
  'plan_json',
  'authorities',
  'bz_brief_path',
  'operator_decision',
  'integration_branch',
  'redux_findings',
  'remediation_plan',
  'diagnostic_round',
  'current_phase',
  'cost_actuals',
  'worktree_base',
  'coder_results',
  'fix_directive',
  'error',
] as const;

export function updateRun(id: string, patch: Partial<PipelineRun>, now: number): PipelineRun | null {
  const d = open();
  const cols: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const key of UPDATABLE) {
    if (!(key in patch)) continue;
    const raw = (patch as Record<string, unknown>)[key];
    cols.push(`${key} = ?`);
    if (key === 'operator_decision') {
      vals.push(raw == null ? null : JSON.stringify(raw));
    } else {
      vals.push((raw as string | number | null) ?? null);
    }
  }
  if (cols.length === 0) {
    // Touch updated_at only.
    d.prepare(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`).run(now, id);
    return getRun(id);
  }
  cols.push('updated_at = ?');
  vals.push(now);
  vals.push(id);
  d.prepare(`UPDATE pipeline_runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  return getRun(id);
}

/** Runs not in a terminal status. The tick scan reads these. */
export function activeRuns(): PipelineRun[] {
  const d = open();
  const rows = d
    .prepare(`SELECT * FROM pipeline_runs WHERE status NOT IN ('done','aborted','failed') ORDER BY created_at ASC`)
    .all() as unknown as Row[];
  return rows.map(rowToRun);
}

/** Most-recent runs (any status), newest first — for `nyx pipeline list`. */
export function listRuns(limit = 20): PipelineRun[] {
  const d = open();
  const rows = d
    .prepare(`SELECT * FROM pipeline_runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as Row[];
  return rows.map(rowToRun);
}

/** Runs parked at a gate whose operator decision has arrived (tick priority 1). */
export function runsAwaitingDecision(): PipelineRun[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT * FROM pipeline_runs
       WHERE status IN ('awaiting_preview','awaiting_review')
         AND operator_decision IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all() as unknown as Row[];
  return rows.map(rowToRun);
}
