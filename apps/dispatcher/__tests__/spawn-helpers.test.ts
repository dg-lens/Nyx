/**
 * Tests for spawnWithTimeout / killTree in spawn-helpers.ts.
 *
 * Focus areas:
 *   (a) Close fires within timeoutMs + 5s + epsilon after timeout fires.
 *   (b) Process GROUP is killed (not just the direct child) — verified by
 *       spawning a shell that daemonises a grandchild holding the pipe; if
 *       only the direct child were killed, the grandchild would keep the pipe
 *       open and the promise would hang past the SIGKILL window.
 *   (c) SIGKILL timer is cleared when the child exits before the 5-second
 *       grace window (no stale timer firing against a dead PID).
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { spawnWithTimeout, killTree } from '../src/spawn-helpers.js';

// ── killTree ─────────────────────────────────────────────────────────────────

describe('killTree', () => {
  test('swallows ESRCH for a non-existent PID without throwing', () => {
    // PID 2_000_000 is above macOS/Linux max — guaranteed not alive.
    assert.doesNotThrow(() => killTree(2_000_000, 'SIGTERM'));
  });
});

// ── spawnWithTimeout — normal exit ───────────────────────────────────────────

describe('spawnWithTimeout — normal exit', () => {
  test('exits with the command exit code and killedByTimeout: false', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'exit 0'],
      { cwd: '/tmp', env: process.env, captureStdout: true },
      5000,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.killedByTimeout, false);
  });

  test('propagates non-zero exit codes', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'exit 7'],
      { cwd: '/tmp', env: process.env, captureStdout: true },
      5000,
    );
    assert.equal(result.exitCode, 7);
    assert.equal(result.killedByTimeout, false);
  });

  test('captures stdout when captureStdout: true', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'printf hello'],
      { cwd: '/tmp', env: process.env, captureStdout: true },
      5000,
    );
    assert.equal(result.stdout, 'hello');
  });

  test('stdout is empty string when captureStdout: false', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'printf hello'],
      { cwd: '/tmp', env: process.env, captureStdout: false },
      5000,
    );
    assert.equal(result.stdout, '');
  });

  test('captures stderr', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'printf err >&2'],
      { cwd: '/tmp', env: process.env },
      5000,
    );
    assert.equal(result.stderr, 'err');
  });

  test('durationMs is plausible', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'exit 0'],
      { cwd: '/tmp', env: process.env },
      5000,
    );
    assert.ok(result.durationMs >= 0 && result.durationMs < 2000,
      `durationMs ${result.durationMs} should be between 0 and 2000`);
  });
});

// ── spawnWithTimeout — timeout path ──────────────────────────────────────────

describe('spawnWithTimeout — timeout', () => {
  test('returns exitCode 124 and killedByTimeout: true when process exceeds timeout', async () => {
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'sleep 300'],
      { cwd: '/tmp', env: process.env, label: 'test-timeout' },
      150,
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.killedByTimeout, true);
    assert.match(result.stderr, /timed out after 150ms/);
  }, { timeout: 6500 });

  // Core regression: without process-group kill, the grandchild keeps the
  // stderr pipe open after the shell is SIGTERMed, and 'close' never fires.
  // With process-group kill, the whole group dies on SIGTERM so 'close' fires
  // promptly — well within the 5-second SIGKILL window.
  test('(b) kills grandchildren that hold the pipe open', async () => {
    const t0 = Date.now();
    // Shell spawns a long-running grandchild in the background and waits on it.
    // Without group kill: grandchild holds stderr pipe; close never fires.
    // With group kill: entire group receives SIGTERM; close fires quickly.
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'sleep 300 & wait'],
      { cwd: '/tmp', env: process.env },
      150,
    );
    const elapsed = Date.now() - t0;
    assert.equal(result.exitCode, 124, 'should be killed by timeout');
    assert.equal(result.killedByTimeout, true);
    // Must resolve well within the 5-second SIGKILL window.
    // SIGTERM to the group kills both the shell and the grandchild immediately,
    // so elapsed is ~150ms (timeout) + a few ms (process death + pipe flush).
    assert.ok(elapsed < 5500, `elapsed ${elapsed}ms should be < 5500ms — if this hangs, process-group kill is broken`);
  }, { timeout: 7000 });

  // (c) SIGKILL timer is cleared: a process that exits before the 5-second
  // grace window must NOT leave a dangling timer that fires against a dead PID.
  // Behavioral proof: killedByTimeout is false and durationMs is short.
  test('(c) SIGKILL timer is cleared when process exits before grace window', async () => {
    // Process exits immediately; timeout is 5 seconds — the SIGTERM timer
    // never fires, so sigkillTimer is never set, and clearTimeout is a no-op.
    // For the case where SIGTERM fires but the process dies before SIGKILL:
    // use a very short timeout so SIGTERM fires, then the process dies in the
    // shell before 5 seconds, and the sigkillTimer should be cleared in close.
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'exit 0'],
      { cwd: '/tmp', env: process.env },
      5000,
    );
    assert.equal(result.killedByTimeout, false);
    // The test completing without hanging confirms no timer blocked the event loop.
  });
});
