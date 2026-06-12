/**
 * Unit tests for the machine-wide heavy-gate lock (heavy-gate-lock.ts).
 *
 * The lock is a mkdir-spinlock with a pid file + stale-owner recovery — the
 * nyx-dispatch.sh tick-lock pattern. Everything here runs against a throwaway
 * tmpdir lock path; the real $NYX_DATA_DIR/run/heavy-gate.lock is never touched.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { acquireHeavyGateLock } from '../src/heavy-gate-lock.js';

// Far above any OS pid_max (macOS ~99998, Linux default 4194304) — kill(pid, 0)
// is ESRCH, so the liveness probe reads this owner as dead.
const DEAD_PID = 99_999_999;

function lstartOf(pid: number): string {
  return spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

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
    assert.equal(lock.ownerPid, process.pid, 'timed-out handle carries the foreign owner pid for the audit payload');

    lock.release(); // must be a no-op on a timed-out handle
    assert.equal(existsSync(lockDir), true);
    assert.equal(readFileSync(resolve(lockDir, 'pid'), 'utf8'), String(process.pid));
  });

  test('a live owner with a MATCHING start-time stamp holds the lock (identity guard confirms it)', () => {
    const started = lstartOf(process.pid);
    assert.notEqual(started, '', 'ps -o lstart= must work on this platform');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), String(process.pid));
    writeFileSync(resolve(lockDir, 'started'), started);

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 250, pollMs: 50 });
    assert.equal(lock.acquired, false);
    assert.equal(lock.timedOut, true);
    assert.equal(existsSync(lockDir), true);
  });

  test('PID reuse: a live pid whose start time mismatches the stamp is a recycled pid — stale, reclaimed', () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), String(process.pid)); // signalable and live…
    writeFileSync(resolve(lockDir, 'started'), 'Mon Jan  1 00:00:00 2001'); // …but not the process that locked

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    assert.ok(lock.waitedMs < 500, 'recycled-pid recovery is immediate, not a poll-out');
    assert.equal(readFileSync(resolve(lockDir, 'pid'), 'utf8'), String(process.pid));
    lock.release();
  });

  test('EPERM owner (another user\'s pid — recycled) is stale, not "alive": reclaimed', () => {
    // pid 1 (launchd/init) is always live and root-owned, so kill(1, 0) raises
    // EPERM for the test user. A legitimate cooperator always runs as the
    // operator's own user — EPERM means recycled pid, never our owner.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), '1');

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    assert.ok(lock.waitedMs < 500, 'EPERM recovery is immediate, not a poll-out');
    lock.release();
  });

  test('age cap: a lock older than maxAgeMs is stale even with a live bare-pid owner', () => {
    mkdirSync(lockDir, { recursive: true });
    const pidFile = resolve(lockDir, 'pid');
    writeFileSync(pidFile, String(process.pid)); // live, no identity stamp (shell-cooperator shape)
    const past = (Date.now() - 120_000) / 1000;
    utimesSync(pidFile, past, past);

    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50, maxAgeMs: 60_000 });
    assert.equal(lock.acquired, true);
    assert.ok(lock.waitedMs < 500, 'over-age recovery is immediate, not a poll-out');
    lock.release();
  });

  test('acquire stamps the owner start time; release removes its exit/signal handlers', () => {
    const before = {
      exit: process.listenerCount('exit'),
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };
    const lock = acquireHeavyGateLock({ lockDir, timeoutMs: 1_000, pollMs: 50 });
    assert.equal(lock.acquired, true);
    assert.equal(readFileSync(resolve(lockDir, 'started'), 'utf8'), lstartOf(process.pid));
    assert.equal(process.listenerCount('exit'), before.exit + 1, 'self-heal exit handler registered while held');

    lock.release();
    assert.equal(process.listenerCount('exit'), before.exit);
    assert.equal(process.listenerCount('SIGINT'), before.int);
    assert.equal(process.listenerCount('SIGTERM'), before.term);
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
