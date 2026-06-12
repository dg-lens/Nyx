import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';

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
 * PID-reuse hardening (mirrors git-ops.ts isSentinelOwnerAlive): a bare
 * process.kill(pid, 0) is a PID-reuse hazard — after the owner dies without
 * its release running (SIGKILL, or a signal landing mid-spawnSync), the OS can
 * recycle the recorded pid for an unrelated long-lived process, and the bare
 * signal then reports the husk "live" forever, taxing EVERY gate the full
 * wait budget. Three guards, layered:
 *   1. EPERM-means-stale. Legitimate lock cooperators run as the operator's
 *      own user; a pid we cannot signal belongs to another user/root and is a
 *      recycled pid, never our owner.
 *   2. Identity stamp. The acquirer records its process start time (`ps -o
 *      lstart=`) in a `started` file next to `pid`. A signalable pid whose
 *      current start time differs from the stamp is a recycled pid -> stale.
 *      A lock with no stamp (a shell cooperator that only writes `pid`, per
 *      the nyx-dispatch.sh pattern) falls back to the bare signal result.
 *   3. Age cap. A lock older than `maxAgeMs` (default: 6 gate-stage budgets —
 *      above any legitimate full-gate hold) is stale regardless of owner
 *      liveness — the self-heal backstop when both guards above are defeated.
 * The acquirer also releases on process exit/SIGINT/SIGTERM (the lockfile.ts
 * acquire() pattern) so a signalled dispatcher does not leave a husk at all.
 * release() on a TIMED-OUT handle stays a no-op — stale reclaim happens only
 * in the acquire path, never against a lock we failed to win.
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
  /** On timeout: the pid recorded in the foreign lock, for the `task.gate.lock_timeout` payload. */
  ownerPid?: number;
  /** Idempotent. A no-op on a timed-out handle — never removes a foreign lock. */
  release(): void;
}

export interface HeavyGateLockOpts {
  lockDir?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Age past which a lock is stale regardless of owner liveness. Default: 6 gate-stage budgets. */
  maxAgeMs?: number;
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

/**
 * `ps -o lstart=` start time for a pid — the identity that survives PID reuse
 * (a recycled pid never has the same start time). null when ps is unavailable
 * or returns nothing; callers fall back to the more-permissive bare-signal
 * verdict (same policy as git-ops.ts isSentinelOwnerAlive).
 */
function processStartTime(pid: number): string | null {
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? '').trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * PID-reuse-hardened owner liveness. ESRCH AND EPERM both mean stale — a
 * legitimate cooperator always runs as the operator's own user, so a pid owned
 * by another user/root is a recycled pid, not our owner. A signalable pid is
 * then cross-checked against the `started` identity stamp when one exists.
 */
function ownerAlive(lockDir: string, pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  let stamped: string | null;
  try {
    stamped = readFileSync(resolve(lockDir, 'started'), 'utf8').trim() || null;
  } catch {
    stamped = null;
  }
  if (stamped !== null) {
    const live = processStartTime(pid);
    if (live !== null && live !== stamped) return false;
  }
  return true;
}

function lockAgeMs(lockDir: string): number {
  try {
    return Date.now() - statSync(resolve(lockDir, 'pid')).mtimeMs;
  } catch {
    try {
      return Date.now() - statSync(lockDir).mtimeMs;
    } catch {
      // Dir vanished under us (a racer reclaimed it) — the next tryMkdir decides.
      return 0;
    }
  }
}

function acquiredHandle(lockDir: string, waitedMs: number): HeavyGateLock {
  writeFileSync(resolve(lockDir, 'pid'), String(process.pid));
  const started = processStartTime(process.pid);
  if (started !== null) writeFileSync(resolve(lockDir, 'started'), started);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* already gone */ }
  };
  const onSigint = (): void => { release(); process.exit(130); };
  const onSigterm = (): void => { release(); process.exit(143); };
  // Self-heal on dispatcher death (the lockfile.ts acquire() pattern): without
  // these a signalled run leaves a husk whose pid the OS can recycle.
  process.on('exit', release);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return {
    acquired: true,
    timedOut: false,
    waitedMs,
    release,
  };
}

export function acquireHeavyGateLock(opts: HeavyGateLockOpts = {}): HeavyGateLock {
  const lockDir = opts.lockDir ?? heavyGateLockDir();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  // Above any legitimate full-gate hold (install + lint + typecheck + tests +
  // tests-rerun, each capped at one stage budget) with headroom.
  const maxAgeMs = opts.maxAgeMs ?? 6 * config.gateStageTimeoutMs;
  const start = Date.now();

  for (;;) {
    if (tryMkdir(lockDir)) {
      return acquiredHandle(lockDir, Date.now() - start);
    }
    const ownerPid = ownerPidOf(lockDir);
    if (!ownerAlive(lockDir, ownerPid) || lockAgeMs(lockDir) > maxAgeMs) {
      // Stale: a dead/recycled-pid/other-user owner, or a lock held longer
      // than any legitimate gate ever runs. Drop it and re-race; losing the
      // re-race to another recoverer just means we fall through to the wait.
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* racer */ }
      if (tryMkdir(lockDir)) {
        return acquiredHandle(lockDir, Date.now() - start);
      }
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      return {
        acquired: false,
        timedOut: true,
        waitedMs: waited,
        ...(Number.isFinite(ownerPid) ? { ownerPid } : {}),
        release() { /* not ours */ },
      };
    }
    sleepSync(Math.min(pollMs, timeoutMs - waited));
  }
}
