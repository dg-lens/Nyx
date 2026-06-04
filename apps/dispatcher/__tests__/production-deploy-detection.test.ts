/**
 * Tests for the deploy-detector module:
 *   - detectDeployRequired (pure function, no I/O)
 *   - changedFiles (git-backed, uses a real tmpdir repo)
 *
 * The task.production.deploy_required audit event is emitted by
 * finalizeCodeExternal in cli/finalize.ts whenever detectDeployRequired finds
 * matches. These tests verify the detection logic independently of the finalize
 * flow to keep them fast and hermetic.
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { changedFiles, detectDeployRequired } from '../src/deploy-detector.js';

// ── detectDeployRequired (pure) ──────────────────────────────────────────────

describe('detectDeployRequired — pure pattern matching', () => {
  test('returns empty matchedFiles when files list is empty', () => {
    const result = detectDeployRequired([], ['apps/marketing-api/']);
    assert.deepEqual(result, { matchedFiles: [] });
  });

  test('returns empty matchedFiles when patterns list is empty', () => {
    const result = detectDeployRequired(['apps/marketing-api/src/main.py'], []);
    assert.deepEqual(result, { matchedFiles: [] });
  });

  test('returns empty matchedFiles when no files match any pattern', () => {
    const files = [
      'apps/dashboard/src/page.tsx',
      'apps/portal/src/index.ts',
      'CLAUDE.md',
    ];
    const patterns = ['apps/marketing-api/', 'apps/outreach-api/'];
    const result = detectDeployRequired(files, patterns);
    assert.deepEqual(result, { matchedFiles: [] });
  });

  test('returns matched files when a file starts with a pattern prefix', () => {
    const files = [
      'apps/marketing-api/src/main.py',
      'apps/marketing-api/tests/test_main.py',
      'apps/dashboard/src/page.tsx',
    ];
    const patterns = ['apps/marketing-api/'];
    const result = detectDeployRequired(files, patterns);
    assert.deepEqual(result, {
      matchedFiles: [
        'apps/marketing-api/src/main.py',
        'apps/marketing-api/tests/test_main.py',
      ],
    });
  });

  test('returns files matching any of multiple patterns', () => {
    const files = [
      'apps/marketing-api/src/routes.py',
      'apps/outreach-api/main.py',
      'apps/portal/page.tsx',
    ];
    const patterns = ['apps/marketing-api/', 'apps/outreach-api/'];
    const result = detectDeployRequired(files, patterns);
    assert.deepEqual(result, {
      matchedFiles: [
        'apps/marketing-api/src/routes.py',
        'apps/outreach-api/main.py',
      ],
    });
  });

  test('returns a file that exactly equals a pattern (exact match)', () => {
    const files = ['Dockerfile', 'src/index.ts'];
    const patterns = ['Dockerfile'];
    const result = detectDeployRequired(files, patterns);
    assert.deepEqual(result, { matchedFiles: ['Dockerfile'] });
  });

  test('does NOT match a file that contains the pattern as a substring but is not prefixed by it', () => {
    // "nested/apps/marketing-api/file.py" does NOT start with "apps/marketing-api/"
    const files = ['nested/apps/marketing-api/file.py'];
    const patterns = ['apps/marketing-api/'];
    const result = detectDeployRequired(files, patterns);
    assert.deepEqual(result, { matchedFiles: [] });
  });

  test('both empty inputs returns empty matchedFiles', () => {
    const result = detectDeployRequired([], []);
    assert.deepEqual(result, { matchedFiles: [] });
  });

  test('returns all matching files when all files match the pattern', () => {
    const files = ['apps/outreach-api/main.py', 'apps/outreach-api/models.py'];
    const patterns = ['apps/outreach-api/'];
    const result = detectDeployRequired(files, patterns);
    assert.deepEqual(result, { matchedFiles: files });
  });
});

// ── changedFiles (git-backed) ─────────────────────────────────────────────────

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'nyx-deploy-detect-'));
  const run = (cmd: string) =>
    execSync(cmd, { cwd: tmpRepo, stdio: 'pipe', encoding: 'utf8' });

  run('git init -b main');
  run('git config user.email "test@nyx.local"');
  run('git config user.name "Nyx Test"');

  // Create an initial commit so we have a valid base ref to diff against.
  writeFileSync(resolve(tmpRepo, 'README.md'), '# test repo\n');
  run('git add README.md');
  run('git commit -m "initial"');
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe('changedFiles — git-backed', () => {
  test('returns empty array when no files changed since baseRef', () => {
    // HEAD is the same as the initial commit; no diff
    const result = changedFiles(tmpRepo, 'HEAD~0');
    // HEAD~0 is HEAD itself — zero changes
    assert.deepEqual(result, []);
  });

  test('returns files added in commits after baseRef', () => {
    const run = (cmd: string) =>
      execSync(cmd, { cwd: tmpRepo, stdio: 'pipe', encoding: 'utf8' });

    // Tag the current HEAD as our "base" ref
    run('git tag base-ref');

    // Add new files in a second commit (create subdirs first)
    mkdirSync(resolve(tmpRepo, 'apps/marketing-api'), { recursive: true });
    mkdirSync(resolve(tmpRepo, 'apps/portal'), { recursive: true });
    writeFileSync(resolve(tmpRepo, 'apps/marketing-api/main.py'), 'print("hello")\n');
    writeFileSync(resolve(tmpRepo, 'apps/portal/index.ts'), 'export {};\n');
    execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
    run('git commit -m "add new files"');

    const result = changedFiles(tmpRepo, 'base-ref');
    assert.ok(result.includes('apps/marketing-api/main.py'), `expected marketing-api file in ${JSON.stringify(result)}`);
    assert.ok(result.includes('apps/portal/index.ts'), `expected portal file in ${JSON.stringify(result)}`);
    assert.equal(result.length, 2);
  });

  test('returns empty array when working dir is not a git repo', () => {
    const result = changedFiles('/tmp', 'HEAD');
    // /tmp is not a git repo so git diff will fail; changedFiles must not throw
    assert.deepEqual(result, []);
  });

  test('returns empty array when baseRef does not exist', () => {
    const result = changedFiles(tmpRepo, 'nonexistent-ref-xyz');
    assert.deepEqual(result, []);
  });

  test('combined: changedFiles + detectDeployRequired end-to-end', () => {
    const run = (cmd: string) =>
      execSync(cmd, { cwd: tmpRepo, stdio: 'pipe', encoding: 'utf8' });

    run('git tag v0');

    mkdirSync(resolve(tmpRepo, 'apps/outreach-api'), { recursive: true });
    writeFileSync(resolve(tmpRepo, 'apps/outreach-api/routes.py'), 'pass\n');
    writeFileSync(resolve(tmpRepo, 'CHANGELOG.md'), '## v0.1\n');
    execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
    run('git commit -m "outreach-api + changelog"');

    const files = changedFiles(tmpRepo, 'v0');
    const { matchedFiles } = detectDeployRequired(files, ['apps/outreach-api/']);
    assert.deepEqual(matchedFiles, ['apps/outreach-api/routes.py']);
  });
});
