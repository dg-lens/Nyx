import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { config } from './config.js';
import type { AuditRowToSync } from './supabase.js';

/**
 * Read-only access to the dispatcher's audit DB. The sync daemon never writes
 * here — the dispatcher owns it. Open the SQLite file in read-only mode so a
 * bug in this daemon can't corrupt the chain.
 */

let db: DatabaseSync | null = null;
let stmtNewer: StatementSync | null = null;
let stmtCount: StatementSync | null = null;
let stmtLatest: StatementSync | null = null;
let stmtLastSuccess: StatementSync | null = null;
let stmtRates: StatementSync | null = null;
let stmtAll: StatementSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  if (!existsSync(config.dbPath)) {
    throw new Error(`audit DB not found at ${config.dbPath} — has the dispatcher run yet?`);
  }
  db = new DatabaseSync(config.dbPath, { readOnly: true });
  stmtNewer = db.prepare(
    `SELECT id, at, event, actor, payload, row_hash, prev_hash
     FROM system_audit WHERE id > ? ORDER BY id ASC LIMIT ?`,
  );
  stmtCount = db.prepare(`SELECT COUNT(*) AS n FROM system_audit`);
  stmtLatest = db.prepare(`SELECT at FROM system_audit WHERE event = 'dispatch.tick' ORDER BY id DESC LIMIT 1`);
  stmtLastSuccess = db.prepare(`SELECT at FROM system_audit WHERE event = 'task.completed' ORDER BY id DESC LIMIT 1`);
  stmtRates = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM system_audit WHERE event = 'task.completed' AND at > ?) AS c,
       (SELECT COUNT(*) FROM system_audit WHERE event = 'task.failed'    AND at > ?) AS f`,
  );
  stmtAll = db.prepare(`SELECT at, event, actor, payload, row_hash, prev_hash FROM system_audit ORDER BY id ASC`);
  return db;
}

export interface AuditDbRow {
  id: number;
  at: string;
  event: string;
  actor: string;
  payload: string; // SQLite stores as TEXT — parsed downstream
  row_hash: string;
  prev_hash: string;
}

export function readRowsAfter(lastId: number, limit: number): AuditDbRow[] {
  open();
  return stmtNewer!.all(lastId, limit) as unknown as AuditDbRow[];
}

export function rowsForSupabase(rows: AuditDbRow[]): AuditRowToSync[] {
  return rows.map(r => ({
    id: r.id,
    at: r.at,
    event: r.event,
    actor: r.actor,
    payload: r.payload, // pushAuditRows will JSON.parse
    row_hash: r.row_hash,
    prev_hash: r.prev_hash,
  }));
}

export function totalRows(): number {
  open();
  const row = stmtCount!.get() as { n: number };
  return row.n;
}

export function lastTickAt(): string | null {
  open();
  const row = stmtLatest!.get() as { at: string } | undefined;
  return row?.at ?? null;
}

export function lastSuccessAt(): string | null {
  open();
  const row = stmtLastSuccess!.get() as { at: string } | undefined;
  return row?.at ?? null;
}

export function successRate24h(): number | null {
  open();
  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const row = stmtRates!.get(cutoff, cutoff) as { c: number; f: number };
  const total = row.c + row.f;
  if (total === 0) return null;
  return row.c / total;
}

/**
 * Walk the full chain and recompute hashes. Bails on first mismatch.
 * Used by the sync daemon to surface chain corruption into Supabase so the
 * dashboard can show a red banner without the operator on the Mac noticing.
 */
const GENESIS = '0'.repeat(64);

export function verifyChain(): { ok: boolean; firstBadRowId?: number } {
  open();
  const rows = stmtAll!.all() as unknown as AuditDbRow[];
  let expected = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== expected) return { ok: false, firstBadRowId: r.id };
    const h = createHash('sha256').update(`${r.at}\n${r.event}\n${r.actor}\n${r.payload}\n${r.prev_hash}`).digest('hex');
    if (h !== r.row_hash) return { ok: false, firstBadRowId: r.id };
    expected = r.row_hash;
  }
  return { ok: true };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
