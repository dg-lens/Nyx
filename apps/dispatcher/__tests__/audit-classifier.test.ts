import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { classifyFailure } from '../src/audit-classifier.js';

describe('classifyFailure — pnpm config drift', () => {
  test('detects "packages field missing or empty"', () => {
    const r = classifyFailure(' ERROR  packages field missing or empty\n');
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'pnpm-workspace-missing-packages');
    assert.equal(r.autofix?.kind, 'rewrite-pnpm-workspace');
  });

  test('detects ERR_PNPM_IGNORED_BUILDS and extracts package list', () => {
    const r = classifyFailure(
      '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: sharp@0.34.5, unrs-resolver@1.12.2, esbuild@0.27.7\n',
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'pnpm-ignored-builds');
    assert.equal(r.autofix?.kind, 'add-pnpm-build-approval');
    assert.deepEqual(
      r.autofix?.kind === 'add-pnpm-build-approval' ? r.autofix.packages.sort() : [],
      ['esbuild', 'sharp', 'unrs-resolver'],
    );
  });

  test('detects deprecated "pnpm" field in package.json', () => {
    const r = classifyFailure(
      '[WARN] The "pnpm" field in package.json is no longer read by pnpm.',
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'pnpm-field-in-package-json-ignored');
    assert.equal(r.autofix?.kind, 'rewrite-pnpm-workspace');
  });

  test('detects ERR_PNPM_OUTDATED_LOCKFILE', () => {
    const r = classifyFailure(
      'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date with package.json',
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'pnpm-lockfile-mismatch');
    assert.equal(r.autofix?.kind, 'regenerate-pnpm-lockfile');
  });
});

describe('classifyFailure — missing dep', () => {
  test('detects missing eslint-plugin-react-hooks', () => {
    const r = classifyFailure(
      "Failed to load plugin 'react-hooks' declared in 'eslint-config-next/core-web-vitals'",
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'missing-eslint-plugin');
    assert.equal(r.autofix?.kind, 'add-devdep');
  });

  test('extracts module name from "Cannot find module" for known-safe deps', () => {
    const r = classifyFailure("Cannot find module '@types/node'");
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.autofix?.kind, 'add-devdep');
    if (r.autofix?.kind === 'add-devdep') {
      assert.deepEqual(r.autofix.packages, ['@types/node']);
    }
  });

  test('Cannot-find-module for unknown package → unknown class (caller escalates)', () => {
    const r = classifyFailure("Cannot find module 'some-random-package'");
    assert.equal(r.kind, 'unknown');
  });
});

describe('classifyFailure — mypy plugin gaps', () => {
  test('SQLAlchemy untyped decorator → add sqlalchemy plugin', () => {
    const r = classifyFailure(
      'src/marketing_os/router.py:19: error: Untyped decorator makes function "get_active" untyped\n... sqlalchemy ...',
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'mypy-untyped-decorator-sqlalchemy');
    assert.equal(r.autofix?.kind, 'add-mypy-plugin');
  });

  test('Pydantic BaseModel any → add pydantic plugin', () => {
    const r = classifyFailure(
      'src/marketing_os/brand_voice/schema.py:8: error: Class cannot subclass "BaseModel" (has type "Any")',
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'mypy-pydantic-basemodel-any');
    assert.equal(r.autofix?.kind, 'add-mypy-plugin');
  });
});

describe('classifyFailure — git', () => {
  test('CONFLICT (content) → rebase-against-main', () => {
    const r = classifyFailure(
      'CONFLICT (content): Merge conflict in package.json\nAutomatic merge failed; fix conflicts and then commit the result.',
    );
    assert.equal(r.kind, 'auto-fixable');
    assert.equal(r.pattern, 'git-merge-conflict');
    assert.equal(r.autofix?.kind, 'rebase-against-main');
  });
});

describe('classifyFailure — operator-required', () => {
  test('Repository not found', () => {
    const r = classifyFailure(
      "remote: Repository not found.\nfatal: repository 'https://github.com/foo/bar.git/' not found",
    );
    assert.equal(r.kind, 'operator-required');
    assert.equal(r.pattern, 'repo-not-found');
    assert.match(r.operatorReport!, /repo this task targets/i);
  });

  test('SUPABASE_DB_URL is not defined', () => {
    const r = classifyFailure(
      'Error: SUPABASE_DB_URL is not defined. Aborting migration apply.',
    );
    assert.equal(r.kind, 'operator-required');
    assert.equal(r.pattern, 'bws-secret-missing');
    assert.match(r.operatorReport!, /SUPABASE_DB_URL/);
  });

  test('Supabase missing table → operator', () => {
    const r = classifyFailure(
      'PostgrestError: relation "employees" does not exist',
    );
    assert.equal(r.kind, 'operator-required');
    assert.equal(r.pattern, 'supabase-table-missing');
    assert.match(r.operatorReport!, /employees/);
  });

  test('Network refused', () => {
    const r = classifyFailure('connect ECONNREFUSED 127.0.0.1:5432');
    assert.equal(r.kind, 'operator-required');
    assert.equal(r.pattern, 'network-refused');
  });

  test('Claude --print input malformed (defense vs v0.6.8 regression)', () => {
    const r = classifyFailure(
      'Error: Input must be provided either through stdin or as a prompt argument when using --print',
    );
    assert.equal(r.kind, 'operator-required');
    assert.equal(r.pattern, 'claude-input-malformed');
  });
});

describe('classifyFailure — unknown fallthrough', () => {
  test('empty log → unknown', () => {
    assert.equal(classifyFailure('').kind, 'unknown');
  });

  test('novel error → unknown (caller escalates to diagnostic agent)', () => {
    const r = classifyFailure(
      'Internal compiler error: this has never been seen before in nyx failure logs',
    );
    assert.equal(r.kind, 'unknown');
  });
});
