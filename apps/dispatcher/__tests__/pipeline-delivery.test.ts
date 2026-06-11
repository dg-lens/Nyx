import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setPipelineDb, createRun, getRun, updateRun } from '../src/pipeline/db.js';
import { buildDeliveryBrief, cleanupRunArtifacts, runDelivery } from '../src/pipeline/delivery.js';
import type { PipelineRun } from '../src/pipeline/types.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
});

function seed(id: string, patch: Partial<PipelineRun> = {}): PipelineRun {
  createRun({ id, taskId: 'T', prompt: 'build the foo feature', repo: patch.repo ?? null, now: 1000 });
  updateRun(id, { status: 'shipping', redux_findings: JSON.stringify({ merged: ['A', 'B'], held: [] }), ...patch }, 1000);
  return getRun(id)!;
}

describe('buildDeliveryBrief', () => {
  test('renders the PR link, integrated count, deploy targets, and manual-deploy note', () => {
    const run = seed('pr_brief', { repo: 'org/repo' });
    const brief = buildDeliveryBrief(run, { pr_url: 'https://github.com/org/repo/pull/7', deploy_targets: ['Fly: lens-marketing-api'] });
    assert.match(brief, /# Delivered — pr_brief/);
    assert.match(brief, /PR \(review \+ merge\):\*\* https:\/\/github.com\/org\/repo\/pull\/7/);
    assert.match(brief, /Integrated:\*\* 2 task/);
    assert.match(brief, /Manual deploy required/);
    assert.match(brief, /Fly: lens-marketing-api/);
    assert.match(brief, /Deploy is your manual step/);
  });

  test('falls back to the integration branch when there is no PR (no-repo run)', () => {
    const run = seed('pr_nopr', { integration_branch: 'nyx-pipeline/x/integration', worktree_base: '/tmp/base' });
    const brief = buildDeliveryBrief(run, { pr_url: null, deploy_targets: [] });
    assert.match(brief, /Integration branch:\*\* nyx-pipeline\/x\/integration/);
    assert.doesNotMatch(brief, /Manual deploy required/);
  });

  test('greenfield run points at the local project dir, not a PR or manual-deploy note', () => {
    const run = seed('pr_green', { repo: 'local', integration_branch: 'nyx-pipeline/x/integration', worktree_base: '/data/projects/T' });
    const brief = buildDeliveryBrief(run, { pr_url: null, deploy_targets: [] });
    assert.match(brief, /New local project:\*\* `\/data\/projects\/T`/);
    assert.match(brief, /Your new project lives at `\/data\/projects\/T`/);
    assert.doesNotMatch(brief, /Deploy is your manual step/);
    assert.doesNotMatch(brief, /PR \(review/);
  });

  test('app run points at the app path (worktree_base), not a PR', () => {
    const run = seed('pr_app', { repo: 'app:noted', integration_branch: 'nyx-pipeline/x/integration', worktree_base: '/home/op/Nyx/Apps/noted' });
    const brief = buildDeliveryBrief(run, { pr_url: null, deploy_targets: [] });
    assert.match(brief, /New local project:\*\* `\/home\/op\/Nyx\/Apps\/noted`/);
    assert.match(brief, /Your new project lives at `\/home\/op\/Nyx\/Apps\/noted`/);
    assert.doesNotMatch(brief, /Deploy is your manual step/);
    assert.doesNotMatch(brief, /PR \(review/);
  });
});

describe('runDelivery', () => {
  test('opens a PR via the injected push and returns the result (no deploy match)', async () => {
    const run = seed('pr_deliver', { repo: 'example-org/example-repo', worktree_base: '/nonexistent-base' });
    let pushed = false;
    const result = await runDelivery(run, {
      push: () => { pushed = true; return 'https://github.com/example-org/example-repo/pull/9'; },
      skipCleanup: true,
    });
    assert.equal(pushed, true);
    assert.equal(result.pr_url, 'https://github.com/example-org/example-repo/pull/9');
    assert.equal(result.pushed, true);
    // /nonexistent-base isn't a git repo → changedFiles returns [] → no deploy targets.
    assert.deepEqual(result.deploy_targets, []);
  });

  test('no-repo run skips the push (pr_url null) but still produces a brief', async () => {
    const run = seed('pr_norepo', { worktree_base: '/tmp/whatever' });
    let pushed = false;
    const result = await runDelivery(run, { push: () => { pushed = true; return 'x'; }, skipCleanup: true });
    assert.equal(pushed, false, 'no repo → push not attempted');
    assert.equal(result.pr_url, null);
    assert.match(result.brief, /# Delivered/);
  });

  test('greenfield run (repo: local) skips the push — local project has no remote', async () => {
    const run = seed('pr_greendeliver', { repo: 'local', worktree_base: '/tmp/whatever' });
    let pushed = false;
    const result = await runDelivery(run, { push: () => { pushed = true; return 'x'; }, skipCleanup: true });
    assert.equal(pushed, false, 'greenfield → push not attempted');
    assert.equal(result.pr_url, null);
  });

  test('app run (repo: app:<slug>) skips the push — app dir has no remote', async () => {
    const run = seed('pr_appdeliver', { repo: 'app:noted', worktree_base: '/tmp/whatever' });
    let pushed = false;
    const result = await runDelivery(run, { push: () => { pushed = true; return 'x'; }, skipCleanup: true });
    assert.equal(pushed, false, 'app → push not attempted');
    assert.equal(result.pr_url, null);
  });
});

describe('cleanupRunArtifacts', () => {
  test('removes the base clone directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'nyx-delbase-'));
    writeFileSync(resolve(base, 'f.txt'), 'x');
    const run = seed('pr_clean', { worktree_base: base });
    assert.ok(existsSync(base));
    cleanupRunArtifacts(run);
    assert.equal(existsSync(base), false);
  });

  test('is a no-op when there is no base (never throws)', () => {
    const run = seed('pr_nobase');
    assert.doesNotThrow(() => cleanupRunArtifacts(run));
  });

  test('greenfield run KEEPS its base — the project dir is the deliverable', () => {
    const base = mkdtempSync(join(tmpdir(), 'nyx-greenbase-'));
    writeFileSync(resolve(base, 'package.json'), '{}');
    const run = seed('pr_greenkeep', { repo: 'local', worktree_base: base });
    cleanupRunArtifacts(run);
    assert.equal(existsSync(base), true, 'greenfield project dir must survive cleanup');
  });

  test('app run KEEPS its base — fires on failPipelineRun too, so a mid-run failure must not delete the app', () => {
    const base = mkdtempSync(join(tmpdir(), 'nyx-appbase-'));
    writeFileSync(resolve(base, 'package.json'), '{}');
    const run = seed('pr_appkeep', { repo: 'app:noted', worktree_base: base });
    cleanupRunArtifacts(run);
    assert.equal(existsSync(base), true, 'app dir must survive cleanup');
  });
});
