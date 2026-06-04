import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

export interface LockHandle {
  release(): void;
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}

/**
 * Acquire a PID lockfile atomically via O_EXCL.
 *
 * Returns a release handle, or null if another live process holds the lock.
 * Stale locks (PID unreadable, malformed, or owner exited) are recovered
 * automatically with a single retry.
 */
export function acquire(lockfilePath: string): LockHandle | null {
  return tryAcquire(lockfilePath, /* recursed */ false);
}

function tryAcquire(lockfilePath: string, recursed: boolean): LockHandle | null {
  let fd: number;
  try {
    fd = openSync(lockfilePath, 'wx');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'EEXIST') throw err;
    if (recursed) return null;

    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(lockfilePath, 'utf8').trim(), 10);
    } catch {
      // Could have been a race: file vanished between EEXIST and read. Try once more.
      return tryAcquire(lockfilePath, true);
    }
    if (processAlive(pid)) return null;

    // Stale lock — owner is gone. Drop it and retry once.
    try { unlinkSync(lockfilePath); } catch { /* another racer may have unlinked it; fine */ }
    return tryAcquire(lockfilePath, true);
  }

  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { unlinkSync(lockfilePath); } catch { /* already gone */ }
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });

  return { release };
}
