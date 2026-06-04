import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

export type AuditEvent =
  | 'dispatch.tick'
  | 'dispatch.idle'
  | 'dispatch.stale'
  | 'dispatch.chain_limit_reached'
  | 'dispatch.chain_verified'
  | 'task.started'
  | 'task.claude.exited'
  | 'task.gate.completed'
  | 'task.committed'
  | 'task.merged'
  | 'task.output.written'
  | 'task.pr.created'
  | 'task.pushed'
  | 'task.production.deploy_required'
  | 'task.completed'
  | 'task.failed'
  | 'task.failure_reset'
  | 'task.rollback'
  | 'task.abandoned'
  | 'task.stale_worktree_cleared'
  | 'task.skipped.in_flight'
  | 'task.skipped.depends_unmet'
  | 'task.skipped.concurrent_claude'
  | 'task.skipped.halt_chain'
  | 'task.tag.invalid'
  | 'task.preflight.failed'
  | 'task.reading_tag.absent'
  | 'task.expects.failed'
  | 'task.expects.prevalidate.failed'
  | 'task.clone.basebranch.assertion_failed'
  | 'task.audit.started'
  | 'task.audit.classified'
  | 'task.audit.autofix.applied'
  | 'task.audit.autofix.succeeded'
  | 'task.audit.autofix.failed'
  | 'task.audit.escalated'
  | 'task.halted_for_review'
  | 'task.resumed'
  | 'task.cancelled'
  | 'assistant.morning_brief'
  | 'assistant.reminder'
  | 'assistant.slack_digest'
  | 'assistant.rotation_check.run'
  | 'assistant.rotation_check.clear'
  | 'analyzer.clone.started'
  | 'analyzer.scan.completed'
  | 'analyzer.pr.created'
  | 'bitwarden.project.registered'
  | 'bitwarden.project.created'
  | 'bitwarden.secret.rotation_logged'
  | 'bitwarden.secret.rotation_updated'
  | 'bitwarden.token.missing'
  | 'inbox.rotation.ingested'
  | 'inbox.rotation.malformed'
  // Ambiguity escalation: agent wrote .nyx/ambiguity.json and exited 0
  | 'task.ambiguity.escalated'
  // Wisdom capture: second claude -p spawn after main task exits 0, before gate
  | 'task.wisdom.captured'
  | 'task.wisdom.skipped'
  // Doc-sweep verifier (finalize-time check that declared doc updates were applied)
  | 'task.doc_sweep.passed'
  | 'task.doc_sweep.failed'
  // Composer layer (stage 0 — observation only). See apps/dispatcher/src/composer/CLAUDE.md
  | 'task.flight_plan.spawned'
  | 'task.flight_plan.submitted'
  | 'task.flight_plan.missing'
  | 'task.flight_plan.invalid_json'
  | 'task.flight_plan.spawn_failed'
  | 'composer.run.spawned'
  | 'composer.run.completed'
  | 'composer.skipped'
  // Pipeline orchestrator (`[type: pipeline]`). Append-only lifecycle record;
  // mutable run state lives in the pipeline_runs table. See
  // scaffold/prompt-to-product-pipeline.md + apps/dispatcher/src/pipeline/.
  | 'pipeline.run.started'
  | 'pipeline.decision.submitted'
  | 'pipeline.stage.advanced'
  | 'pipeline.preview.delivered'
  | 'pipeline.preview.revised'
  | 'pipeline.preview.approved'
  | 'pipeline.executing.started'
  | 'pipeline.coder.started'
  | 'pipeline.coder.finished'
  | 'pipeline.redux.complete'
  | 'pipeline.diagnostic.started'
  | 'pipeline.diagnostic.finished'
  | 'pipeline.diagnostic.fix.verified'
  | 'pipeline.diagnostic.fix.rejected'
  | 'pipeline.smoke.invalidated'
  | 'pipeline.smoke.completed'
  | 'pipeline.review.delivered'
  | 'pipeline.review.proceed'
  | 'pipeline.review.fix'
  | 'pipeline.review.rollback'
  | 'pipeline.short_circuit'
  | 'pipeline.aborted'
  | 'pipeline.delivered'
  | 'pipeline.failed'
  | 'plugin.loaded'
  | 'plugin.skipped'
  | 'plugin.hook.error'
  | 'plugin.io.error'
  | 'control.action.applied'
  | 'control.action.failed';

export interface AuditRow {
  id: number;
  at: string;
  event: AuditEvent;
  actor: string;
  payload: unknown;
  row_hash: string;
  prev_hash: string;
}

