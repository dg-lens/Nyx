/**
 * Cross-tick GIT-class mutex.
 *
 * A GIT task (code or pipeline phase that touches worktrees / the shared repo /
 * a push) runs synchronously inside its launching tick and can outlive the
 * 5-minute tick interval — so the next launchd tick fires a fresh dispatcher
 * process WHILE the prior tick's GIT task is still mid-flight. The dispatch
 * lockfile (one process per tick) does NOT cover this: that lock is released
 * when `main()` returns, but the GIT task may still be running in the prior
 * process. This lock tells a subsequent tick "a GIT task is in flight in another
 * live dispatcher pid" so it SKIPS GIT scheduling — while still running ISO
 * tasks freely (the whole point of the redesign).
 *
 * The lock content is `{ pid, taskId, at }`. `liveGitTaskExists` returns true
 * iff the recorded pid is alive (reusing the same `kill(pid, 0)` liveness check
 * as the dispatch lockfile). A dead pid means the owning tick crashed mid-GIT-
 * task; the lock is swept and treated as free so a crashed run can never wedge
 * GIT dispatch forever.
 *
 * Distinct from the dispatch lockfile (serializes TICKS) — this serializes
 * GIT-class TASKS across ticks. ISO scheduling ignores it entirely.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

interface GitLockContent {
  pid: number;
  taskId: string;
  at: number;
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function writeGitLock(path: string, taskId: string): void {
  const content: GitLockContent = { pid: process.pid, taskId, at: Date.now() };
  writeFileSync(path, JSON.stringify(content));
}

export function removeGitLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * True iff a GIT task is mid-flight in a LIVE dispatcher process (this tick or a
 * prior overlapping one). A lock owned by a dead pid is stale — the owning tick
 * crashed mid-task — so it's swept and reported as free. A lock owned by THIS
 * process counts as live (a GIT task launched earlier in this same tick).
 */
export function liveGitTaskExists(path: string): boolean {
  if (!existsSync(path)) return false;
  let parsed: GitLockContent;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as GitLockContent;
  } catch {
    // Malformed lock — can't trust it. Sweep and treat as free.
    removeGitLock(path);
    return false;
  }
  if (processAlive(parsed.pid)) return true;
  removeGitLock(path);
  return false;
}
