import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb, audit, verifyChain, verifyChainPeriodic } from '../src/audit.js';

let db: DatabaseSync;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function rows(): Array<{ id: number; event: string; payload: string; row_hash: string; prev_hash: string }> {
  return db
    .prepare(`SELECT id, event, payload, row_hash, prev_hash FROM system_audit ORDER BY id ASC`)
    .all() as Array<{ id: number; event: string; payload: string; row_hash: string; prev_hash: string }>;
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
});

afterEach(() => {
  _setAuditDb(null);
  db.close();
});

describe('verifyChain incremental vs fromGenesis', () => {
  test('clean chain verifies both ways', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    audit('dispatch.tick', 'test', { n: 2 });
    audit('dispatch.tick', 'test', { n: 3 });
    assert.equal(verifyChain().ok, true);
    assert.equal(verifyChain({ fromGenesis: true }).ok, true);
  });

  test('fromGenesis catches a tampered row that the incremental checkpoint hides', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    audit('dispatch.tick', 'test', { n: 2 });
    audit('dispatch.tick', 'test', { n: 3 });

    const before = verifyChain();
    assert.equal(before.ok, true);

    const all = rows();
    const victim = all[1]!;
    const forged = JSON.stringify({ n: 'TAMPERED' });
    db.prepare(`UPDATE system_audit SET payload = ? WHERE id = ?`).run(forged, victim.id);

    db.prepare(
      `INSERT INTO system_audit_chainpoint (id, last_id, last_hash) VALUES (0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash`,
    ).run(all[all.length - 1]!.id, all[all.length - 1]!.row_hash);

    const incremental = verifyChain();
    assert.equal(incremental.ok, true, 'incremental trusts the bumped checkpoint and misses the tamper');

    const full = verifyChain({ fromGenesis: true });
    assert.equal(full.ok, false, 'fromGenesis re-hashes every row and catches the tamper');
    assert.equal(full.firstBadRowId, victim.id);
  });
});

describe('verifyChainPeriodic', () => {
  test('first call on a fresh chain runs a full walk and stamps last_full_at', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    const r = verifyChainPeriodic({ now: 1_000 });
    assert.equal(r.ok, true);
    assert.equal(r.wasFull, true, 'a never-verified chain forces a full walk');
    const cp = db.prepare(`SELECT last_full_at FROM system_audit_chainpoint WHERE id = 0`).get() as { last_full_at: string | null };
    assert.ok(cp.last_full_at, 'last_full_at recorded after a full walk');
  });

  test('within the interval the next call is incremental, not full', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    const first = verifyChainPeriodic({ now: t0 });
    assert.equal(first.wasFull, true);

    audit('dispatch.tick', 'test', { n: 2 });
    const soon = verifyChainPeriodic({ now: t0 + HOUR_MS });
    assert.equal(soon.ok, true);
    assert.equal(soon.wasFull, false, 'a recent full walk means the next tick stays incremental');
  });

  test('after the interval elapses the next call forces a full walk again', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    verifyChainPeriodic({ now: t0 });

    audit('dispatch.tick', 'test', { n: 2 });
    const later = verifyChainPeriodic({ now: t0 + DAY_MS + HOUR_MS });
    assert.equal(later.ok, true);
    assert.equal(later.wasFull, true, 'past the daily interval the full walk runs again');
  });

  test('forceFull overrides the interval', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    const t0 = Date.parse('2026-06-01T00:00:00Z');
    verifyChainPeriodic({ now: t0 });

    audit('dispatch.tick', 'test', { n: 2 });
    const forced = verifyChainPeriodic({ now: t0 + HOUR_MS, forceFull: true });
    assert.equal(forced.wasFull, true);
  });

  test('a periodic full walk catches sub-checkpoint tampering the incremental path would miss', () => {
    audit('dispatch.tick', 'test', { n: 1 });
    audit('dispatch.tick', 'test', { n: 2 });
    audit('dispatch.tick', 'test', { n: 3 });

    const t0 = Date.parse('2026-06-01T00:00:00Z');
    verifyChainPeriodic({ now: t0 });

    const all = rows();
    const victim = all[1]!;
    db.prepare(`UPDATE system_audit SET payload = ? WHERE id = ?`).run(JSON.stringify({ n: 'X' }), victim.id);
    db.prepare(
      `INSERT INTO system_audit_chainpoint (id, last_id, last_hash) VALUES (0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash`,
    ).run(all[all.length - 1]!.id, all[all.length - 1]!.row_hash);

    const incremental = verifyChainPeriodic({ now: t0 + HOUR_MS });
    assert.equal(incremental.wasFull, false);
    assert.equal(incremental.ok, true, 'within interval, incremental still trusts the bumped checkpoint');

    const due = verifyChainPeriodic({ now: t0 + DAY_MS + HOUR_MS });
    assert.equal(due.wasFull, true);
    assert.equal(due.ok, false, 'the daily full walk exposes the tamper');
    assert.equal(due.firstBadRowId, victim.id);
  });
});
