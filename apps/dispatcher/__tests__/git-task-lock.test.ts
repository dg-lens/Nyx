import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { liveGitTaskExists, removeGitLock, writeGitLock } from '../src/git-task-lock.js';

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
