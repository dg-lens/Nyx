import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setSecretsDb } from '../src/secrets/db-schema.js';
import {
  findProjectByName,
  findProjectByRepo,
  listProjects,
  registerProject,
  resolveProjectToken,
} from '../src/secrets/project-registry.js';
import type { ParsedTask } from '../src/types.js';

const BASE: Omit<ParsedTask, 'type'> = {
  id: 'X',
  description: 'x',
  model: 'haiku',
  gates: 'none',
  priority: 'normal',
  checked: false,
  rawLines: [],
  startLine: 0,
  endLine: 0,
  invalidTags: [],
};

function task(extra: Partial<ParsedTask> = {}): ParsedTask {
  return { ...BASE, type: 'code', ...extra };
}

// Use one in-memory SQLite for both audit and secrets so registerProject's
// audit() call doesn't try to lock the real ~/Nyx/data/nyx.db.
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE bitwarden_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      bw_project_id TEXT NOT NULL,
      bw_machine_account_id TEXT NOT NULL,
      token_path TEXT NOT NULL,
      repos_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
  `);
  _setSecretsDb(db);
  _setAuditDb(db);
});
afterEach(() => {
  _setSecretsDb(null);
  _setAuditDb(null);
  db.close();
});

describe('project-registry', () => {
  test('registerProject + findProjectByName round-trip', () => {
    registerProject({
      name: 'lens',
      bwProjectId: 'p-1',
      bwMachineAccountId: 'm-1',
      tokenPath: '/tmp/lens.token',
      repos: ['lens-cx/site-dev'],
      createdBy: 'test',
    });
    const p = findProjectByName('lens');
    assert.ok(p);
    assert.equal(p.bw_project_id, 'p-1');
    assert.deepEqual(p.repos, ['lens-cx/site-dev']);
  });

  test('registerProject is idempotent on name conflict', () => {
    registerProject({ name: 'a', bwProjectId: 'p-1', bwMachineAccountId: 'm-1', tokenPath: '/tmp/a.token' });
    registerProject({ name: 'a', bwProjectId: 'p-2', bwMachineAccountId: 'm-2', tokenPath: '/tmp/a2.token' });
    const p = findProjectByName('a');
    assert.equal(p!.bw_project_id, 'p-2');
    assert.equal(listProjects().length, 1);
  });

  test('findProjectByRepo matches a repo inside repos_json', () => {
    registerProject({
      name: 'lens',
      bwProjectId: 'p-1',
      bwMachineAccountId: 'm-1',
      tokenPath: '/tmp/lens.token',
      repos: ['lens-cx/site-dev', 'lens-cx/api'],
    });
    assert.equal(findProjectByRepo('lens-cx/api')?.name, 'lens');
    assert.equal(findProjectByRepo('other/repo'), null);
  });

  test('resolveProjectToken: bw-project tag wins over repo', () => {
    registerProject({ name: 'lens', bwProjectId: 'p-1', bwMachineAccountId: 'm-1', tokenPath: '/tmp/lens.token', repos: ['lens-cx/site-dev'] });
    registerProject({ name: 'other', bwProjectId: 'p-2', bwMachineAccountId: 'm-2', tokenPath: '/tmp/other.token' });

    const t = task({ repo: 'lens-cx/site-dev', rawLines: ['  [bw-project: other]'] });
    assert.equal(resolveProjectToken(t), '/tmp/other.token');
  });

  test('resolveProjectToken: repo-only fallback', () => {
    registerProject({ name: 'lens', bwProjectId: 'p-1', bwMachineAccountId: 'm-1', tokenPath: '/tmp/lens.token', repos: ['lens-cx/site-dev'] });
    const t = task({ repo: 'lens-cx/site-dev' });
    assert.equal(resolveProjectToken(t), '/tmp/lens.token');
  });

  test('resolveProjectToken: no match → null', () => {
    const t = task({ repo: 'unknown/repo' });
    assert.equal(resolveProjectToken(t), null);
  });

  test('resolveProjectToken: bw-project tag that does not resolve → null (does NOT fall back to repo)', () => {
    registerProject({ name: 'lens', bwProjectId: 'p-1', bwMachineAccountId: 'm-1', tokenPath: '/tmp/lens.token', repos: ['lens-cx/site-dev'] });
    const t = task({ repo: 'lens-cx/site-dev', rawLines: ['  [bw-project: ghost]'] });
    assert.equal(resolveProjectToken(t), null);
  });
});
