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

import { appendChainRow, runChecked } from '../audit.js';
import { config } from '../config.js';
import { openDb } from '../db.js';
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
    db = openDb(config.dbPath);
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
      resume_lease       INTEGER,
      completed_phases   TEXT,
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
    // P3 replay-safety. resume_lease holds the epoch-ms expiry of the resume
    // lease a tick took on this run (the CAS anchor that stops two overlapping
    // ticks resuming the same run); completed_phases is the JSON projection of
    // phases a replay must NOT re-run.
    ['resume_lease', 'INTEGER'],
    ['completed_phases', 'TEXT'],
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
  resume_lease: number | null;
  completed_phases: string | null;
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
    resume_lease: r.resume_lease,
    completed_phases: r.completed_phases,
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
  'resume_lease',
  'completed_phases',
] as const;

/**
 * Apply a whitelisted patch to a run row on the GIVEN connection (no read-back,
 * no transaction). Split out from `updateRun` so a same-transaction checkpoint
 * can run the UPDATE on the AUDIT connection — the pipeline row + its audit event
 * must hit one connection under one BEGIN to commit atomically (two connections
 * to the same file can't share a transaction).
 */
function applyPatch(d: DatabaseSync, id: string, patch: Partial<PipelineRun>, now: number): void {
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
    d.prepare(`UPDATE pipeline_runs SET updated_at = ? WHERE id = ?`).run(now, id);
    return;
  }
  cols.push('updated_at = ?');
  vals.push(now);
  vals.push(id);
  d.prepare(`UPDATE pipeline_runs SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
}

export function updateRun(id: string, patch: Partial<PipelineRun>, now: number): PipelineRun | null {
  applyPatch(open(), id, patch, now);
  return getRun(id);
}

/**
 * Runs not in a terminal status. Intended as an independent tick-scan resume
 * source, but NOT yet wired into the production tick — `handlePipelineInTick`
 * (run-once.ts) advances runs via the standing queue task and
 * `runsAwaitingDecision()` only. Until activeRuns() is consumed by the tick, a
 * run in 'executing'/'shipping'/'planning'/'replanning' depends on its standing
 * queue-task entry persisting for its whole lifetime, or it stalls. Currently
 * exercised only by the test suite.
 */
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

/**
 * How long a resume lease is honored before a later tick may steal it. A normal
 * resume holds the run for the duration of one tick's autonomous run (coders cap
 * at 30 min/phase, one phase per tick); the lease must outlast that so a healthy
 * in-progress resume is never stolen, yet be short enough that a crashed tick's
 * stale lease is reclaimable within an hour. The launchd shell single-flight lock
 * already serializes scheduled ticks; this lease is the durable backstop for the
 * manual-`nyx tick` ↔ scheduled-tick overlap the shell lock does NOT cover.
 */
export const RESUME_LEASE_MS = 60 * 60_000;

/**
 * Resume-lease CAS (P3). Atomically claim a decided run for THIS tick before any
 * phase advances, so a manual `nyx tick` and a scheduled launchd tick can't both
 * resume one run (running its coders / pushing its delivery twice). The UPDATE
 * succeeds (rowCount 1) only if the run is still awaiting at a gate WITH a
 * decision AND its lease is free (never set, or expired past `now`). A losing
 * racer sees rowCount 0 → it must skip the run this tick. Stamping the lease into
 * the future is what fences the loser; the winner clears it when it consumes the
 * decision (the orchestrator nulls `operator_decision`, which also bars re-claim).
 *
 * Returns the freshly-claimed run (lease stamped) on win, null on loss/absence.
 */
export function claimRunForResume(id: string, now: number): PipelineRun | null {
  const d = open();
  const leaseUntil = now + RESUME_LEASE_MS;
  const res = d
    .prepare(
      `UPDATE pipeline_runs
         SET resume_lease = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('awaiting_preview','awaiting_review')
         AND operator_decision IS NOT NULL
         AND (resume_lease IS NULL OR resume_lease < ?)`,
    )
    .run(leaseUntil, now, id, now);
  if (Number(res.changes) === 0) return null;
  return getRun(id);
}

/** Release a resume lease (e.g. a claimed run that turned out to be a no-op). */
export function releaseResumeLease(id: string, now: number): void {
  const d = open();
  d.prepare(`UPDATE pipeline_runs SET resume_lease = NULL, updated_at = ? WHERE id = ?`).run(now, id);
}

/**
 * Same-transaction state-transition checkpoint (P3 / DBOS journal). Commit the
 * `pipeline_runs` status mutation AND its audit event together so a crash between
 * the two can't leave the run row and the append-only chain disagreeing (the row
 * says `done`, the chain has no `pipeline.delivered`, or vice-versa).
 *
 * Both writes go through the AUDIT connection inside ONE `BEGIN IMMEDIATE`
 * (`runChecked`): the pipeline row and the audit chain live in the SAME file, but
 * pipeline/db.ts and audit.ts hold SEPARATE connections to it — two connections
 * can't share a transaction, and node:sqlite rejects a nested `BEGIN`. So the
 * checkpoint routes the run-row UPDATE onto the audit connection too (`applyPatch`
 * takes the connection explicitly), and appends the chain row with
 * `appendChainRow` (the no-own-transaction variant). The read-back uses the
 * pipeline connection, which sees the committed row (WAL, same file). `emitAudit`
 * is the caller's chain-append, invoked inside the transaction.
 */
export function checkpointTransition(
  id: string,
  patch: Partial<PipelineRun>,
  now: number,
  emitAudit: () => void,
): PipelineRun | null {
  open(); // ensure pipeline_runs exists on the shared file before the audit conn writes it
  runChecked((conn) => {
    applyPatch(conn, id, patch, now);
    emitAudit();
  });
  return getRun(id);
}

function parsePhaseList(json: string | null): number[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/** The set of phase indices a run has fully merged — the replay-skip projection. */
export function completedPhases(id: string): number[] {
  const run = getRun(id);
  return run ? parsePhaseList(run.completed_phases) : [];
}

/**
 * Record `phase` as fully completed (merged clean) for a run, idempotently — a
 * replay of an already-recorded phase is a no-op, and a replay after a crash
 * re-runs ONLY phases absent from this set. Persisted as a sorted unique JSON
 * int array on `completed_phases`.
 */
export function markPhaseCompleted(id: string, phase: number, now: number): number[] {
  const run = getRun(id);
  if (!run) return [];
  const set = new Set(parsePhaseList(run.completed_phases));
  set.add(phase);
  const next = [...set].sort((a, b) => a - b);
  updateRun(id, { completed_phases: JSON.stringify(next) }, now);
  return next;
}
