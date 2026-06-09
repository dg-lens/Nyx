/**
 * Tests for the pinned-version diff-scoped lint gate (P7 — CORTANA-GATE-LINT).
 *
 * Cover the pure pieces: which changed files are in scope per ecosystem, and the
 * version-resolution precedence (CI pin > repo-declared > unpinned) that makes a
 * local lint match CI rather than re-float to latest.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { config } from '../src/config.js';
import {
  classifyLintResult,
  isInstallOrUsageFailure,
  resolveEslintVersion,
  resolveRuffVersion,
  scopeLintFiles,
} from '../src/lint-gate.js';

describe('scopeLintFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'lint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('JS scope: only existing JS/TS files', () => {
    writeFileSync(resolve(dir, 'a.ts'), '');
    writeFileSync(resolve(dir, 'b.tsx'), '');
    writeFileSync(resolve(dir, 'c.py'), '');
    const out = scopeLintFiles(dir, ['a.ts', 'b.tsx', 'c.py', 'gone.ts'], 'js');
    assert.deepEqual(out.sort(), ['a.ts', 'b.tsx']);
  });

  test('Python scope: only existing .py files', () => {
    writeFileSync(resolve(dir, 'a.py'), '');
    writeFileSync(resolve(dir, 'b.ts'), '');
    const out = scopeLintFiles(dir, ['a.py', 'b.ts', 'deleted.py'], 'py');
    assert.deepEqual(out, ['a.py']);
  });

  test('deduplicates', () => {
    writeFileSync(resolve(dir, 'a.ts'), '');
    assert.deepEqual(scopeLintFiles(dir, ['a.ts', 'a.ts'], 'js'), ['a.ts']);
  });
});

describe('resolveRuffVersion', () => {
  const REPO = 'lens-cx/some-repo';
  afterEach(() => {
    delete config.gitTargets[REPO];
  });

  test('CI pin wins over everything', () => {
    config.gitTargets[REPO] = { baseBranch: 'main', pushMode: 'pr', lintPins: { ruff: '0.6.9' } };
    const r = resolveRuffVersion(REPO, '["ruff==0.4.0"]');
    assert.deepEqual(r, { version: '0.6.9', source: 'ci-pin' });
  });

  test('required-version pin in pyproject is repo-declared', () => {
    const r = resolveRuffVersion(REPO, '[tool.ruff]\nrequired-version = ">=0.5.1"');
    assert.deepEqual(r, { version: '0.5.1', source: 'repo-declared' });
  });

  test('a dep constraint is repo-declared', () => {
    const r = resolveRuffVersion(REPO, 'dependencies = ["ruff==0.4.2"]');
    assert.deepEqual(r, { version: '0.4.2', source: 'repo-declared' });
  });

  test('no version anywhere → unpinned', () => {
    const r = resolveRuffVersion(REPO, '[tool.ruff]\nline-length = 100');
    assert.deepEqual(r, { source: 'unpinned' });
  });

  test('no repo means no CI pin lookup', () => {
    const r = resolveRuffVersion(undefined, 'dependencies = ["ruff==0.4.2"]');
    assert.equal(r.source, 'repo-declared');
  });
});

describe('resolveEslintVersion', () => {
  const REPO = 'lens-cx/web';
  afterEach(() => {
    delete config.gitTargets[REPO];
  });

  test('CI pin wins', () => {
    config.gitTargets[REPO] = { baseBranch: 'main', pushMode: 'pr', lintPins: { eslint: '9.13.0' } };
    const r = resolveEslintVersion(REPO, JSON.stringify({ devDependencies: { eslint: '^8.0.0' } }));
    assert.deepEqual(r, { version: '9.13.0', source: 'ci-pin' });
  });

  test('strips a range operator from a repo-declared version', () => {
    const r = resolveEslintVersion(REPO, JSON.stringify({ devDependencies: { eslint: '^9.13.0' } }));
    assert.deepEqual(r, { version: '9.13.0', source: 'repo-declared' });
  });

  test('reads dependencies when not in devDependencies', () => {
    const r = resolveEslintVersion(REPO, JSON.stringify({ dependencies: { eslint: '8.57.1' } }));
    assert.deepEqual(r, { version: '8.57.1', source: 'repo-declared' });
  });

  test('no eslint declared → unpinned', () => {
    const r = resolveEslintVersion(REPO, JSON.stringify({ devDependencies: { typescript: '5.0.0' } }));
    assert.deepEqual(r, { source: 'unpinned' });
  });

  test('malformed package.json → unpinned, no throw', () => {
    assert.deepEqual(resolveEslintVersion(REPO, '{not json'), { source: 'unpinned' });
  });
});

describe('isInstallOrUsageFailure', () => {
  test('uvx cannot resolve a bad pinned ruff version', () => {
    assert.equal(
      isInstallOrUsageFailure('error: Failed to download `ruff==99.0.0`\nNo solution found when resolving'),
      true,
    );
  });
  test('pnpm dlx cannot resolve a bad pinned eslint version', () => {
    assert.equal(
      isInstallOrUsageFailure('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for eslint@99.0.0'),
      true,
    );
  });
  test('npx registry 404 / ETARGET', () => {
    assert.equal(isInstallOrUsageFailure('npm error code ETARGET\nnpm error notarget No matching version found'), true);
  });
  test('offline runner — network unreachable', () => {
    assert.equal(isInstallOrUsageFailure('getaddrinfo EAI_AGAIN registry.npmjs.org'), true);
  });
  test('the wrapper or tool binary is missing', () => {
    assert.equal(isInstallOrUsageFailure('uvx: command not found'), true);
  });
  test('a genuine ruff lint finding is NOT an install/usage failure', () => {
    assert.equal(
      isInstallOrUsageFailure('src/a.py:3:1: F401 [*] `os` imported but unused\nFound 1 error.'),
      false,
    );
  });
  test('a genuine eslint lint finding is NOT an install/usage failure', () => {
    assert.equal(
      isInstallOrUsageFailure("/w/a.ts\n  3:7  error  'x' is assigned a value but never used  no-unused-vars\n\n1 problem"),
      false,
    );
  });
  test('a lint finding that happens to mention 404 is NOT an install/usage failure', () => {
    assert.equal(
      isInstallOrUsageFailure("/w/a.ts\n  7:3  error  Magic number 404; assign to a named constant  no-magic-numbers\n\n1 problem"),
      false,
    );
  });
  test('a lint finding that says "does not exist" is NOT an install/usage failure', () => {
    assert.equal(
      isInstallOrUsageFailure("src/a.ts:9:5: error TS2339: Property 'foo' does not exist on type 'Bar'."),
      false,
    );
  });
  test('a contextual registry 404 (not a bare token) IS still an install/usage failure', () => {
    assert.equal(
      isInstallOrUsageFailure('npm error Unexpected response 404 Not Found - GET https://registry.npmjs.org/eslint'),
      true,
    );
  });
});

describe('classifyLintResult', () => {
  const SCOPED = ['a.py'];
  const mk = (over: Partial<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }>) => ({
    status: 1,
    signal: null,
    stdout: '',
    stderr: '',
    ...over,
  });

  test('exit 0 → ran + passed', () => {
    const o = classifyLintResult('ruff', '0.6.9', 'ci-pin', SCOPED, 'log', mk({ status: 0 }));
    assert.equal(o.ran, true);
    assert.equal(o.passed, true);
  });

  test('a real lint finding (non-zero, no install signature) → ran + FAILED (hard fail)', () => {
    const stdout = 'a.py:3:1: F401 `os` imported but unused\nFound 1 error.';
    const o = classifyLintResult('ruff', '0.6.9', 'ci-pin', SCOPED, 'log', mk({ status: 1, stdout }));
    assert.equal(o.ran, true);
    assert.equal(o.passed, false);
    assert.equal(o.skipReason, undefined);
  });

  test('a real lint finding mentioning 404 (no install signature) → ran + FAILED (hard fail)', () => {
    const stdout = 'a.ts:7:3: error  Magic number 404; assign to a named constant  no-magic-numbers\n1 problem';
    const o = classifyLintResult('eslint', '9.13.0', 'ci-pin', ['a.ts'], 'log', mk({ status: 1, stdout }));
    assert.equal(o.ran, true);
    assert.equal(o.passed, false);
    assert.equal(o.skipReason, undefined);
  });

  test('a real lint finding saying "does not exist" (no install signature) → ran + FAILED (hard fail)', () => {
    const stdout = "a.ts:9:5: error TS2339: Property 'foo' does not exist on type 'Bar'.\n1 problem";
    const o = classifyLintResult('eslint', '9.13.0', 'ci-pin', ['a.ts'], 'log', mk({ status: 1, stdout }));
    assert.equal(o.ran, true);
    assert.equal(o.passed, false);
    assert.equal(o.skipReason, undefined);
  });

  test('pinned version could not be fetched (non-zero + install signature) → SKIP, not fail', () => {
    const stderr = 'error: Failed to download `ruff==99.0.0`\nNo solution found when resolving';
    const o = classifyLintResult('ruff', '99.0.0', 'ci-pin', SCOPED, 'log', mk({ status: 1, stderr }));
    assert.equal(o.ran, false);
    assert.equal(o.passed, true);
    assert.ok(o.skipReason?.includes('could not be installed/run'));
  });

  test('bad pinned eslint via pnpm dlx → SKIP, not fail', () => {
    const stderr = 'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for eslint@99.0.0';
    const o = classifyLintResult('eslint', '99.0.0', 'ci-pin', ['a.ts'], 'log', mk({ status: 1, stderr }));
    assert.equal(o.ran, false);
    assert.equal(o.passed, true);
    assert.ok(o.skipReason?.includes('could not be installed/run'));
  });

  test('spawn error (failed to launch wrapper) → SKIP', () => {
    const o = classifyLintResult('ruff', undefined, 'unpinned', SCOPED, 'log', mk({ status: null, error: new Error('ENOENT') }));
    assert.equal(o.ran, false);
    assert.equal(o.passed, true);
    assert.ok(o.skipReason?.includes('ENOENT'));
  });

  test('signal-kill (stage timeout) → SKIP', () => {
    const o = classifyLintResult('eslint', '9.13.0', 'ci-pin', ['a.ts'], 'log', mk({ status: null, signal: 'SIGTERM' }));
    assert.equal(o.ran, false);
    assert.equal(o.passed, true);
    assert.ok(o.skipReason?.includes('signal'));
  });
});
