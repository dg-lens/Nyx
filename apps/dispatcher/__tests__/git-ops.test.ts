import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setWorktreesDir, createGreenfieldDir, inFlight, repoUrl, writeLivenessSentinel } from '../src/git-ops.js';
import { config } from '../src/config.js';

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-git-ops-test-'));
  _setWorktreesDir(tmpDir);
});

afterEach(() => {
  _setWorktreesDir(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTaskId(): string {
  return `TEST-GIT-OPS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function writeRawSentinel(dir: string, pid: number, taskId: string): void {
  writeFileSync(
    resolve(dir, '.nyx-task.pid'),
    JSON.stringify({ pid, taskId, startedAt: new Date().toISOString() }),
    'utf8',
  );
}

// ─── writeLivenessSentinel ───────────────────────────────────────────────────

describe('writeLivenessSentinel', () => {
  test('writes a parseable sentinel with current pid and taskId', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'nyx-sentinel-'));
    try {
      const taskId = makeTaskId();
      writeLivenessSentinel(dir, taskId);
      const raw = readFileSync(resolve(dir, '.nyx-task.pid'), 'utf8');
      const s = JSON.parse(raw) as { pid: number; taskId: string; startedAt: string };
      assert.equal(s.pid, process.pid);
      assert.equal(s.taskId, taskId);
      assert.ok(typeof s.startedAt === 'string' && s.startedAt.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not throw when dir is missing (swallows write error)', () => {
    assert.doesNotThrow(() => writeLivenessSentinel('/tmp/nyx-nonexistent-zzzz', 'TASK-1'));
  });
});

// ─── inFlight — no working dir ───────────────────────────────────────────────

describe('inFlight — none', () => {
  test('returns none when neither worktree nor clone dir exists', () => {
    const taskId = makeTaskId();
    assert.equal(inFlight(taskId), 'none');
  });
});

// ─── inFlight — worktree dir (controlled via _setWorktreesDir) ───────────────

describe('inFlight — worktree dir', () => {
  test('returns live when worktree dir exists with a live sentinel (current pid)', () => {
    const taskId = makeTaskId();
    const worktreeDir = resolve(tmpDir, taskId);
    mkdirSync(worktreeDir, { recursive: true });
    writeRawSentinel(worktreeDir, process.pid, taskId);

    assert.equal(inFlight(taskId), 'live');

    // Clean up since inFlight didn't (it returned live)
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  test('returns stale_cleared and removes dir when sentinel has a dead pid', () => {
    const taskId = makeTaskId();
    const worktreeDir = resolve(tmpDir, taskId);
    mkdirSync(worktreeDir, { recursive: true });
    // PID 2_000_000 is far above macOS max pid (99999) and will never be alive.
    writeRawSentinel(worktreeDir, 2_000_000, taskId);

    assert.equal(inFlight(taskId), 'stale_cleared');
    // Dir should be gone (removeWorktree cleans it up)
    // removeWorktree calls rmSync after the git worktree command fails silently
    // — the dir is gone either way.
    assert.equal(inFlight(taskId), 'none', 'second call should see no dir');
  });

  test('returns stale_cleared when worktree dir exists but has no sentinel (pre-upgrade ghost)', () => {
    const taskId = makeTaskId();
    const worktreeDir = resolve(tmpDir, taskId);
    mkdirSync(worktreeDir, { recursive: true });
    // Deliberately NO sentinel file written

    assert.equal(inFlight(taskId), 'stale_cleared');
    assert.equal(inFlight(taskId), 'none');
  });
});

// ─── inFlight — clone dir (uses real /tmp prefix) ───────────────────────────

describe('inFlight — clone dir', () => {
  let cloneDir: string;
  let taskId: string;

  beforeEach(() => {
    taskId = makeTaskId();
    cloneDir = `${config.cloneRootPrefix}${taskId}`;
    mkdirSync(cloneDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* already removed */ }
  });

  test('returns live when clone dir exists with a live sentinel', () => {
    writeRawSentinel(cloneDir, process.pid, taskId);
    assert.equal(inFlight(taskId), 'live');
  });

  test('returns stale_cleared and removes clone dir when sentinel has a dead pid', () => {
    writeRawSentinel(cloneDir, 2_000_000, taskId);
    assert.equal(inFlight(taskId), 'stale_cleared');
    assert.equal(inFlight(taskId), 'none');
  });

  test('returns stale_cleared when clone dir has no sentinel (pre-upgrade ghost)', () => {
    // No sentinel written
    assert.equal(inFlight(taskId), 'stale_cleared');
    assert.equal(inFlight(taskId), 'none');
  });
});

describe('repoUrl (H2 token-in-.git/config guard)', () => {
  test('never embeds a credential in the clone URL', () => {
    const url = repoUrl('lens-cx/employee-portal');
    assert.equal(url, 'https://github.com/lens-cx/employee-portal.git');
    assert.ok(!url.includes('x-access-token'), 'no embedded username');
    assert.ok(!url.includes('@'), 'no credential separator in URL');
    if (config.githubToken) {
      assert.ok(!url.includes(config.githubToken), 'token must never appear in the persisted URL');
    }
  });
});

// ─── createGreenfieldDir durable guard ───────────────────────────────────────

describe('createGreenfieldDir (durable-dir rm-rf guard)', () => {
  function withAppsDir<T>(fn: (appsDir: string) => T): T {
    const orig = config.appsDir;
    const appsDir = mkdtempSync(resolve(tmpdir(), 'nyx-apps-'));
    config.appsDir = appsDir;
    try {
      return fn(appsDir);
    } finally {
      config.appsDir = orig;
      rmSync(appsDir, { recursive: true, force: true });
    }
  }

  test('refuses to wipe a non-empty dir under config.appsDir — a delivered app has no remote', () => {
    withAppsDir((appsDir) => {
      const dest = resolve(appsDir, 'noted');
      mkdirSync(dest, { recursive: true });
      writeFileSync(resolve(dest, 'app.ts'), 'delivered\n');
      assert.throws(() => createGreenfieldDir(dest), /refusing to wipe existing non-empty deliverable dir/);
      assert.equal(readFileSync(resolve(dest, 'app.ts'), 'utf8'), 'delivered\n', 'app contents survive');
    });
  });

  test('still scaffolds a fresh repo at a non-existent appsDir path', () => {
    withAppsDir((appsDir) => {
      const dest = resolve(appsDir, 'fresh');
      const wd = createGreenfieldDir(dest);
      assert.equal(wd.path, dest);
      const head = readFileSync(resolve(dest, '.git', 'HEAD'), 'utf8');
      assert.match(head, /refs\/heads\/main/);
      rmSync(dest, { recursive: true, force: true });
    });
  });
});
