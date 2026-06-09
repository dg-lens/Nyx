/**
 * GIT-class single-flight mutex.
 *
 * A GIT task (code or pipeline phase that touches worktrees / the shared repo /
 * a push) runs synchronously inside its launching tick. `liveGitTaskExists`
 * lets the scheduler refuse to start a SECOND GIT task while one is already
 * mid-flight in a live dispatcher pid: at most one GIT actor system-wide, so two
 * tasks never race the same index/working tree or a non-fast-forward push.
 *
 * The lock content is `{ pid, taskId, at }`. `liveGitTaskExists` returns true
 * iff the recorded pid is alive (reusing the same `kill(pid, 0)` liveness check
 * as the dispatch lockfile). A dead pid means the owning tick crashed mid-GIT-
 * task; the lock is swept and treated as free so a crashed run can never wedge
 * GIT dispatch forever.
 *
 * SCOPE — what this lock actually achieves vs. what it does NOT:
 *
 * It IS consulted whenever a `main()` invocation could pick a second GIT task —
 * most concretely when a resumed pipeline phase took the GIT slot earlier in the
 * SAME tick and a queued `code` task is then picked. (`gitSlotTaken` covers the
 * common case; this lock is the durable, pid-checked backstop.)
 *
 * It does NOT, on its own, give cross-tick GIT/ISO overlap — i.e. it does not
 * let a LATER launchd tick run ISO tasks while a long GIT task from an EARLIER
 * tick is still building. That overlap is blocked one layer up, by design: the
 * launchd wrapper (`scripts/nyx-dispatch.sh`) holds the shell lock
 * `/tmp/nyx-dispatch.sh.lock` for the entire `node run-once.js` process, and the
 * GIT task is awaited inside that process's `main()`. While it runs, the next
 * 5-min launchd tick's shell script can't acquire the shell lock and exits
 * immediately — no second Node process starts, so this lock is never even read
 * by a "concurrent" tick. The shell lock is intentional (it closes the
 * launchd→Node startup race; see the `dual-lockfile` invariant) and must not be
 * removed to force cross-tick overlap. The concurrency this redesign genuinely
 * delivers is WITHIN a single tick: ISO tasks fan out and overlap the one GIT
 * task (see tick-scheduler.runTwoClassTick). True cross-tick overlap would
 * require detaching the GIT task from the shell-locked process — a daemon-model
 * change, out of scope here.
 *
 * Distinct from the dispatch lockfile (serializes TICK processes) — this guards
 * the GIT-class TASK slot. ISO scheduling ignores it entirely.
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
 * True iff a GIT task is mid-flight in a LIVE dispatcher process. In practice
 * (given the shell lock — see the file header) that "live process" is THIS one:
 * a GIT task launched earlier in this same `main()` invocation, e.g. a resumed
 * pipeline phase that already took the slot. A lock owned by a dead pid is stale
 * — the owning tick crashed mid-task — so it's swept and reported as free, so a
 * crashed run can never wedge GIT dispatch forever.
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
