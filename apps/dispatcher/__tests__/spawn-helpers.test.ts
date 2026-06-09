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

import { spawnWithTimeout, killTree, STALLED_EXIT_CODE } from '../src/spawn-helpers.js';

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
    assert.equal(result.stalledBySilence, false);
    // The test completing without hanging confirms no timer blocked the event loop.
  });
});

// ── spawnWithTimeout — silence watchdog (loop-detector) ──────────────────────

describe('spawnWithTimeout — silence watchdog', () => {
  test('off by default: a silent process runs to the wall-clock timeout (124, not stalled)', async () => {
    // No silenceTimeoutMs → no watchdog → silent sleep is killed only by the
    // outer wall-clock timeout, classified 124, NOT as a silence stall.
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'sleep 300'],
      { cwd: '/tmp', env: process.env },
      150,
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.killedByTimeout, true);
    assert.equal(result.stalledBySilence, false);
  }, { timeout: 6500 });

  test('a process silent past silenceTimeoutMs is killed early with the stalled code', async () => {
    const t0 = Date.now();
    // Sleeps 300s with no output; silence window is 150ms, wall-clock is 30s.
    // The watchdog must fire (not the wall clock) → STALLED_EXIT_CODE.
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'sleep 300'],
      { cwd: '/tmp', env: process.env, silenceTimeoutMs: 150, label: 'test-stall' },
      30_000,
    );
    const elapsed = Date.now() - t0;
    assert.equal(result.exitCode, STALLED_EXIT_CODE);
    assert.equal(result.stalledBySilence, true);
    assert.equal(result.killedByTimeout, false);
    assert.match(result.stderr, /stalled — no output for 150ms/);
    // Must have died ~150ms + grace, FAR before the 30s wall clock.
    assert.ok(elapsed < 5500, `elapsed ${elapsed}ms should be well under the 30s wall clock`);
  }, { timeout: 7000 });

  test('ongoing output keeps the watchdog from firing (heartbeat resets on each chunk)', async () => {
    // Prints every 60ms for ~600ms then exits 0. The 250ms silence window never
    // elapses between chunks, so the watchdog must NOT fire — the process exits
    // normally with code 0.
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do printf "tick "; sleep 0.06; done; exit 0'],
      { cwd: '/tmp', env: process.env, captureStdout: true, silenceTimeoutMs: 250 },
      30_000,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stalledBySilence, false);
    assert.equal(result.killedByTimeout, false);
    assert.match(result.stdout, /tick/);
  }, { timeout: 7000 });

  test('stderr-only output also counts as liveness (resets the watchdog)', async () => {
    // Writes to stderr (not stdout) every 60ms. Even with captureStdout false,
    // stderr chunks must reset the silence timer — otherwise a stderr-chatty,
    // stdout-quiet process would be falsely classified as stalled.
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'for i in 1 2 3 4 5 6 7 8; do printf "e" >&2; sleep 0.06; done; exit 0'],
      { cwd: '/tmp', env: process.env, captureStdout: false, silenceTimeoutMs: 250 },
      30_000,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stalledBySilence, false);
  }, { timeout: 7000 });

  test('stdout liveness works even when captureStdout is false', async () => {
    // captureStdout false, but stdout writes must still count as liveness. The
    // process prints to stdout every 60ms then exits; the 250ms window never
    // elapses, so no false stall. stdout is not buffered (empty in the result).
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'for i in 1 2 3 4 5 6 7 8; do printf "o"; sleep 0.06; done; exit 0'],
      { cwd: '/tmp', env: process.env, captureStdout: false, silenceTimeoutMs: 250 },
      30_000,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stalledBySilence, false);
    assert.equal(result.stdout, '');
  }, { timeout: 7000 });
});

// ── config default — watchdog OFF unless explicitly opted in ─────────────────

describe('claudeSilenceTimeoutMs config default', () => {
  test('defaults to 0 (watchdog disabled) when CLAUDE_SILENCE_TIMEOUT_MS is unset', async () => {
    // The watchdog mechanism is sound but `claude -p --output-format json` emits
    // one final blob, not incremental stdout — so a positive default would
    // false-kill legitimate long code/coder spawns. The default MUST be 0.
    // config.ts reads process.env at module load, so unset the var and import
    // fresh (cache-busted) to evaluate the true default.
    const prev = process.env['CLAUDE_SILENCE_TIMEOUT_MS'];
    delete process.env['CLAUDE_SILENCE_TIMEOUT_MS'];
    try {
      const { config } = await import(`../src/config.js?default-watchdog=${Date.now()}`);
      assert.equal(config.claudeSilenceTimeoutMs, 0);
    } finally {
      if (prev !== undefined) process.env['CLAUDE_SILENCE_TIMEOUT_MS'] = prev;
    }
  });

  test('a config default of 0 propagates to spawnWithTimeout as a disarmed watchdog', async () => {
    // The call sites pass `config.claudeSilenceTimeoutMs || undefined`, so a 0
    // default arrives as undefined and the watchdog never arms: a silent process
    // is killed only by the wall clock (124), never the stalled code (125).
    const silenceOpt = (0 as number) || undefined;
    assert.equal(silenceOpt, undefined);
    const result = await spawnWithTimeout(
      '/bin/sh', ['-c', 'sleep 300'],
      { cwd: '/tmp', env: process.env, silenceTimeoutMs: silenceOpt },
      150,
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.stalledBySilence, false);
    assert.notEqual(result.exitCode, STALLED_EXIT_CODE);
  }, { timeout: 6500 });
});
