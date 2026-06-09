import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setPipelineDb, createRun, getRun, updateRun } from '../src/pipeline/db.js';
import {
  coderBranch,
  defaultRunCoder,
  ExecuteError,
  runExecuting,
  scheduleWaves,
  setupIntegrationBase,
  type CoderContext,
  type CoderResult,
} from '../src/pipeline/execute.js';
import { freezePlan, type FlightPlanContract, type PlanningResult } from '../src/pipeline/flight-plan.js';
import type { PipelineRun } from '../src/pipeline/types.js';

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('scheduleWaves', () => {
  test('starts a node only after its deps complete', async () => {
    const started: string[] = [];
    await scheduleWaves(
      [
        { id: 'C', deps: ['B'] },
        { id: 'A', deps: [] },
        { id: 'B', deps: ['A'] },
      ],
      4,
      async (id) => {
        started.push(id);
        await delay(3);
        return id;
      },
    );
    assert.ok(started.indexOf('A') < started.indexOf('B'));
    assert.ok(started.indexOf('B') < started.indexOf('C'));
  });

  test('runs tasks concurrently up to — and never over — the cap', async () => {
    let active = 0;
    let max = 0;
    const nodes = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, deps: [] as string[] }));
    const results = await scheduleWaves(nodes, 2, async (id) => {
      active++;
      max = Math.max(max, active);
      await delay(5);
      active--;
      return id;
    });
    assert.equal(results.length, 5);
    // EXACTLY the cap, not just ≤: proves the scheduler actually parallelizes.
    // A serial scheduler would peak at 1 and fail this.
    assert.equal(max, 2, `expected 2 tasks running at once; saw peak ${max}`);
  });

  test('with cap ≥ task count, ALL independent tasks run at once', async () => {
    let active = 0;
    let max = 0;
    const nodes = ['A', 'B', 'C', 'D'].map((id) => ({ id, deps: [] as string[] }));
    await scheduleWaves(nodes, 4, async (id) => {
      active++;
      max = Math.max(max, active);
      await delay(5);
      active--;
      return id;
    });
    assert.equal(max, 4, `all 4 independent tasks should run simultaneously; saw peak ${max}`);
  });

  test('a dependency cycle still completes every node', async () => {
    const results = await scheduleWaves(
      [
        { id: 'X', deps: ['Y'] },
        { id: 'Y', deps: ['X'] },
      ],
      4,
      async (id) => id,
    );
    assert.deepEqual(results.map((r) => r.id).sort(), ['X', 'Y']);
  });
});

