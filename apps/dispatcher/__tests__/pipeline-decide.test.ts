import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setPipelineDb, createRun, getRun, updateRun } from '../src/pipeline/db.js';
import { submitDecision } from '../src/pipeline/decide.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
});

function runAt(id: string, status: 'planning' | 'awaiting_preview' | 'awaiting_review' | 'done'): void {
  createRun({ id, taskId: 'T', prompt: 'x', now: 1000 });
  if (status !== 'planning') updateRun(id, { status }, 1000);
}

describe('submitDecision', () => {
  test('rejects an unknown run', () => {
    const r = submitDecision('nope', 'go');
    assert.equal(r.ok, false);
    assert.match(r.message, /no pipeline run/);
  });

  test('rejects when the run is not waiting at a gate', () => {
    runAt('pr_plan', 'planning');
    assert.equal(submitDecision('pr_plan', 'go').ok, false);
    runAt('pr_done', 'done');
    assert.equal(submitDecision('pr_done', 'go').ok, false);
  });

  test('rejects a review verb at the preview gate (and vice versa)', () => {
    runAt('pr_prev', 'awaiting_preview');
    assert.equal(submitDecision('pr_prev', 'proceed').ok, false);
    runAt('pr_rev', 'awaiting_review');
    assert.equal(submitDecision('pr_rev', 'go').ok, false);
  });

  test('revise and fix require a note', () => {
    runAt('pr_prev', 'awaiting_preview');
    assert.equal(submitDecision('pr_prev', 'revise').ok, false);
    assert.equal(submitDecision('pr_prev', 'revise', { note: 'change the table name' }).ok, true);
    runAt('pr_rev', 'awaiting_review');
    assert.equal(submitDecision('pr_rev', 'fix').ok, false);
    assert.equal(submitDecision('pr_rev', 'fix', { note: 'patch B' }).ok, true);
  });

  test('go at the preview gate records the decision + emits the event', () => {
    runAt('pr_go', 'awaiting_preview');
    const r = submitDecision('pr_go', 'go', { source: 'cli' });
    assert.equal(r.ok, true);
    assert.equal(getRun('pr_go')?.operator_decision?.kind, 'go');
    const events = (db.prepare(`SELECT event FROM system_audit`).all() as Array<{ event: string }>).map((e) => e.event);
    assert.ok(events.includes('pipeline.decision.submitted'));
  });

  test('proceed at the review gate is accepted', () => {
    runAt('pr_proc', 'awaiting_review');
    assert.equal(submitDecision('pr_proc', 'proceed').ok, true);
    assert.equal(getRun('pr_proc')?.operator_decision?.kind, 'proceed');
  });

  test('abort is valid at either gate', () => {
    runAt('pr_a', 'awaiting_preview');
    assert.equal(submitDecision('pr_a', 'abort').ok, true);
    runAt('pr_b', 'awaiting_review');
    assert.equal(submitDecision('pr_b', 'abort').ok, true);
  });
});
