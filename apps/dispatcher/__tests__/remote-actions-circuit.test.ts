/**
 * Circuit-breaker tests for the remote-actions poller.
 *
 * Strategy:
 *   - _setCircuitPath → temp dir so state doesn't touch real data/
 *   - _setSupabaseConfig → bypasses the frozen `config` object (which is
 *     evaluated once at module load; test env has no real creds)
 *   - _setAuditDb → in-memory SQLite so audit() calls don't hit nyx.db
 *   - globalThis.fetch → overridden per-test to simulate 404 / 200 / 500
 *
 * Scenarios covered:
 *   1. 3 consecutive 404s trip the circuit (circuit_open emitted, disabled=true)
 *   2. While disabled, circuit_skipped is emitted and fetch is not called
 *   3. Disabled circuit stays skipped even after >1h (no auto-probe)
 *   4. Disabled circuit never triggers fetch even after probe window elapsed
 *   5. Non-404 HTTP errors leave circuit state untouched
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import {
  _clearSupabaseConfig,
  _setCircuitPath,
  _setSupabaseConfig,
  processRemoteActions,
} from '../src/remote-actions.js';

// ────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ────────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let circuitFile: string;
let memDb: DatabaseSync;
let originalFetch: typeof fetch;

function setupAuditDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
    CREATE INDEX idx_system_audit_event ON system_audit(event);
    CREATE INDEX idx_system_audit_at    ON system_audit(at);
  `);
  return db;
}

function auditEvents(db: DatabaseSync): string[] {
  return (db.prepare('SELECT event FROM system_audit ORDER BY id').all() as Array<{ event: string }>).map(
    (r) => r.event,
  );
}

function mockFetch(status: number, body: unknown = []): typeof fetch {
  return () =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Internal Server Error',
      json: () => Promise.resolve(body),
    } as Response);
}

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-circuit-test-'));
  circuitFile = resolve(tmpDir, 'remote-actions-circuit.json');
  _setCircuitPath(circuitFile);

  memDb = setupAuditDb();
  _setAuditDb(memDb);

  _setSupabaseConfig('https://test.supabase.co', 'test-key');

  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setAuditDb(null);
  _clearSupabaseConfig();
  // Reset circuit path to default (doesn't matter — each test gets a fresh tmpDir)
  _setCircuitPath(resolve(tmpDir, 'remote-actions-circuit.json'));
  rmSync(tmpDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Three consecutive 404s trip the circuit
// ────────────────────────────────────────────────────────────────────────────

describe('3 consecutive 404s open the circuit', () => {
  test('first 404 emits fetch.not_found but does not open circuit', async () => {
    globalThis.fetch = mockFetch(404);
    await processRemoteActions();

    const events = auditEvents(memDb);
    assert.ok(events.includes('remote.actions.fetch.not_found'), 'fetch.not_found must fire');
    assert.ok(!events.includes('remote.actions.circuit_open'), 'circuit must not open after 1 failure');

    const state = JSON.parse(readFileSync(circuitFile, 'utf8'));
    assert.equal(state.consecutive404s, 1);
    assert.equal(state.openedAt, null);
  });

  test('second 404 increments counter but does not open circuit', async () => {
    globalThis.fetch = mockFetch(404);
    await processRemoteActions();
    await processRemoteActions();

    const state = JSON.parse(readFileSync(circuitFile, 'utf8'));
    assert.equal(state.consecutive404s, 2);
    assert.equal(state.openedAt, null);
  });

  test('third 404 opens the circuit and emits circuit_open', async () => {
    globalThis.fetch = mockFetch(404);
    await processRemoteActions();
    await processRemoteActions();
    await processRemoteActions();

    const events = auditEvents(memDb);
    assert.ok(events.includes('remote.actions.circuit_open'), 'circuit_open must fire on 3rd 404');

    const state = JSON.parse(readFileSync(circuitFile, 'utf8'));
    assert.equal(state.consecutive404s, 3);
    assert.ok(state.disabled === true, 'disabled must be set on circuit open');
    assert.ok(typeof state.openedAt === 'string', 'openedAt must be set');
    assert.ok(typeof state.lastFailedAt === 'string', 'lastFailedAt must be set');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. While circuit is open, circuit_skipped fires and fetch is NOT called
// ────────────────────────────────────────────────────────────────────────────

describe('open circuit skips fetch', () => {
  async function openCircuit(): Promise<void> {
    globalThis.fetch = mockFetch(404);
    await processRemoteActions();
    await processRemoteActions();
    await processRemoteActions();
    memDb.exec('DELETE FROM system_audit'); // clear events so we can assert cleanly
  }

  test('circuit_skipped is emitted and fetch is not called while circuit is open', async () => {
    await openCircuit();

    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return mockFetch(200)('' as never, undefined as never);
    };

    await processRemoteActions();

    const events = auditEvents(memDb);
    assert.ok(events.includes('remote.actions.circuit_skipped'), 'circuit_skipped must fire');
    assert.ok(!fetchCalled, 'fetch must not be called while circuit is open');
  });

  test('circuit_skipped includes openedAt and consecutive404s in payload', async () => {
    await openCircuit();
    globalThis.fetch = mockFetch(200);

    await processRemoteActions();

    const row = memDb
      .prepare(`SELECT payload FROM system_audit WHERE event = 'remote.actions.circuit_skipped' LIMIT 1`)
      .get() as { payload: string } | undefined;
    assert.ok(row, 'circuit_skipped row must exist');
    const payload = JSON.parse(row.payload);
    assert.equal(payload.consecutive404s, 3);
    assert.ok(typeof payload.openedAt === 'string', 'openedAt must be in payload');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Disabled circuit stays skipped even after >1h (no auto-probe)
// ────────────────────────────────────────────────────────────────────────────

describe('disabled circuit stays skipped (no auto-probe)', () => {
  test('circuit_skipped is emitted and fetch is not called even when openedAt is >1h ago', async () => {
    const openedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const stateBeforeProbe = { consecutive404s: 3, disabled: true, openedAt, lastFailedAt: openedAt };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(circuitFile, JSON.stringify(stateBeforeProbe), 'utf8');

    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return mockFetch(200)('' as never, undefined as never);
    };

    await processRemoteActions();

    const events = auditEvents(memDb);
    assert.ok(events.includes('remote.actions.circuit_skipped'), 'circuit_skipped must fire');
    assert.ok(!events.includes('remote.actions.circuit_reset'), 'circuit_reset must NOT fire — no auto-probe');
    assert.ok(!fetchCalled, 'fetch must not be called even after probe window elapsed');
    assert.ok(existsSync(circuitFile), 'circuit state file must persist until operator deletes it');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Disabled circuit never triggers fetch even after probe window elapsed
// ────────────────────────────────────────────────────────────────────────────

describe('disabled circuit never auto-probes', () => {
  test('no fetch and no circuit_open re-fire after probe window elapsed', async () => {
    const oldOpenedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const stateBeforeProbe = { consecutive404s: 3, disabled: true, openedAt: oldOpenedAt, lastFailedAt: oldOpenedAt };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(circuitFile, JSON.stringify(stateBeforeProbe), 'utf8');

    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      return mockFetch(404)('' as never, undefined as never);
    };

    await processRemoteActions();

    const events = auditEvents(memDb);
    assert.ok(!fetchCalled, 'fetch must not be called even after probe window elapsed');
    assert.ok(events.includes('remote.actions.circuit_skipped'), 'circuit_skipped must fire');
    assert.ok(!events.includes('remote.actions.circuit_open'), 'circuit_open must NOT re-fire — no auto-probe');

    // State must remain unchanged
    const state = JSON.parse(readFileSync(circuitFile, 'utf8'));
    assert.equal(state.consecutive404s, 3, 'consecutive404s must not change');
    assert.equal(state.openedAt, oldOpenedAt, 'openedAt must not change');
    assert.equal(state.disabled, true, 'disabled must remain true');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Non-404 HTTP errors leave circuit state untouched
// ────────────────────────────────────────────────────────────────────────────

describe('non-404 errors do not touch circuit state', () => {
  test('500 error emits fetch.failed and does not create the state file', async () => {
    globalThis.fetch = mockFetch(500);
    await processRemoteActions();

    const events = auditEvents(memDb);
    assert.ok(events.includes('remote.actions.fetch.failed'), 'fetch.failed must fire for non-404 errors');
    assert.ok(!events.includes('remote.actions.fetch.not_found'), 'fetch.not_found must NOT fire for 500');
    assert.ok(!existsSync(circuitFile), 'circuit state file must not be created for non-404 errors');
  });

  test('500 error after 2 sub-threshold 404s leaves counter unchanged', async () => {
    globalThis.fetch = mockFetch(404);
    await processRemoteActions();
    await processRemoteActions();

    const stateBefore = JSON.parse(readFileSync(circuitFile, 'utf8'));
    assert.equal(stateBefore.consecutive404s, 2);

    globalThis.fetch = mockFetch(500);
    await processRemoteActions();

    // State file still exists with the same counter — 500 doesn't touch it
    const stateAfter = JSON.parse(readFileSync(circuitFile, 'utf8'));
    assert.equal(stateAfter.consecutive404s, 2, '500 must not change the 404 counter');
  });
});