const GENESIS_HASH = '0'.repeat(64);

let db: DatabaseSync | null = null;
let insertStmt: StatementSync | null = null;
let lastHashStmt: StatementSync | null = null;
let failCountStmt: StatementSync | null = null;
let lastSuccessStmt: StatementSync | null = null;
let lastEventStmt: StatementSync | null = null;
let completedInWindowStmt: StatementSync | null = null;
let firedInWindowStmt: StatementSync | null = null;

/**
 * Test hook. Swap the audit DB for an in-memory instance so tests can call
 * audit() without touching the real nyx.db (which may be locked by a
 * live sync daemon). Pass null to clear; subsequent calls will lazy-open
 * the real DB again. Production code never calls this.
 */
export function _setAuditDb(newDb: DatabaseSync | null): void {
  db = newDb;
  insertStmt = null;
  lastHashStmt = null;
  failCountStmt = null;
  lastSuccessStmt = null;
  lastEventStmt = null;
  completedInWindowStmt = null;
  firedInWindowStmt = null;
}

function open(): DatabaseSync {
  if (db && insertStmt) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
    db.exec(`PRAGMA journal_mode = WAL;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_system_audit_event ON system_audit(event);
    CREATE INDEX IF NOT EXISTS idx_system_audit_at    ON system_audit(at);
  `);
  insertStmt = db.prepare(
    `INSERT INTO system_audit (at, event, actor, payload, row_hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?)`
  );
  lastHashStmt = db.prepare(`SELECT row_hash FROM system_audit ORDER BY id DESC LIMIT 1`);
  failCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.failed' AND json_extract(payload, '$.taskId') = ?`
  );
  lastSuccessStmt = db.prepare(`SELECT at FROM system_audit WHERE event = 'task.completed' ORDER BY id DESC LIMIT 1`);
  lastEventStmt = db.prepare(`SELECT at FROM system_audit WHERE event = ? ORDER BY id DESC LIMIT 1`);
  completedInWindowStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM system_audit
     WHERE event = 'task.completed'
       AND json_extract(payload, '$.taskId') = ?
       AND at >= ? AND at < ?`
  );
  firedInWindowStmt = db.prepare(
    `SELECT DISTINCT json_extract(payload, '$.taskId') AS taskId FROM system_audit
     WHERE event IN ('task.completed', 'task.failed')
       AND at >= ? AND at < ?
       AND json_extract(payload, '$.taskId') IS NOT NULL`
  );
  return db;
}

function hashRow(at: string, event: string, actor: string, payload: string, prevHash: string): string {
  return createHash('sha256')
    .update(`${at}\n${event}\n${actor}\n${payload}\n${prevHash}`)
    .digest('hex');
}

/**
 * Append an audit row inside an IMMEDIATE transaction so the prev_hash read
 * and the row insert are atomic against any concurrent writer (including a
 * second dispatcher process that escaped the lockfile, or future tooling).
 */
export function audit(event: AuditEvent, actor: string, payload: Record<string, unknown> = {}): void {
  const d = open();
  const at = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  d.exec('BEGIN IMMEDIATE');
  try {
    const prevRow = lastHashStmt!.get() as { row_hash: string } | undefined;
    const prev = prevRow?.row_hash ?? GENESIS_HASH;
    const rowHash = hashRow(at, event, actor, payloadJson, prev);
    insertStmt!.run(at, event, actor, payloadJson, rowHash, prev);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Effective failure count for a task — counts only `task.failed` events
 * AFTER the most recent `task.failure_reset` event for the same taskId.
 *
 * The hash chain is append-only, so we don't delete past failures. Instead,
 * an operator (or automation) emits a `task.failure_reset` event when a
 * task's failure mode has been remediated; everything before that timestamp
 * stops counting toward the 3-strike abandon limit. Audit history stays intact.
 */
export function failureCountForTask(taskId: string): number {
  const d = open();
  const reset = d
    .prepare(
      `SELECT at FROM system_audit
       WHERE event = 'task.failure_reset'
         AND json_extract(payload, '$.taskId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { at: string } | undefined;
  if (reset) {
    const row = d
      .prepare(
        `SELECT COUNT(*) AS n FROM system_audit
         WHERE event = 'task.failed'
           AND json_extract(payload, '$.taskId') = ?
           AND at > ?`,
      )
      .get(taskId, reset.at) as { n: number };
    return row.n;
  }
  const row = failCountStmt!.get(taskId) as { n: number };
  return row.n;
}

