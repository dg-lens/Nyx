/**
 * Local control surface — the `pending_actions` mutable table in Data/. Any
 * producer (the Slack plugin via Socket Mode, the desktop app, the CLI) writes
 * a row; the dispatcher drains it each tick. The local, SQLite equivalent of
 * the extracted remote-actions pattern. See docs/plugin-architecture.md.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from '../config.js';
import { openDb } from '../db.js';

export type ActionKind =
  | 'queue_task'
  | 'resume_task'
  | 'pipeline_decision'
  | 'force_tick'
  | 'decompose_task'
  | 'compose_template'
  | 'respond_message';
export type ActionStatus = 'pending' | 'applied' | 'failed';

export interface PendingAction {
  id: number;
  action: ActionKind;
  params: Record<string, unknown>;
  source: string;
  status: ActionStatus;
  result: string | null;
  created_at: number;
  applied_at: number | null;
}

let db: DatabaseSync | null = null;
let prepared = false;

/** Test hook — swap in an in-memory DB. Mirrors `_setPipelineDb`. */
export function _setControlDb(newDb: DatabaseSync | null): void {
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
    CREATE TABLE IF NOT EXISTS pending_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      params      TEXT NOT NULL,
      source      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      result      TEXT,
      created_at  INTEGER NOT NULL,
      applied_at  INTEGER
    );
  `);
  prepared = true;
  return db;
}

function rowToAction(r: Record<string, unknown>): PendingAction {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse((r.params as string) ?? '{}') as Record<string, unknown>;
  } catch {
    params = {};
  }
  return {
    id: Number(r.id),
    action: r.action as ActionKind,
    params,
    source: r.source as string,
    status: r.status as ActionStatus,
    result: (r.result as string | null) ?? null,
    created_at: Number(r.created_at),
    applied_at: r.applied_at == null ? null : Number(r.applied_at),
  };
}

export function enqueueAction(action: ActionKind, params: Record<string, unknown>, source: string, now: number): number {
  const info = open()
    .prepare(`INSERT INTO pending_actions (action, params, source, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
    .run(action, JSON.stringify(params), source, now);
  return Number(info.lastInsertRowid);
}

export function listPending(): PendingAction[] {
  const rows = open()
    .prepare(`SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY id ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToAction);
}

export function markApplied(id: number, result: string, now: number): void {
  open().prepare(`UPDATE pending_actions SET status='applied', result=?, applied_at=? WHERE id=?`).run(result, now, id);
}

export function markFailed(id: number, result: string, now: number): void {
  open().prepare(`UPDATE pending_actions SET status='failed', result=?, applied_at=? WHERE id=?`).run(result, now, id);
}

export function getAction(id: number): PendingAction | null {
  const r = open().prepare(`SELECT * FROM pending_actions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToAction(r) : null;
}

/**
 * Contact-surface rate guard: count how many `respond_message` actions naming this
 * member Nyx has ALREADY accepted (status='applied' — i.e. queued a NYX-RESPOND
 * task) within the sliding window `[since, +∞)`. A hostile or malfunctioning member
 * flooding DMs would otherwise fan out unbounded pending_actions → unbounded queued
 * tasks → unbounded paid spawns; respondMessage drops anything over the cap.
 *
 * We count APPLIED rows (not pending) because the drain loop marks each row applied
 * as it processes it: when row N is being handled, the earlier same-member rows in
 * this same drain are already applied. A row that was itself rate-limited is marked
 * applied too but did NOT queue a task — its result starts `rate-limited` — so it is
 * excluded here; the cap counts ACCEPTED responds, not attempts. JSON-extracting
 * `member` from params keeps this a single scan with no schema change. The window is
 * keyed on created_at (when the inbound message arrived), so the cap is "N accepted
 * in the last window" and survives across ticks.
 */
export function countRecentRespondsForMember(member: string, since: number): number {
  const row = open()
    .prepare(
      `SELECT COUNT(*) AS n FROM pending_actions
         WHERE action = 'respond_message'
           AND status = 'applied'
           AND created_at >= ?
           AND json_extract(params, '$.member') = ?
           AND (result IS NULL OR result NOT LIKE 'rate-limited%')`,
    )
    .get(since, member) as { n: number } | undefined;
  return row ? Number(row.n) : 0;
}
