/**
 * Durable off-hours digest store (Track 6, N4).
 *
 * The notifier's `deliver()` gate decides per send whether a message goes out
 * live. When `shouldDeliver` says no for a reason that is "quiet now, not
 * never" — a `digest` category, or a `workflow`/`workhours` category outside
 * its window — the message is BATCHED here instead of dropped (plan decision
 * #1: suppressed ≠ dropped). At the next working-window start (a rising edge of
 * `isWorkflowActive`, which covers both a scheduled window opening and a manual
 * "working late" override being armed) the batch is flushed as a single
 * "what you missed" summary and cleared.
 *
 * State is two tables in the shared nyx.db (mutable, NOT hash-chained — the
 * append-only record is the `notification.digest.*` audit events). The digest
 * must survive a dispatcher restart between off-hours and the next window, so a
 * file-backed store is required, not an in-process buffer: the daemon is a
 * fresh launchd process every tick. Schema is idempotent; safe on every open.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';
import { openDb } from './db.js';
import type { NotificationCategory } from './settings.js';

export interface DigestItem {
  id: number;
  at: string;
  category: NotificationCategory;
  text: string;
}

let db: DatabaseSync | null = null;
let prepared = false;
let insertStmt: StatementSync | null = null;
let listStmt: StatementSync | null = null;
let clearStmt: StatementSync | null = null;
let countStmt: StatementSync | null = null;
let readStateStmt: StatementSync | null = null;
let writeStateStmt: StatementSync | null = null;

/**
 * Test hook — swap in an in-memory DB. Mirrors `_setAuditDb` / `_setPipelineDb`.
 * Production code never calls this.
 */
export function _setDigestDb(newDb: DatabaseSync | null): void {
  db = newDb;
  prepared = false;
  insertStmt = null;
  listStmt = null;
  clearStmt = null;
  countStmt = null;
  readStateStmt = null;
  writeStateStmt = null;
}

function open(): DatabaseSync {
  if (db && prepared) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  // notification_digest_state is a single-row (id = 0) edge tracker: `was_active`
  // is the last-observed Workflow state so the tick can detect the inactive→active
  // rising edge that triggers a flush, and `last_flush_at` records the most recent
  // flush so the flush fires once per window, not once per 5-min tick inside it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_digest (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      category  TEXT    NOT NULL,
      text      TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_digest_at ON notification_digest(id);
    CREATE TABLE IF NOT EXISTS notification_digest_state (
      id            INTEGER PRIMARY KEY CHECK (id = 0),
      was_active    INTEGER NOT NULL DEFAULT 0,
      last_flush_at TEXT
    );
  `);
  insertStmt = db.prepare(`INSERT INTO notification_digest (at, category, text) VALUES (?, ?, ?)`);
  listStmt = db.prepare(`SELECT id, at, category, text FROM notification_digest ORDER BY id ASC`);
  clearStmt = db.prepare(`DELETE FROM notification_digest`);
  countStmt = db.prepare(`SELECT COUNT(*) AS n FROM notification_digest`);
  readStateStmt = db.prepare(`SELECT was_active, last_flush_at FROM notification_digest_state WHERE id = 0`);
  writeStateStmt = db.prepare(
    `INSERT INTO notification_digest_state (id, was_active, last_flush_at) VALUES (0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET was_active = excluded.was_active, last_flush_at = excluded.last_flush_at`,
  );
  prepared = true;
  return db;
}

/** Append one suppressed message to the batch. Never drops — this IS the no-drop guarantee. */
export function batchDigestItem(category: NotificationCategory, text: string): void {
  open();
  insertStmt!.run(new Date().toISOString(), category, text);
}

/** Every batched item, oldest first. */
export function pendingDigestItems(): DigestItem[] {
  open();
  return listStmt!.all() as unknown as DigestItem[];
}

export function pendingDigestCount(): number {
  open();
  return (countStmt!.get() as { n: number }).n;
}

/** Drop the whole batch. Called only after a successful flush. */
export function clearDigestBatch(): void {
  open();
  clearStmt!.run();
}

export interface DigestState {
  wasActive: boolean;
  lastFlushAt: string | null;
}

export function readDigestState(): DigestState {
  open();
  const row = readStateStmt!.get() as { was_active: number; last_flush_at: string | null } | undefined;
  return { wasActive: row ? row.was_active === 1 : false, lastFlushAt: row?.last_flush_at ?? null };
}

export function writeDigestState(state: DigestState): void {
  open();
  writeStateStmt!.run(state.wasActive ? 1 : 0, state.lastFlushAt);
}

/**
 * Render the batch into one "what you missed" Slack/Pushover message, grouped by
 * category in a fixed urgency order so the operator scans the important rows
 * first. Pure — the caller passes the items so the tick can format then clear in
 * one transaction-free pass.
 */
const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  'action-required': 'Needs you',
  failure: 'Failures',
  delivery: 'Delivered',
  status: 'Status',
};
const CATEGORY_ORDER: NotificationCategory[] = ['action-required', 'failure', 'delivery', 'status'];

export function formatDigest(items: DigestItem[], systemName: string): string {
  const header = `📥 ${systemName} — what you missed while you were away (${items.length} item${items.length === 1 ? '' : 's'})`;
  const lines: string[] = [header];
  for (const cat of CATEGORY_ORDER) {
    const inCat = items.filter((it) => it.category === cat);
    if (inCat.length === 0) continue;
    lines.push('', `*${CATEGORY_LABEL[cat]}* (${inCat.length})`);
    for (const it of inCat) lines.push(`  • ${it.text}`);
  }
  return lines.join('\n');
}
