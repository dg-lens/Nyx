import { openSecretsDb } from './db-schema.js';

/**
 * Query helpers for the rotation calendar. Splits "due_in_days" buckets server-
 * side so the assistant template (apps/assistant/src/rotation-check.ts) gets a
 * pre-shaped list and doesn't need to know about Date math in SQL.
 */

export interface RotationRow {
  project_name: string;
  secret_key: string;
  created_at: number;
  rotates_in_days: number;
  owner: string;
  rotation_url: string | null;
  rotation_steps: string | null;
  notes: string | null;
  /** Computed at query time: days remaining until rotation (negative = overdue). */
  days_remaining: number;
}

/**
 * Returns rows where the rotation deadline is within `windowDays` days of now,
 * INCLUDING overdue rows (negative days_remaining). Ordered by deadline ascending
 * so the most-urgent rotations come first.
 */
export function rotationsDueWithin(windowDays = 7, now: number = Date.now()): RotationRow[] {
  const db = openSecretsDb();
  const nowSec = Math.floor(now / 1000);
  const windowSec = windowDays * 86400;
  const rows = db
    .prepare(
      `SELECT project_name, secret_key, created_at, rotates_in_days,
              owner, rotation_url, rotation_steps, notes
         FROM secret_rotations
        WHERE ((created_at / 1000) + (rotates_in_days * 86400)) - ? <= ?
        ORDER BY ((created_at / 1000) + (rotates_in_days * 86400)) ASC`,
    )
    .all(nowSec, windowSec) as unknown as Array<{
    project_name: string;
    secret_key: string;
    created_at: number;
    rotates_in_days: number;
    owner: string;
    rotation_url: string | null;
    rotation_steps: string | null;
    notes: string | null;
  }>;
  return rows.map(r => {
    const dueAtSec = Math.floor(r.created_at / 1000) + r.rotates_in_days * 86400;
    const daysRemaining = Math.round((dueAtSec - nowSec) / 86400);
    return { ...r, days_remaining: daysRemaining };
  });
}

export interface RotationGroups {
  overdue: RotationRow[];
  dueThisWeek: RotationRow[];
  total: number;
}

export function groupRotations(rows: RotationRow[]): RotationGroups {
  const overdue = rows.filter(r => r.days_remaining < 0);
  const dueThisWeek = rows.filter(r => r.days_remaining >= 0 && r.days_remaining <= 7);
  return { overdue, dueThisWeek, total: rows.length };
}
