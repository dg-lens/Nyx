import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb, appendChainRow } from '../src/audit.js';
import { _setNotificationsEnabled } from '../src/notifier.js';
import {
  _setPipelineDb,
  checkpointTransition,
  claimRunForResume,
  completedPhases,
  createRun,
  getRun,
  markPhaseCompleted,
  releaseResumeLease,
  updateRun,
  RESUME_LEASE_MS,
} from '../src/pipeline/db.js';
import { BaseMissingError, runExecuting } from '../src/pipeline/execute.js';
import { freezePlan, type FlightPlanContract, type PlanningResult } from '../src/pipeline/flight-plan.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
  _setNotificationsEnabled(false);
});

function fp(taskId: string): FlightPlanContract {
  return {
    task_id: taskId,
    description: `do ${taskId}`,
    deps: [],
    creates: [],
    modifies: [`src/${taskId}.ts`],
    consumes: [],
    preflight: [],
    scope_boundary: [],
    acceptance: [],
  };
}

function planWith(plans: FlightPlanContract[]): PlanningResult {
  return {
    dag: { nodes: plans.map((p) => ({ id: p.task_id, description: p.description, deps: p.deps, type: 'code', target_paths: p.modifies })) },
    plans,
    alignment: { conflicts: [], preflight: [], decisions: [] },
  };
}

/** Arm a run at a gate with a decision so it is claimable by the resume CAS. */
function armedRun(id: string, now: number) {
  createRun({ id, taskId: 'T', prompt: 'p', repo: 'org/repo', now });
  updateRun(id, { status: 'awaiting_preview', operator_decision: { kind: 'go', at: 'now' } }, now);
}

describe('resume-lease CAS', () => {
  test('two concurrent resumes of one armed run — exactly one wins', () => {
    armedRun('pr_race', 1000);
    const a = claimRunForResume('pr_race', 2000);
    const b = claimRunForResume('pr_race', 2000); // same tick, second racer
    const wins = [a, b].filter((r) => r !== null);
    assert.equal(wins.length, 1, 'exactly one tick may claim the run');
    assert.ok(a, 'first claim wins');
    assert.equal(b, null, 'second claim is fenced out');
    // The winner's row carries a future-dated lease.
    assert.ok((a!.resume_lease ?? 0) > 2000);
  });

  test('a fenced racer leaves the decision intact for the winner to consume', () => {
    armedRun('pr_intact', 1000);
    claimRunForResume('pr_intact', 2000);
    const loser = claimRunForResume('pr_intact', 2000);
    assert.equal(loser, null);
    // The decision is still armed — the winner (not modeled here) will consume it.
    assert.equal(getRun('pr_intact')?.operator_decision?.kind, 'go');
  });

  test('a run with no decision is never claimable (not armed)', () => {
    createRun({ id: 'pr_nodecision', taskId: 'T', prompt: 'p', repo: 'org/repo', now: 1000 });
    updateRun('pr_nodecision', { status: 'awaiting_preview' }, 1000);
    assert.equal(claimRunForResume('pr_nodecision', 2000), null);
  });

  test('a non-awaiting run is never claimable even with a stale decision row', () => {
    createRun({ id: 'pr_executing', taskId: 'T', prompt: 'p', repo: 'org/repo', now: 1000 });
    updateRun('pr_executing', { status: 'executing', operator_decision: { kind: 'go', at: 'now' } }, 1000);
    assert.equal(claimRunForResume('pr_executing', 2000), null);
  });

  test('an expired lease may be re-claimed (crashed-tick recovery)', () => {
    armedRun('pr_stale', 1000);
    const first = claimRunForResume('pr_stale', 2000);
    assert.ok(first);
    // A second racer in the SAME window is fenced.
    assert.equal(claimRunForResume('pr_stale', 2000), null);
    // After the lease TTL elapses, a later tick reclaims the still-armed run
    // (the prior owner crashed without consuming the decision).
    const recovered = claimRunForResume('pr_stale', 2000 + RESUME_LEASE_MS + 1);
    assert.ok(recovered, 'expired lease is reclaimable');
  });

  test('releaseResumeLease frees a claim for an immediate re-claim', () => {
    armedRun('pr_release', 1000);
    assert.ok(claimRunForResume('pr_release', 2000));
    assert.equal(claimRunForResume('pr_release', 2001), null);
    releaseResumeLease('pr_release', 2002);
    assert.ok(claimRunForResume('pr_release', 2003), 'released lease is immediately re-claimable');
  });
});

