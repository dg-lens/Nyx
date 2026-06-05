import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setNotificationsEnabled } from '../src/notifier.js';
import {
  _setPipelineDb,
  activeRuns,
  createRun,
  getRun,
  getRunByTaskId,
  runsAwaitingDecision,
  updateRun,
} from '../src/pipeline/db.js';
import { assertTransition, canTransition, legalNext } from '../src/pipeline/state-machine.js';
import { _setBriefsDir, advancePipeline, createPipelineRun, resumeDecidedRuns } from '../src/pipeline/orchestrator.js';
import type { PlanningResult } from '../src/pipeline/flight-plan.js';
import type { OperatorDecision, PipelineStatus } from '../src/pipeline/types.js';
import { readQueue } from '../src/task-reader.js';
import type { ParsedTask } from '../src/types.js';

let db: DatabaseSync;

function events(): string[] {
  return (db.prepare(`SELECT event FROM system_audit ORDER BY id ASC`).all() as Array<{ event: string }>).map(
    (r) => r.event,
  );
}

function makeTask(id: string): ParsedTask {
  return {
    id,
    description: `pipeline task ${id}`,
    type: 'pipeline',
    model: 'opus',
    gates: 'none',
    priority: 'normal',
    checked: false,
    rawLines: [`- [ ] ${id} — pipeline task ${id}`],
    startLine: 0,
    endLine: 0,
    invalidTags: [],
  };
}

beforeEach(() => {
  // Single in-memory DB backs both audit + pipeline tables. audit() fires from
  // every orchestrator path, so the audit DB must be stubbed too (matches the
  // composer.test.ts pattern).
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
  // No real Slack from the orchestrator's gate/lifecycle pings during tests.
  _setNotificationsEnabled(false);
  // Redirect gate briefs to a throwaway dir so tests don't touch the real data dir.
  _setBriefsDir(mkdtempSync(join(tmpdir(), 'nyx-brief-')));
});

function fakePlanResult(): PlanningResult {
  return {
    dag: { nodes: [{ id: 'A', description: 'do a', deps: [], type: 'code', target_paths: ['src/a.ts'] }] },
    plans: [
      { task_id: 'A', description: 'do a', deps: [], creates: [], modifies: ['src/a.ts'], consumes: [], preflight: [], scope_boundary: [], acceptance: [] },
    ],
    alignment: { conflicts: [], preflight: [], decisions: [] },
  };
}

describe('state machine', () => {
  test('happy-path transitions are legal', () => {
    assert.ok(canTransition('planning', 'awaiting_preview'));
    assert.ok(canTransition('awaiting_preview', 'executing'));
    assert.ok(canTransition('awaiting_preview', 'replanning'));
    assert.ok(canTransition('replanning', 'awaiting_preview'));
    assert.ok(canTransition('executing', 'shipping'));
    assert.ok(canTransition('executing', 'awaiting_review'));
    assert.ok(canTransition('shipping', 'done'));
    assert.ok(canTransition('shipping', 'awaiting_review'));
    assert.ok(canTransition('awaiting_review', 'shipping'));
    assert.ok(canTransition('awaiting_review', 'executing'));
    assert.ok(canTransition('awaiting_review', 'planning'));
  });

  test('illegal skips are rejected', () => {
    assert.equal(canTransition('planning', 'executing'), false);
    assert.equal(canTransition('planning', 'done'), false);
    assert.equal(canTransition('executing', 'done'), false);
    assert.equal(canTransition('shipping', 'executing'), false);
  });

  test('failed and aborted are universal sinks from any non-terminal status', () => {
    for (const from of ['planning', 'awaiting_preview', 'executing', 'shipping', 'awaiting_review'] as PipelineStatus[]) {
      assert.ok(canTransition(from, 'failed'), `${from} → failed`);
      assert.ok(canTransition(from, 'aborted'), `${from} → aborted`);
    }
  });

  test('terminal statuses have no exits', () => {
    for (const t of ['done', 'aborted', 'failed'] as PipelineStatus[]) {
      assert.deepEqual(legalNext(t), []);
      assert.equal(canTransition(t, 'planning'), false);
      assert.equal(canTransition(t, 'failed'), false);
    }
  });

  test('assertTransition throws on an illegal move', () => {
    assert.throws(() => assertTransition('planning', 'shipping'), /illegal pipeline transition/);
    assert.doesNotThrow(() => assertTransition('planning', 'awaiting_preview'));
  });
});