function fp(taskId: string, deps: string[] = []): FlightPlanContract {
  return {
    task_id: taskId,
    description: `do ${taskId}`,
    deps,
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

describe('runExecuting (injected coder + base)', () => {
  test('runs every coder and persists results onto the run', async () => {
    const run = createRun({ id: 'pr_exec', taskId: 'T', prompt: 'build it', repo: 'org/repo', now: 1000 });
    updateRun('pr_exec', { status: 'executing', plan_json: freezePlan(planWith([fp('A'), fp('B', ['A'])])) }, 1000);

    const seen: string[] = [];
    const fakeCoder = async (ctx: CoderContext): Promise<CoderResult> => {
      seen.push(ctx.plan.task_id);
      return {
        task_id: ctx.plan.task_id,
        branch: coderBranch(ctx.run.id, ctx.plan.task_id),
        status: 'committed',
        commit: `sha-${ctx.plan.task_id}`,
        files_changed: ctx.plan.modifies,
        exit_code: 0,
        log: '',
      };
    };

    const result = await runExecuting(getRun('pr_exec')!, {
      runCoder: fakeCoder,
      base: { basePath: '/tmp/fake-base', integrationBranch: 'ib' },
    });

    assert.equal(result.coder_results.length, 2);
    assert.deepEqual(seen.sort(), ['A', 'B']);
    const persisted = getRun('pr_exec');
    assert.equal(persisted?.integration_branch, 'ib');
    assert.equal(persisted?.worktree_base, '/tmp/fake-base');
    const stored = JSON.parse(persisted!.coder_results!) as CoderResult[];
    assert.equal(stored.length, 2);
    assert.equal(stored[0]?.status, 'committed');
  });

  test('throws when the run has no frozen plan', async () => {
    createRun({ id: 'pr_noplan', taskId: 'T', prompt: 'x', now: 1000 });
    updateRun('pr_noplan', { status: 'executing' }, 1000);
    await assert.rejects(runExecuting(getRun('pr_noplan')!, { base: { basePath: '/x', integrationBranch: 'ib' } }));
  });
});

describe('defaultRunCoder (real git worktree)', () => {
  function gitInitBase(dir: string): void {
    const g = (c: string): void => { execSync(c, { cwd: dir, stdio: 'ignore' }); };
    g('git init -q');
    g('git config user.email t@t.t');
    g('git config user.name tester');
    writeFileSync(resolve(dir, 'README.md'), 'base\n');
    g('git add -A');
    g('git commit -q -m base');
    g('git checkout -q -B integration');
  }

  function minimalRun(id: string): PipelineRun {
    return {
      id, task_id: 'T', prompt: 'build', repo: null, status: 'executing', current_stage: null,
      plan_json: null, authorities: null, bz_brief_path: null, operator_decision: null,
      integration_branch: null, redux_findings: null, remediation_plan: null, diagnostic_round: 0,
      cost_actuals: null, worktree_base: null, coder_results: null, fix_directive: null, error: null, created_at: 0, updated_at: 0,
    };
  }

  test('adds a worktree, lets the coder write, and commits the result', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nyx-base-'));
    gitInitBase(base);
    const run = minimalRun(`pr_rc_${Date.now().toString(36)}`);
    const plan = fp('A');
    const wtPath = `/tmp/nyx-clone-${run.id}-wt-a`;
    try {
      const result = await defaultRunCoder({
        run,
        plan,
        basePath: base,
        fromRef: 'integration',
        spawn: async (a) => {
          writeFileSync(resolve(a.workingDir, 'feature.txt'), 'coder output\n');
          return { exitCode: 0, stderr: '' };
        },
      });
      assert.equal(result.status, 'committed');
      assert.ok(result.commit, 'commit sha recorded');
      assert.ok(result.files_changed.includes('feature.txt'));
      assert.equal(result.branch, coderBranch(run.id, 'A'));
    } finally {
      try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: base, stdio: 'ignore' }); } catch { /* */ }
      rmSync(base, { recursive: true, force: true });
      rmSync(wtPath, { recursive: true, force: true });
    }
  });

  test('reports no_changes when the coder writes nothing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nyx-base-'));
    gitInitBase(base);
    const run = minimalRun(`pr_nc_${Date.now().toString(36)}`);
    const wtPath = `/tmp/nyx-clone-${run.id}-wt-a`;
    try {
      const result = await defaultRunCoder({
        run, plan: fp('A'), basePath: base, fromRef: 'integration',
        spawn: async () => ({ exitCode: 0, stderr: '' }),
      });
      assert.equal(result.status, 'no_changes');
      assert.equal(result.commit, null);
    } finally {
      try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: base, stdio: 'ignore' }); } catch { /* */ }
      rmSync(base, { recursive: true, force: true });
      rmSync(wtPath, { recursive: true, force: true });
    }
  });
});

describe('setupIntegrationBase (C1 self-mode data-loss guard)', () => {
  test('throws for a self-mode run (no repo) instead of building in /tmp', () => {
    const run = createRun({ id: 'pr_SELFTEST_a', taskId: 'SELFTEST', prompt: 'build a snake game', repo: null, now: 1 });
    assert.throws(
      () => setupIntegrationBase(run, { id: 'SELFTEST', description: 'build a snake game' }),
      (e: unknown) => e instanceof ExecuteError && /self-mode pipeline is unsupported/.test((e as Error).message),
    );
  });

  test('throws for an invalid repo (typo, not owner/name or greenfield keyword)', () => {
    const run = createRun({ id: 'pr_BADREPO_a', taskId: 'BADREPO', prompt: 'x', repo: 'employee-portal', now: 1 });
    assert.throws(
      () => setupIntegrationBase(run, { id: 'BADREPO', description: 'x', repo: 'employee-portal' }),
      ExecuteError,
    );
  });
});
