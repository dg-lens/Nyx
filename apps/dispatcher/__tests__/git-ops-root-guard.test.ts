import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { assertSaneSelfTaskRoot } from '../src/git-ops.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'root-guard-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('assertSaneSelfTaskRoot — self-task roots must be stable real checkouts', () => {
  test('a Cellar-resolved root is refused with remediation in the message', () => {
    const keg = join(scratch, 'Cellar', 'nyx', 'HEAD-abc123', 'libexec');
    mkdirSync(keg, { recursive: true });
    assert.throws(() => assertSaneSelfTaskRoot(keg), /Homebrew Cellar.*NYX_REPO_ROOT/s);
  });

  test('a gitless dir nested inside a parent repo is refused (no shadow init)', () => {
    const parent = join(scratch, 'parent');
    const nested = join(parent, 'sub', 'dir');
    mkdirSync(nested, { recursive: true });
    execSync('git init -q', { cwd: parent });
    assert.throws(() => assertSaneSelfTaskRoot(nested), /nested repo|sits inside/);
  });

  test('a real standalone checkout passes', () => {
    const repo = join(scratch, 'repo');
    mkdirSync(repo, { recursive: true });
    execSync('git init -q', { cwd: repo });
    assert.doesNotThrow(() => assertSaneSelfTaskRoot(repo));
  });

  test('a gitless dir with no parent repo passes (legit fresh-init case)', () => {
    const fresh = join(scratch, 'fresh');
    mkdirSync(fresh, { recursive: true });
    assert.doesNotThrow(() => assertSaneSelfTaskRoot(fresh));
  });
});