describe('pipeline_runs db', () => {
  test('create → get roundtrip', () => {
    const run = createRun({ id: 'pr_1', taskId: 'PIPE-1', prompt: 'do a thing', now: 1000 });
    assert.equal(run.status, 'planning');
    assert.equal(run.diagnostic_round, 0);
    assert.equal(run.operator_decision, null);
    const fetched = getRun('pr_1');
    assert.equal(fetched?.task_id, 'PIPE-1');
    assert.equal(fetched?.prompt, 'do a thing');
    assert.equal(fetched?.created_at, 1000);
  });

  test('getRunByTaskId returns the latest run', () => {
    createRun({ id: 'pr_a', taskId: 'PIPE-X', prompt: 'first', now: 1000 });
    createRun({ id: 'pr_b', taskId: 'PIPE-X', prompt: 'second', now: 2000 });
    assert.equal(getRunByTaskId('PIPE-X')?.id, 'pr_b');
    assert.equal(getRunByTaskId('PIPE-MISSING'), null);
  });

  test('updateRun patches columns and serializes operator_decision', () => {
    createRun({ id: 'pr_2', taskId: 'PIPE-2', prompt: 'x', now: 1000 });
    const decision: OperatorDecision = { kind: 'go', auto: true, at: '2026-06-03T00:00:00.000Z' };
    const updated = updateRun(
      'pr_2',
      { status: 'awaiting_preview', current_stage: 'preview_gate', operator_decision: decision, plan_json: '{"a":1}' },
      2000,
    );
    assert.equal(updated?.status, 'awaiting_preview');
    assert.equal(updated?.current_stage, 'preview_gate');
    assert.equal(updated?.plan_json, '{"a":1}');
    assert.deepEqual(updated?.operator_decision, decision);
    assert.equal(updated?.updated_at, 2000);
    // clearing the decision persists as null
    const cleared = updateRun('pr_2', { operator_decision: null }, 3000);
    assert.equal(cleared?.operator_decision, null);
  });

  test('activeRuns excludes terminal statuses', () => {
    createRun({ id: 'pr_live', taskId: 'A', prompt: 'x', now: 1000 });
    createRun({ id: 'pr_done', taskId: 'B', prompt: 'x', now: 1000 });
    updateRun('pr_done', { status: 'done' }, 2000);
    const ids = activeRuns().map((r) => r.id);
    assert.deepEqual(ids, ['pr_live']);
  });

  test('runsAwaitingDecision returns only parked runs with a decision', () => {
    createRun({ id: 'pr_wait_nodec', taskId: 'A', prompt: 'x', now: 1000 });
    updateRun('pr_wait_nodec', { status: 'awaiting_preview' }, 2000);
    createRun({ id: 'pr_wait_dec', taskId: 'B', prompt: 'x', now: 1000 });
    updateRun(
      'pr_wait_dec',
      { status: 'awaiting_review', operator_decision: { kind: 'proceed', at: 'now' } },
      2000,
    );
    const ids = runsAwaitingDecision().map((r) => r.id);
    assert.deepEqual(ids, ['pr_wait_dec']);
  });
});

