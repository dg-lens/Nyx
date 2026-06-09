import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setPipelineDb, createRun, getRun, updateRun } from '../src/pipeline/db.js';
import {
  MAX_AUTONOMOUS_DIAGNOSTIC_ROUNDS,
  buildReviewBrief,
  classifyDiagnosticFix,
  interpretSmoke,
  reviewRecommendation,
  runShipping,
  type SmokeResult,
} from '../src/pipeline/shipping.js';
import type { PipelineRun } from '../src/pipeline/types.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
});

function seed(id: string, findings: { held: string[]; merged?: string[]; catastrophic?: boolean }): PipelineRun {
  createRun({ id, taskId: 'T', prompt: 'build it', now: 1000 });
  updateRun(
    id,
    {
      status: 'shipping',
      redux_findings: JSON.stringify({ held: findings.held, merged: findings.merged ?? [], catastrophic: findings.catastrophic ?? false, per_task: [], system_findings: [] }),
      remediation_plan: JSON.stringify(findings.held.map((t) => ({ task_id: t, problem: `${t} broke`, target_state: `fix ${t}` }))),
    },
    1000,
  );
  return getRun(id)!;
}

const pass: SmokeResult = { passed: true, summary: 'gate green', failures: [] };
const fail: SmokeResult = { passed: false, summary: 'gate red', failures: ['tsc error'] };

describe('runShipping (final smoke only — per-phase recovery is in executing)', () => {
  test('green smoke + nothing held → green', async () => {
    const run = seed('pr_green', { held: [], merged: ['A', 'B'] });
    const outcome = await runShipping(run, { smoke: async () => pass });
    assert.equal(outcome.kind, 'green');
  });

  test('failing smoke → review (unresolved)', async () => {
    const run = seed('pr_fail', { held: [], merged: ['A'] });
    const outcome = await runShipping(run, { smoke: async () => fail });
    assert.equal(outcome.kind, 'review');
    assert.equal(outcome.kind === 'review' && outcome.reason, 'unresolved');
  });

  test('held tasks block green even if smoke passes', async () => {
    const run = seed('pr_held', { held: ['A'] });
    const outcome = await runShipping(run, { smoke: async () => pass });
    assert.equal(outcome.kind, 'review');
  });
});

describe('interpretSmoke (hermetic guard)', () => {
  test('a dirty tree invalidates the run — the verifier mutated the tree', () => {
    // The PIPE-SMOKE cheat: supervisor reported passed=true after writing the module.
    const r = interpretSmoke(JSON.stringify({ passed: true, summary: 'all good', failures: [] }), '?? src/lib/pipeline-smoke.ts');
    assert.equal(r.passed, false);
    assert.match(r.summary, /INVALID|read-only/i);
    assert.ok(r.failures.some((f) => f.includes('pipeline-smoke.ts')));
  });

  test('clean tree + passing verdict → passed', () => {
    const r = interpretSmoke(JSON.stringify({ passed: true, summary: 'ran vitest, 104 ok', failures: [] }), '');
    assert.equal(r.passed, true);
    assert.equal(r.summary, 'ran vitest, 104 ok');
  });

  test('clean tree + failing verdict → failed with failures', () => {
    const r = interpretSmoke(JSON.stringify({ passed: false, summary: 'tsc errors', failures: ['TS2307'] }), '   ');
    assert.equal(r.passed, false);
    assert.deepEqual(r.failures, ['TS2307']);
  });

  test('clean tree + garbage stdout → failed (no usable verdict)', () => {
    const r = interpretSmoke('the gate is probably fine i think', '');
    assert.equal(r.passed, false);
    assert.match(r.summary, /no usable verdict/);
  });
});

describe('classifyDiagnosticFix', () => {
  test('a no-op fix did not land', () => {
    assert.deepEqual(classifyDiagnosticFix([], ['src/a.ts']), { landed: false, strayed: [] });
  });
  test('an in-scope fix landed cleanly', () => {
    assert.deepEqual(classifyDiagnosticFix(['src/a.ts'], ['src/a.ts', 'src/b.ts']), { landed: true, strayed: [] });
  });
  test('an out-of-scope fix is flagged strayed', () => {
    assert.deepEqual(classifyDiagnosticFix(['src/a.ts', 'src/evil.ts'], ['src/a.ts']), { landed: true, strayed: ['src/evil.ts'] });
  });
  test('no allow-list → cannot judge stray (permissive)', () => {
    assert.deepEqual(classifyDiagnosticFix(['x.ts'], []), { landed: true, strayed: [] });
  });
});

describe('reviewRecommendation', () => {
  test('catastrophic → rollback/abort headline', () => {
    const run = seed('pr_cat2', { held: ['A'], catastrophic: true });
    assert.match(reviewRecommendation(getRun('pr_cat2')!, 'catastrophic', null), /CATASTROPHIC/);
  });
  test('unresolved → names held tasks + the fix/proceed choice', () => {
    const run = seed('pr_un', { held: ['A'], merged: ['B'] });
    const rec = reviewRecommendation(getRun('pr_un')!, 'unresolved', fail);
    assert.match(rec, /NEEDS REVIEW/);
    assert.match(rec, /A/);
    assert.match(rec, /fix.*proceed/);
  });
});

describe('buildReviewBrief', () => {
  test('leads with recommendation + decide commands; details collapsed; NO prompt echo', () => {
    const run = seed('pr_brief', { held: ['A'], merged: ['B'] });
    const brief = buildReviewBrief(getRun('pr_brief')!, 'unresolved', fail);
    assert.match(brief, /# Review gate — pr_brief/);
    assert.match(brief, /\*\*NEEDS REVIEW/);
    assert.match(brief, /nyx pipeline proceed pr_brief/);
    assert.match(brief, /nyx pipeline fix pr_brief/);
    assert.match(brief, /Integrated: B · Held: A/);
    // detail collapsed
    assert.match(brief, /<details><summary>Details/);
    assert.match(brief, /tsc error/);
    assert.match(brief, /A: A broke → fix A/);
    assert.doesNotMatch(brief, /build it/); // the run prompt is not echoed
  });

  test('base_missing renders ONLY rollback/abort — accept/proceed/fix would fail on a vanished base', () => {
    const run = seed('pr_basemissing', { held: ['A'], merged: ['B'] });
    const brief = buildReviewBrief(getRun('pr_basemissing')!, 'base_missing', null);
    assert.match(brief, /BASE MISSING/);
    assert.match(brief, /nyx pipeline rollback pr_basemissing/);
    assert.match(brief, /nyx pipeline abort pr_basemissing/);
    // accept/proceed/fix all operate against the (now-vanished) base — they must
    // not be offered, or the operator will run a command that's guaranteed to fail.
    assert.doesNotMatch(brief, /nyx pipeline accept/);
    assert.doesNotMatch(brief, /nyx pipeline proceed/);
    assert.doesNotMatch(brief, /nyx pipeline fix/);
  });
});
