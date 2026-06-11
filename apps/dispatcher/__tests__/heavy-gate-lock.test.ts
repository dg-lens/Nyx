/**
 * Unit tests for the machine-wide heavy-gate lock (heavy-gate-lock.ts).
 *
 * The lock is a mkdir-spinlock with a pid file + stale-owner recovery — the
 * nyx-dispatch.sh tick-lock pattern. Everything here runs against a throwaway
 * tmpdir lock path; the real $NYX_DATA_DIR/run/heavy-gate.lock is never touched.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { acquireHeavyGateLock } from '../src/heavy-gate-lock.js';

// Far above any OS pid_max (macOS ~99998, Linux default 4194304) — kill(pid, 0)
// is ESRCH, so the liveness probe reads this owner as dead.
const DEAD_PID = 99_999_999;

describe('acquireHeavyGateLock', () => {
  let base: string;
  let lockDir: string;

  beforeEach(() => {
    base = mkdtempSync(resolve(tmpdir(), 'heavy-gate-lock-'));
    lockDir = resolve(base, 'run', 'heavy-gate.lock');
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('acquires a free lock, records its pid, and release removes the dir', () => {
    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    assert.equal(lock.timedOut, false);
    assert.equal(readFileSync(resolve(lockDir, 'pid'), 'utf8'), String(process.pid));

    lock.release();
    assert.equal(existsSync(lockDir), false);
    lock.release(); // idempotent

    const again = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(again.acquired, true);
    again.release();
  });

  test('a live owner holds the lock: contender times out, proceeds, and never removes the foreign lock', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), String(process.pid)); // alive — this very process

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 250, pollMs: 50 });
    assert.equal(lock.acquired, false);
    assert.equal(lock.timedOut, true);
    assert.ok(lock.waitedMs >= 200, `waited ${lock.waitedMs}ms, expected ~250ms of polling`);

    lock.release(); // must be a no-op on a timed-out handle
    assert.equal(existsSync(lockDir), true);
    assert.equal(readFileSync(resolve(lockDir, 'pid'), 'utf8'), String(process.pid));
  });

  test('recovers a stale lock whose recorded owner is dead', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), String(DEAD_PID));

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    assert.ok(lock.waitedMs < 500, 'stale recovery is immediate, not a poll-out');
    assert.equal(readFileSync(resolve(lockDir, 'pid'), 'utf8'), String(process.pid));
    lock.release();
  });

  test('recovers a husk with no pid file (owner crashed in its mkdir→write window)', () => {
    mkdirSync(lockDir, { recursive: true });

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    assert.equal(readFileSync(resolve(lockDir, 'pid'), 'utf8'), String(process.pid));
    lock.release();
  });

  test('a malformed pid file is treated as stale', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), 'not-a-pid');

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    lock.release();
  });

  test('creates the parent run/ directory when absent', () => {
    assert.equal(existsSync(resolve(base, 'run')), false);
    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    lock.release();
  });
});