describe('orchestrator — preview gate', () => {
  const fakePlan = async () => fakePlanResult();
  const fakeExecute = async () => ({ coder_results: [], integration_branch: 'ib', worktree_base: '/tmp/base' });
  const fakeRedux = async () => ({
    facts: [],
    p1: [],
    p2: { system_findings: [], per_task: [], remediation: [], catastrophic: false, catastrophic_reason: '' },
    merged: [],
    held: [],
  });
  const fakeShipGreen = async () => ({ kind: 'green' as const, smoke: { passed: true, summary: 'ok', failures: [] } });
  const fakeDeliver = async () => ({ pr_url: 'https://example/pr/1', pushed: true, deploy_targets: [], matched_files: [], brief: '# delivered' });
  const fakeReduxClean = async () => ({ facts: [], p1: [], p2: { system_findings: [], per_task: [], remediation: [], catastrophic: false, catastrophic_reason: '' }, merged: [], held: [] });

  function twoPhasePlan(): PlanningResult {
    return {
      dag: { nodes: [
        { id: 'MOD', description: 'module', phase: 0, deps: [], type: 'code', target_paths: ['m.ts'] },
        { id: 'TEST', description: 'test', phase: 1, deps: ['MOD'], type: 'code', target_paths: ['m.test.ts'] },
      ] },
      plans: [
        { task_id: 'MOD', description: 'module', phase: 0, deps: [], creates: [], modifies: ['m.ts'], consumes: [], preflight: [], scope_boundary: [], acceptance: [] },
        { task_id: 'TEST', description: 'test', phase: 1, deps: [], creates: [], modifies: ['m.test.ts'], consumes: [], preflight: [], scope_boundary: [], acceptance: [] },
      ],
      alignment: { conflicts: [], preflight: [], decisions: [] },
    };
  }

  test('createPipelineRun starts a planning run + emits pipeline.run.started', () => {
    const run = createPipelineRun(makeTask('PIPE-NEW'));
    assert.equal(run.status, 'planning');
    assert.equal(run.task_id, 'PIPE-NEW');
    assert.deepEqual(events(), ['pipeline.run.started']);
  });

  test('a fresh run plans then PAUSES at the preview gate', async () => {
    const run = createPipelineRun(makeTask('PIPE-FLOW'));
    const final = await advancePipeline(run, { plan: fakePlan });
    assert.equal(final.status, 'awaiting_preview');
    assert.equal(final.current_stage, 'preview_gate');
    assert.ok(final.plan_json, 'plan frozen into plan_json');
    assert.ok(final.bz_brief_path, 'brief written to disk');
    assert.equal(final.operator_decision, null);
    assert.deepEqual(events(), [
      'pipeline.run.started',
      'pipeline.stage.advanced', // planning → awaiting_preview
      'pipeline.preview.delivered',
    ]);
  });

  test('go → coders → redux → green shipping → done', async () => {
    const run = createPipelineRun(makeTask('PIPE-GO'));
    await advancePipeline(run, { plan: fakePlan }); // → awaiting_preview
    updateRun(run.id, { operator_decision: { kind: 'go', at: 'now' } }, Date.now());
    const resumed = await resumeDecidedRuns({ execute: fakeExecute, redux: fakeRedux, ship: fakeShipGreen, deliver: fakeDeliver });
    assert.equal(resumed[0]?.status, 'done');
    const evs = events();
    assert.ok(evs.includes('pipeline.preview.approved'));
    assert.ok(evs.includes('pipeline.executing.started'));
    assert.ok(evs.includes('pipeline.delivered'));
  });

  test('unresolved shipping → review gate (paused), then proceed → done', async () => {
    const run = createPipelineRun(makeTask('PIPE-REV2'));
    await advancePipeline(run, { plan: fakePlan });
    updateRun(run.id, { operator_decision: { kind: 'go', at: 'now' } }, Date.now());
    const fakeShipReview = async () => ({ kind: 'review' as const, reason: 'unresolved' as const, brief: '# review' });
    const afterGo = await resumeDecidedRuns({ execute: fakeExecute, redux: fakeRedux, ship: fakeShipReview });
    assert.equal(afterGo[0]?.status, 'awaiting_review');
    assert.ok(events().includes('pipeline.review.delivered'));
    // operator proceeds → done
    updateRun(run.id, { operator_decision: { kind: 'proceed', at: 'now' } }, Date.now());
    const afterProceed = await resumeDecidedRuns();
    assert.equal(afterProceed[0]?.status, 'done');
    assert.ok(events().includes('pipeline.review.proceed'));
  });

  test('review fix → executing (corrective wave, diagnostic_round reset)', async () => {
    const run = createPipelineRun(makeTask('PIPE-FIX'));
    await advancePipeline(run, { plan: fakePlan });
    updateRun(run.id, { operator_decision: { kind: 'go', at: 'now' }, diagnostic_round: 2 }, Date.now());
    const fakeShipReview = async () => ({ kind: 'review' as const, reason: 'unresolved' as const, brief: '# review' });
    await resumeDecidedRuns({ execute: fakeExecute, redux: fakeRedux, ship: fakeShipReview }); // → awaiting_review
    updateRun(run.id, { operator_decision: { kind: 'fix', note: 'fix the thing', at: 'now' } }, Date.now());
    // fix re-enters executing → coders → redux → ship; green this time → done
    const afterFix = await resumeDecidedRuns({ execute: fakeExecute, redux: fakeRedux, ship: fakeShipGreen, deliver: fakeDeliver });
    assert.equal(afterFix[0]?.status, 'done');
    assert.equal(afterFix[0]?.diagnostic_round, 0, 'corrective wave reset the diagnostic counter');
  });

  test('revise re-runs planning and re-presents the gate (decision cleared)', async () => {
    let planCalls = 0;
    const countingPlan = async () => {
      planCalls++;
      return fakePlanResult();
    };
    const run = createPipelineRun(makeTask('PIPE-REV'));
    await advancePipeline(run, { plan: countingPlan }); // → awaiting_preview (plan #1)
    updateRun(run.id, { operator_decision: { kind: 'revise', note: 'use a different table name', at: 'now' } }, Date.now());
    const resumed = await resumeDecidedRuns({ plan: countingPlan });
    assert.equal(resumed[0]?.status, 'awaiting_preview'); // re-presented, paused again
    assert.equal(resumed[0]?.operator_decision, null); // revise note consumed
    assert.equal(planCalls, 2); // planning ran again
    assert.ok(events().includes('pipeline.preview.revised'));
  });

  test('a parked run with no decision does not advance (and never calls plan)', async () => {
    let called = false;
    createRun({ id: 'pr_park', taskId: 'PIPE-PARK', prompt: 'x', now: 1000 });
    updateRun('pr_park', { status: 'awaiting_preview' }, 1000);
    const after = await advancePipeline(getRun('pr_park')!, { plan: async () => { called = true; return fakePlanResult(); } });
    assert.equal(after.status, 'awaiting_preview');
    assert.equal(called, false);
  });

  test('phases run one-per-tick: go runs phase 0 then YIELDS; next tick runs phase 1 → done', async () => {
    const run = createPipelineRun(makeTask('PIPE-PHASED'));
    await advancePipeline(run, { plan: async () => twoPhasePlan() }); // → awaiting_preview
    updateRun(run.id, { operator_decision: { kind: 'go', at: 'now' } }, Date.now());
    // Tick 1: go → executing phase 0 (clean) → yield (stay executing, current_phase=1).
    const t1 = await resumeDecidedRuns({ execute: fakeExecute, redux: fakeReduxClean, ship: fakeShipGreen, deliver: fakeDeliver });
    assert.equal(t1[0]?.status, 'executing', 'yields in executing between phases');
    assert.equal(t1[0]?.current_phase, 1, 'advanced to phase 1');
    // Tick 2: executing phase 1 (last, clean) → shipping → green → done.
    const t2 = await advancePipeline(getRun(run.id)!, { execute: fakeExecute, redux: fakeReduxClean, ship: fakeShipGreen, deliver: fakeDeliver });
    assert.equal(t2.status, 'done');
  });

  test('a phase that stays held after R1+R2 → review gate', async () => {
    const run = createPipelineRun(makeTask('PIPE-STUCK'));
    await advancePipeline(run, { plan: async () => twoPhasePlan() }); // → awaiting_preview
    updateRun(run.id, { operator_decision: { kind: 'go', at: 'now' } }, Date.now());
    // redux always reports a held task (persisted so heldCount sees it); diagnose can't fix it.
    const fakeReduxHeld = async (r: { id: string }) => {
      updateRun(r.id, { redux_findings: JSON.stringify({ held: ['MOD'], merged: [], catastrophic: false, per_task: [], system_findings: [] }) }, Date.now());
      return { facts: [], p1: [], p2: { system_findings: [], per_task: [], remediation: [], catastrophic: false, catastrophic_reason: '' }, merged: [], held: ['MOD'] };
    };
    let diagnoseCalls = 0;
    const out = await resumeDecidedRuns({ execute: fakeExecute, redux: fakeReduxHeld, diagnose: async () => { diagnoseCalls++; }, ship: fakeShipGreen, deliver: fakeDeliver });
    assert.equal(out[0]?.status, 'awaiting_review');
    assert.equal(diagnoseCalls, 2, 'ran R1 + R2 before escalating');
    assert.ok(events().includes('pipeline.review.delivered'));
  });

  test('an abort decision at the preview gate is a clean terminal', async () => {
    createRun({ id: 'pr_abort', taskId: 'PIPE-AB', prompt: 'x', now: 1000 });
    updateRun('pr_abort', { status: 'awaiting_preview', operator_decision: { kind: 'abort', at: 'now' } }, 1000);
    const after = await advancePipeline(getRun('pr_abort')!);
    assert.equal(after.status, 'aborted');
    assert.ok(events().includes('pipeline.aborted'));
  });
});

describe('task parser', () => {
  test('[type: pipeline] parses with gate none + opus default + no invalid tags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nyx-pipe-'));
    const path = join(dir, 'nyx.md');
    writeFileSync(
      path,
      ['## Active Tasks', '', '- [ ] PIPE-PARSE — build a thing', '      [type: pipeline]', ''].join('\n'),
      'utf8',
    );
    const q = readQueue(path);
    const t = q.active.find((x) => x.id === 'PIPE-PARSE');
    assert.ok(t, 'task parsed');
    assert.equal(t?.type, 'pipeline');
    assert.equal(t?.gates, 'none');
    assert.equal(t?.model, 'opus');
    assert.deepEqual(t?.invalidTags, []);
  });
});
