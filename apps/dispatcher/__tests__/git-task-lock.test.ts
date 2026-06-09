import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { liveGitTaskExists, removeGitLock, writeGitLock } from '../src/git-task-lock.js';
import { acquire } from '../src/lockfile.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitlock-'));
  lockPath = join(dir, 'nyx-git-task.lock');
});

afterEach(() => {
  removeGitLock(lockPath);
});

describe('git-task-lock — cross-tick GIT-class mutex', () => {
  test('no lock file → no live GIT task', () => {
    assert.equal(liveGitTaskExists(lockPath), false);
  });

  test('write then check: a lock owned by THIS (live) process reads as live', () => {
    writeGitLock(lockPath, 'CODE-1');
    assert.equal(liveGitTaskExists(lockPath), true);
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(parsed.pid, process.pid);
    assert.equal(parsed.taskId, 'CODE-1');
    assert.equal(typeof parsed.at, 'number');
  });

  test('remove clears the lock', () => {
    writeGitLock(lockPath, 'CODE-2');
    removeGitLock(lockPath);
    assert.equal(existsSync(lockPath), false);
    assert.equal(liveGitTaskExists(lockPath), false);
  });

  test('a lock owned by a DEAD pid is stale → swept + reported free', () => {
    // 2_147_480_000 is above the macOS/Linux pid max — guaranteed not alive.
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_480_000, taskId: 'CODE-3', at: Date.now() }));
    assert.equal(liveGitTaskExists(lockPath), false);
    assert.equal(existsSync(lockPath), false, 'stale lock must be swept');
  });

  test('a malformed lock is swept + reported free (never wedges GIT dispatch)', () => {
    writeFileSync(lockPath, 'not json {{{');
    assert.equal(liveGitTaskExists(lockPath), false);
    assert.equal(existsSync(lockPath), false);
  });

  test('removeGitLock on an absent file is a no-op (no throw)', () => {
    assert.doesNotThrow(() => removeGitLock(lockPath));
  });
});

/**
 * Documents the ACTUAL achieved cross-tick behavior (FIX item 2). True
 * cross-tick GIT/ISO overlap is intentionally NOT delivered: while a GIT task is
 * awaited inside main(), the dispatch lockfile is held, so a concurrent tick
 * attempt is REFUSED and never gets to run its ISO tasks. (The shell lock in
 * nyx-dispatch.sh enforces the same serialization one layer up — see the
 * `dual-lockfile` invariant; it's the launchd→Node race guard and must stay.)
 * The concurrency this redesign genuinely delivers is WITHIN one tick, proven in
 * tick-concurrency.test.ts ("a long GIT task runs concurrently with the ISO
 * pool"). These tests pin the boundary so a future change doesn't silently
 * claim cross-tick overlap the lock layers don't provide.
 */
describe('cross-tick behavior — a held dispatch lock refuses a concurrent tick', () => {
  test('a second acquire of the dispatch lockfile is refused while the first is held', () => {
    const lf = join(dir, 'nyx-dispatch.lock');
    const first = acquire(lf);
    assert.ok(first, 'first tick acquires the dispatch lock');
    // While a GIT task is awaited in the first tick, main() has not returned, so
    // the lock is still held. A concurrent tick attempt fails — it cannot start
    // ISO tasks. This is why cross-tick GIT/ISO overlap is not achieved.
    const second = acquire(lf);
    assert.equal(second, null, 'a concurrent tick is refused while the lock is held');
    first!.release();
    // After the GIT task finishes and main() returns + releases, the next tick
    // (a fresh launchd fire) can acquire normally.
    const third = acquire(lf);
    assert.ok(third, 'the lock is free again once the holding tick releases');
    third!.release();
  });

  test('the git single-flight lock suppresses a SECOND GIT task in the same live process', () => {
    // The lock's real job: within one main() invocation, once a GIT task (e.g. a
    // resumed pipeline phase) holds the slot, a second GIT pick is suppressed.
    writeGitLock(lockPath, 'PIPE-1');
    assert.equal(liveGitTaskExists(lockPath), true, 'GIT slot taken — a second code task must not start');
    removeGitLock(lockPath);
    assert.equal(liveGitTaskExists(lockPath), false, 'slot freed once the GIT task finishes');
  });
});
