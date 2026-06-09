/**
 * Tests for the gate-trust detector (finding G-C — same-trust-domain gate hole).
 *
 * The gate runs inside the agent-controlled worktree, so an agent could write a
 * conftest.py / test config / CI workflow that forces the gate green. The
 * CAREFUL POLICY is flag-for-review, never blanket-fail — so these tests assert
 * both that real test-infra paths are detected AND that ordinary code/doc/dep
 * changes are NOT flagged (no false positives that would falsely halt honest
 * work, including a task whose purpose IS editing test config — which must still
 * be detectable for review without failing).
 *
 *   - detectGateSensitiveChanges  (pure path classifier)
 *   - packageJsonTouchesGate      (on-disk scripts narrowing)
 *   - assessGateTrust             (combined; mirrors the run-once wiring)
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  assessGateTrust,
  detectGateSensitiveChanges,
  packageJsonTouchesGate,
} from '../src/gate-trust.js';

// ── detectGateSensitiveChanges (pure) ────────────────────────────────────────

describe('detectGateSensitiveChanges — pure classification', () => {
  test('empty input returns no hits', () => {
    assert.deepEqual(detectGateSensitiveChanges([]), { hits: [], paths: [] });
  });

  test('flags conftest.py at any depth', () => {
    const r = detectGateSensitiveChanges([
      'conftest.py',
      'tests/conftest.py',
      'apps/api/tests/unit/conftest.py',
    ]);
    assert.deepEqual(r.paths, [
      'conftest.py',
      'tests/conftest.py',
      'apps/api/tests/unit/conftest.py',
    ]);
    assert.ok(r.hits.every((h) => h.category === 'pytest-config'));
  });

  test('flags pytest.ini, tox.ini, setup.cfg as pytest-config', () => {
    const r = detectGateSensitiveChanges(['pytest.ini', 'tox.ini', 'setup.cfg']);
    assert.deepEqual(r.paths, ['pytest.ini', 'tox.ini', 'setup.cfg']);
    assert.ok(r.hits.every((h) => h.category === 'pytest-config'));
  });

  test('flags jest/vitest/mocha config + setup files as js-test-config', () => {
    const files = [
      'jest.config.js',
      'jest.config.ts',
      'jest.config.cjs',
      'jest.config.json',
      'jest.setup.ts',
      'vitest.config.ts',
      'vitest.config.mts',
      'vitest.setup.ts',
      'vitest.workspace.ts',
      '.mocharc.json',
      '.mocharc.yml',
      'mocha.opts',
      'setupTests.ts',
      'setupTests.tsx',
      'playwright.config.ts',
      'karma.conf.js',
    ];
    const r = detectGateSensitiveChanges(files);
    assert.deepEqual(r.paths, files, 'every test-runner config should be flagged');
    assert.ok(r.hits.every((h) => h.category === 'js-test-config'));
  });

  test('flags nested test-runner config (apps/web/vitest.config.ts)', () => {
    const r = detectGateSensitiveChanges(['apps/web/vitest.config.ts']);
    assert.deepEqual(r.paths, ['apps/web/vitest.config.ts']);
    assert.equal(r.hits[0]?.category, 'js-test-config');
  });

  test('flags CI workflow files (.github/workflows, gitlab, circleci)', () => {
    const r = detectGateSensitiveChanges([
      '.github/workflows/ci.yml',
      '.github/workflows/test.yaml',
      '.gitlab-ci.yml',
      '.circleci/config.yml',
    ]);
    assert.deepEqual(r.paths, [
      '.github/workflows/ci.yml',
      '.github/workflows/test.yaml',
      '.gitlab-ci.yml',
      '.circleci/config.yml',
    ]);
    assert.ok(r.hits.every((h) => h.category === 'ci-workflow'));
  });

  test('flags package.json on path alone (pure superset)', () => {
    const r = detectGateSensitiveChanges(['package.json', 'apps/web/package.json']);
    assert.deepEqual(r.paths, ['package.json', 'apps/web/package.json']);
    assert.ok(r.hits.every((h) => h.category === 'package-scripts'));
  });

  test('flags pyproject.toml at any depth as python-project-config', () => {
    const r = detectGateSensitiveChanges([
      'pyproject.toml',
      'apps/api/pyproject.toml',
    ]);
    assert.deepEqual(r.paths, ['pyproject.toml', 'apps/api/pyproject.toml']);
    assert.ok(r.hits.every((h) => h.category === 'python-project-config'));
  });

  test('flags tsconfig.json and named variants as ts-compiler-config', () => {
    const files = [
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.build.json',
      'apps/web/tsconfig.json',
    ];
    const r = detectGateSensitiveChanges(files);
    assert.deepEqual(r.paths, files, 'every tsconfig variant should be flagged');
    assert.ok(r.hits.every((h) => h.category === 'ts-compiler-config'));
  });

  test('flags legacy .eslintrc* and flat eslint.config.* as eslint-config', () => {
    const files = [
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.ts',
      'apps/web/.eslintrc.json',
    ];
    const r = detectGateSensitiveChanges(files);
    assert.deepEqual(r.paths, files, 'every eslint config form should be flagged');
    assert.ok(r.hits.every((h) => h.category === 'eslint-config'));
  });

  test('does NOT flag ordinary source / doc / dep files', () => {
    const r = detectGateSensitiveChanges([
      'src/index.ts',
      'apps/api/main.py',
      'README.md',
      'CLAUDE.md',
      'pnpm-lock.yaml',
      'requirements.txt',
      'tests/test_widget.py',
      'src/__tests__/widget.test.ts',
      'Dockerfile',
      '.github/dependabot.yml',
      'docs/conftest-explainer.md',
    ]);
    assert.deepEqual(r, { hits: [], paths: [] });
  });

  test('does NOT match a file merely containing a config name as substring', () => {
    // "my-jest.config.ts" / "vitest.config.ts.bak" must not be classed as config
    const r = detectGateSensitiveChanges([
      'my-jest.config.ts',
      'vitest.config.ts.bak',
      'conftest.py.orig',
      'src/setupTestsHelper.ts',
    ]);
    assert.deepEqual(r, { hits: [], paths: [] });
  });

  test('does NOT match near-miss pyproject/tsconfig/eslint filenames', () => {
    // pyproject.toml.bak, mytsconfig.json, tsconfig.json.bak, .eslintrc.md,
    // eslint.config.json (flat config is never JSON) must all be ignored.
    const r = detectGateSensitiveChanges([
      'pyproject.toml.bak',
      'mytsconfig.json',
      'tsconfig.json.bak',
      'tsconfig.txt',
      '.eslintrc.md',
      'eslint.config.json',
      'eslintrc.js',
      'src/pyproject.py',
    ]);
    assert.deepEqual(r, { hits: [], paths: [] });
  });

  test('does NOT flag setup.py or requirements.txt as python config', () => {
    // Only pyproject.toml (+ the existing setup.cfg/tox.ini/pytest.ini) carry
    // the [tool.*] gate config; setup.py / requirements.txt do not.
    const r = detectGateSensitiveChanges(['setup.py', 'requirements.txt']);
    assert.deepEqual(r, { hits: [], paths: [] });
  });

  test('de-duplicates repeated paths, preserves first-seen order', () => {
    const r = detectGateSensitiveChanges([
      'conftest.py',
      'src/a.ts',
      'conftest.py',
      'jest.config.js',
    ]);
    assert.deepEqual(r.paths, ['conftest.py', 'jest.config.js']);
  });

  test('does not classify a workflow file outside the workflows dir', () => {
    // .github/ISSUE_TEMPLATE/foo.yml is not a workflow — must not be flagged
    const r = detectGateSensitiveChanges([
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/FUNDING.yml',
    ]);
    assert.deepEqual(r, { hits: [], paths: [] });
  });
});

// ── packageJsonTouchesGate (on-disk) ──────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'nyx-gate-trust-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('packageJsonTouchesGate — on-disk scripts narrowing', () => {
  test('true when package.json declares a test script', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    assert.equal(packageJsonTouchesGate(tmp, 'package.json'), true);
  });

  test('true when it declares typecheck or lint scripts', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
    );
    assert.equal(packageJsonTouchesGate(tmp, 'package.json'), true);
  });

  test('false when package.json has no gate-relevant scripts (pure dep bump)', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({
        dependencies: { left: '1.0.0' },
        scripts: { build: 'tsc', start: 'node .' },
      }),
    );
    assert.equal(packageJsonTouchesGate(tmp, 'package.json'), false);
  });

  test('false when package.json has no scripts block at all', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ dependencies: { left: '1.0.0' } }),
    );
    assert.equal(packageJsonTouchesGate(tmp, 'package.json'), false);
  });

  test('fail-safe true when file is missing', () => {
    assert.equal(packageJsonTouchesGate(tmp, 'package.json'), true);
  });

  test('fail-safe true when file is malformed JSON', () => {
    writeFileSync(resolve(tmp, 'package.json'), '{ not valid json ');
    assert.equal(packageJsonTouchesGate(tmp, 'package.json'), true);
  });
});

// ── assessGateTrust (combined — mirrors the run-once wiring) ──────────────────

describe('assessGateTrust — narrows package.json by on-disk scripts', () => {
  test('keeps a package.json hit when scripts touch the gate', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    const r = assessGateTrust(tmp, ['package.json', 'src/index.ts']);
    assert.deepEqual(r.paths, ['package.json']);
  });

  test('drops a package.json hit that is a pure dependency bump', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ dependencies: { left: '1.0.0' }, scripts: { build: 'tsc' } }),
    );
    const r = assessGateTrust(tmp, ['package.json', 'src/index.ts']);
    assert.deepEqual(r.paths, []);
  });

  test('always keeps a conftest.py hit (no narrowing for non-package paths)', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ dependencies: { left: '1.0.0' } }),
    );
    const r = assessGateTrust(tmp, ['tests/conftest.py', 'package.json']);
    // package.json dropped (no gate scripts), conftest kept
    assert.deepEqual(r.paths, ['tests/conftest.py']);
    assert.equal(r.hits[0]?.category, 'pytest-config');
  });

  test('always keeps tsconfig/pyproject/eslint hits (only package.json narrows)', () => {
    writeFileSync(
      resolve(tmp, 'package.json'),
      JSON.stringify({ dependencies: { left: '1.0.0' } }),
    );
    const r = assessGateTrust(tmp, [
      'tsconfig.json',
      'pyproject.toml',
      'eslint.config.js',
      'package.json',
    ]);
    // package.json dropped (no gate scripts); the three config files survive.
    assert.deepEqual(r.paths, ['tsconfig.json', 'pyproject.toml', 'eslint.config.js']);
    assert.deepEqual(
      r.hits.map((h) => h.category),
      ['ts-compiler-config', 'python-project-config', 'eslint-config'],
    );
  });

  test('returns empty for a diff with no test-infra at all', () => {
    const r = assessGateTrust(tmp, ['src/index.ts', 'README.md']);
    assert.deepEqual(r, { hits: [], paths: [] });
  });
});
