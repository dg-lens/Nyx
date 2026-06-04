import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setSecretsDb } from '../src/secrets/db-schema.js';
import { groupRotations, rotationsDueWithin } from '../src/secrets/rotation-query.js';

let db: DatabaseSync;

const DAY_MS = 86_400_000;
const NOW = new Date('2026-05-19T12:00:00Z').getTime();

function seed(project: string, key: string, createdMsAgo: number, rotates_in_days: number, owner = 'test'): void {
  db.prepare(
    `INSERT INTO secret_rotations
       (project_name, secret_key, created_at, rotates_in_days, owner)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(project, key, NOW - createdMsAgo, rotates_in_days, owner);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE secret_rotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rotates_in_days INTEGER NOT NULL DEFAULT 90,
      owner TEXT NOT NULL,
      rotation_url TEXT,
      rotation_steps TEXT,
      notes TEXT,
      UNIQUE(project_name, secret_key)
    );
  `);
  _setSecretsDb(db);
});
afterEach(() => {
  _setSecretsDb(null);
  db.close();
});

describe('rotationsDueWithin / groupRotations', () => {
  test('returns nothing when the calendar is empty', () => {
    const rows = rotationsDueWithin(7, NOW);
    assert.deepEqual(rows, []);
    const groups = groupRotations(rows);
    assert.equal(groups.total, 0);
    assert.equal(groups.overdue.length, 0);
    assert.equal(groups.dueThisWeek.length, 0);
  });

  test('correctly buckets overdue vs due-this-week vs far-future', () => {
    // overdue by ~3 days: created 93 days ago with 90-day rotation
    seed('nyx', 'ANTHROPIC_API_KEY', 93 * DAY_MS, 90);
    // due in ~4 days
    seed('lens', 'SUPABASE_SERVICE_ROLE_KEY', 56 * DAY_MS, 60);
    // far future — 60 days out
    seed('lens', 'STRIPE_SECRET', 30 * DAY_MS, 90);

    const rows = rotationsDueWithin(7, NOW);
    // Only the first two should appear within the 7-day window
    assert.equal(rows.length, 2);
    const groups = groupRotations(rows);
    assert.equal(groups.overdue.length, 1);
    assert.equal(groups.overdue[0]!.secret_key, 'ANTHROPIC_API_KEY');
    assert.equal(groups.overdue[0]!.days_remaining, -3);

    assert.equal(groups.dueThisWeek.length, 1);
    assert.equal(groups.dueThisWeek[0]!.secret_key, 'SUPABASE_SERVICE_ROLE_KEY');
    assert.equal(groups.dueThisWeek[0]!.days_remaining, 4);
  });

  test('sorted by deadline ascending (most-urgent first)', () => {
    seed('a', 'x', 100 * DAY_MS, 90); // overdue 10 days
    seed('b', 'y', 95 * DAY_MS, 90);  // overdue 5 days
    seed('c', 'z', 86 * DAY_MS, 90);  // due in 4 days
    const rows = rotationsDueWithin(7, NOW);
    const keys = rows.map(r => r.secret_key);
    assert.deepEqual(keys, ['x', 'y', 'z']);
  });
});
