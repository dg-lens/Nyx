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
