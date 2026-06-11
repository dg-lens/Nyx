import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';
import { processAlive } from './lockfile.js';

/**
 * Machine-wide advisory lock around the HEAVY gate stages (install probe,
 * typecheck, tests, tests-rerun).
 *
 * Why: gate verdicts are load-sensitive. The proven failure class is a tree
 * that fails its tests stage twice under concurrent heavy work (another gate,
 * a keg build, a pipeline coder fleet) and then passes 1026/1026 once
 * contention drops — wall-clock timing assertions slip under CPU pressure, the
 * audit classifier reads the flake as a real failure, and good work halts.
 * Serializing the heavy stages across PROCESSES (not just within one tick —
 * the nyx-dispatch.sh shell lock already does that) removes the contention
 * the dispatcher itself generates.
 *
 * Mechanism: mkdir-spinlock with a pid file + stale-owner liveness recovery —
 * the exact pattern scripts/nyx-dispatch.sh uses for the tick lock. mkdir is
 * atomic on every POSIX filesystem; a lock whose recorded owner is dead (or
 * never wrote its pid) is a husk from a crashed process and is reclaimed
 * immediately. ADVISORY by design: on wait-budget exhaustion the caller
 * PROCEEDS unlocked (and audits `task.gate.lock_timeout`) — a live-but-stuck
 * external process must never deadlock a tick.
 *
 * Exported standalone so workflows/scripts can cooperate later: anything that
 * runs machine-saturating work can take the same lock at
 * $NYX_DATA_DIR/run/heavy-gate.lock.
 */

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 5_000;

export interface HeavyGateLock {
  acquired: boolean;
  /** True when the wait budget elapsed with a LIVE owner still holding the lock. */
  timedOut: boolean;
  waitedMs: number;
  /** Idempotent. A no-op on a timed-out handle — never removes a foreign lock. */
  release(): void;
}

export interface HeavyGateLockOpts {
  lockDir?: string;
  timeoutMs?: number;
  pollMs?: number;
}

// Test seam (mirrors config._setAppsDir): points the DEFAULT lock dir at a
// throwaway tmpdir so tests never contend with — or wait 10 minutes on — a
// real gate running on the operator's machine.
let lockDirOverride: string | null = null;
export function _setHeavyGateLockDir(dir: string | null): void { lockDirOverride = dir; }

export function heavyGateLockDir(): string {
  return lockDirOverride ?? resolve(config.dataDir, 'run', 'heavy-gate.lock');
}

// Synchronous sleep — the gate runner is spawnSync-based, so the spin wait
// must block without an event loop. Atomics.wait on a throwaway buffer is the
// standard primitive (never woken; always times out after `ms`).
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryMkdir(lockDir: string): boolean {
  try {
    // Non-recursive on purpose: `recursive: true` swallows EEXIST, which would
    // destroy the mutual exclusion. Only the parent is created recursively.
    mkdirSync(lockDir);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      mkdirSync(dirname(lockDir), { recursive: true });
      try { mkdirSync(lockDir); return true; } catch { return false; }
    }
    return false;
  }
}

function ownerPidOf(lockDir: string): number {
  try {
    return Number.parseInt(readFileSync(resolve(lockDir, 'pid'), 'utf8').trim(), 10);
  } catch {
    // No pid file: either the owner crashed in its mkdir→write window or the
    // dir is a husk. Same call the shell pattern makes — treat as stale.
    return Number.NaN;
  }
}

function acquiredHandle(lockDir: string, waitedMs: number): HeavyGateLock {
  writeFileSync(resolve(lockDir, 'pid'), String(process.pid));
  let released = false;
  return {
    acquired: true,
    timedOut: false,
    waitedMs,
    release() {
      if (released) return;
      released = true;
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}

export function acquireHeavyGateLock(opts: HeavyGateLockOpts = {}): HeavyGateLock {
  const lockDir = opts.lockDir ?? heavyGateLockDir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();

  for (;;) {
    if (tryMkdir(lockDir)) {
      return acquiredHandle(lockDir, Date.now() - start);
    }
    if (!processAlive(ownerPidOf(lockDir))) {
      // Stale husk — owner is gone. Drop it and re-race; losing the re-race to
      // another recoverer just means we fall through to the wait below.
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* racer */ }
      if (tryMkdir(lockDir)) {
        return acquiredHandle(lockDir, Date.now() - start);
      }
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      return { acquired: false, timedOut: true, waitedMs: waited, release() { /* not ours */ } };
    }
    sleepSync(Math.min(pollMs, timeoutMs - waited));
  }
}