/**
 * Reset the failure clock for a task. Emits an audit row; subsequent calls
 * to `failureCountForTask(taskId)` ignore failures before this point.
 */
export function resetFailureCount(taskId: string, reason: string): void {
  audit('task.failure_reset', 'admin', { taskId, reason });
}

export function lastSuccessfulTaskAt(): string | null {
  open();
  const row = lastSuccessStmt!.get() as { at: string } | undefined;
  return row?.at ?? null;
}

export function lastEventAt(event: AuditEvent): string | null {
  open();
  const row = lastEventStmt!.get(event) as { at: string } | undefined;
  return row?.at ?? null;
}

/**
 * How many audit passes have already run on `taskId` since the last
 * `task.failure_reset` (or since the beginning of time if no reset). Used by
 * the audit-runner to enforce MAX_AUDIT_PASSES.
 */
export function auditPassCountForTask(taskId: string): number {
  const d = open();
  const reset = d
    .prepare(
      `SELECT at FROM system_audit
       WHERE event = 'task.failure_reset'
         AND json_extract(payload, '$.taskId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { at: string } | undefined;
  const sql = reset
    ? `SELECT COUNT(*) AS n FROM system_audit
       WHERE event = 'task.audit.started'
         AND json_extract(payload, '$.taskId') = ?
         AND at > ?`
    : `SELECT COUNT(*) AS n FROM system_audit
       WHERE event = 'task.audit.started'
         AND json_extract(payload, '$.taskId') = ?`;
  const row = reset
    ? (d.prepare(sql).get(taskId, reset.at) as { n: number })
    : (d.prepare(sql).get(taskId) as { n: number });
  return row.n;
}

/**
 * Is `taskId` currently halted for operator review? True when the most recent
 * lifecycle row for the task is `task.halted_for_review` and no subsequent
 * `task.resumed` has cleared it.
 */
export function isTaskHalted(taskId: string): boolean {
  const d = open();
  const row = d
    .prepare(
      `SELECT event FROM system_audit
       WHERE json_extract(payload, '$.taskId') = ?
         AND event IN ('task.halted_for_review', 'task.resumed', 'task.completed', 'task.failure_reset')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { event: string } | undefined;
  return row?.event === 'task.halted_for_review';
}

/**
 * Was `taskId` already completed within [start, end)? Used to dedup slot-bound
 * tasks within their slot window so a single 15-minute slot fires each task
 * at most once even if launchd ticks twice (clock skew, DST edges).
 */
export function completedInWindow(taskId: string, start: Date, end: Date): boolean {
  open();
  const row = completedInWindowStmt!.get(taskId, start.toISOString(), end.toISOString()) as { n: number };
  return row.n > 0;
}

/**
 * IDs of all tasks that already completed OR failed in [start, end). Used to
 * skip slot-bound tasks that already had their shot this slot — including ones
 * that failed, so we don't loop on a flaky slotted task within one window.
 */
export function tasksFiredInWindow(start: Date, end: Date): Set<string> {
  open();
  const rows = firedInWindowStmt!.all(start.toISOString(), end.toISOString()) as Array<{ taskId: string | null }>;
  const out = new Set<string>();
  for (const r of rows) if (r.taskId) out.add(r.taskId);
  return out;
}

export interface ChainVerification {
  ok: boolean;
  totalRows: number;
  firstBadRowId?: number;
  reason?: string;
}

/**
 * Walk the audit table from the genesis row forward, recomputing each row's
 * hash. Bails on first mismatch. Used at dispatcher startup as an integrity check.
 */
export function verifyChain(): ChainVerification {
  const d = open();
  const rows = d
    .prepare(`SELECT id, at, event, actor, payload, row_hash, prev_hash FROM system_audit ORDER BY id ASC`)
    .all() as Array<{ id: number; at: string; event: string; actor: string; payload: string; row_hash: string; prev_hash: string }>;

  let expectedPrev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, totalRows: rows.length, firstBadRowId: row.id, reason: 'prev_hash mismatch' };
    }
    const recomputed = hashRow(row.at, row.event, row.actor, row.payload, row.prev_hash);
    if (recomputed !== row.row_hash) {
      return { ok: false, totalRows: rows.length, firstBadRowId: row.id, reason: 'row_hash mismatch' };
    }
    expectedPrev = row.row_hash;
  }
  return { ok: true, totalRows: rows.length };
}