describe('existsSync base-revalidation guard (M2)', () => {
  test('reusing a worktree_base that no longer exists throws BaseMissingError', async () => {
    const gonePath = '/tmp/nyx-replay-test-base-does-not-exist-xyz';
    assert.equal(existsSync(gonePath), false, 'precondition: base dir is absent');
    createRun({ id: 'pr_gone', taskId: 'T', prompt: 'build', repo: 'org/repo', now: 1000 });
    // Reuse path: worktree_base + integration_branch both set (a multi-phase
    // run resuming on a later tick), but the /tmp base was evicted.
    updateRun(
      'pr_gone',
      {
        status: 'executing',
        plan_json: freezePlan(planWith([fp('A')])),
        worktree_base: gonePath,
        integration_branch: 'nyx-pipeline/pr_gone/integration',
      },
      1000,
    );
    await assert.rejects(
      runExecuting(getRun('pr_gone')!, {}),
      (err: unknown) => err instanceof BaseMissingError,
      'a vanished reused base must surface as BaseMissingError, not a raw ENOENT',
    );
  });

  test('an explicit deps.base bypasses the guard (tests inject a base)', async () => {
    createRun({ id: 'pr_injected', taskId: 'T', prompt: 'build', repo: 'org/repo', now: 1000 });
    updateRun('pr_injected', { status: 'executing', plan_json: freezePlan(planWith([fp('A')])) }, 1000);
    // deps.base is honored verbatim — no existsSync check on an injected base.
    const result = await runExecuting(getRun('pr_injected')!, {
      base: { basePath: '/tmp/whatever-not-checked', integrationBranch: 'ib' },
      runCoder: async (ctx) => ({
        task_id: ctx.plan.task_id,
        branch: 'b',
        status: 'committed',
        commit: 'sha',
        files_changed: ['src/A.ts'],
        exit_code: 0,
        log: '',
      }),
    });
    assert.equal(result.worktree_base, '/tmp/whatever-not-checked');
  });
});

describe('completed-phases projection (P3 replay)', () => {
  test('markPhaseCompleted is idempotent and sorted-unique', () => {
    createRun({ id: 'pr_phases', taskId: 'T', prompt: 'p', repo: 'org/repo', now: 1000 });
    assert.deepEqual(completedPhases('pr_phases'), []);
    markPhaseCompleted('pr_phases', 1, 1001);
    markPhaseCompleted('pr_phases', 0, 1002);
    markPhaseCompleted('pr_phases', 1, 1003); // duplicate — no-op
    assert.deepEqual(completedPhases('pr_phases'), [0, 1], 'sorted, deduped');
  });

  test('completedPhases of an absent run is empty (no throw)', () => {
    assert.deepEqual(completedPhases('pr_missing'), []);
  });
});

describe('same-transaction checkpoint', () => {
  test('commits the state patch and the audit event together', () => {
    createRun({ id: 'pr_ckpt', taskId: 'T', prompt: 'p', repo: 'org/repo', now: 1000 });
    let emitted = false;
    const updated = checkpointTransition(
      'pr_ckpt',
      { status: 'awaiting_preview', current_stage: 'preview_gate' },
      2000,
      () => {
        emitted = true;
        appendChainRow('pipeline.stage.advanced', 'pipeline', { runId: 'pr_ckpt' });
      },
    );
    assert.ok(emitted);
    assert.equal(updated?.status, 'awaiting_preview');
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM system_audit`).get() as { n: number };
    assert.equal(rows.n, 1, 'the audit row committed with the state patch');
  });

  test('a throw in the emit callback rolls back the state patch', () => {
    createRun({ id: 'pr_rollback', taskId: 'T', prompt: 'p', repo: 'org/repo', now: 1000 });
    const before = getRun('pr_rollback')?.status;
    assert.throws(() =>
      checkpointTransition('pr_rollback', { status: 'awaiting_preview' }, 2000, () => {
        throw new Error('boom');
      }),
    );
    // The status patch must NOT have persisted — row + chain stay in agreement.
    assert.equal(getRun('pr_rollback')?.status, before, 'state rolled back on audit failure');
  });
});
