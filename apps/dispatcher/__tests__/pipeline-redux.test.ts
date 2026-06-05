import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setPipelineDb, createRun, getRun, updateRun } from '../src/pipeline/db.js';
import { freezePlan, type FlightPlanContract, type PlanningResult } from '../src/pipeline/flight-plan.js';
import type { CoderResult } from '../src/pipeline/execute.js';
import { decideMerges, runRedux, type P1Finding, type P2Result } from '../src/pipeline/redux.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setPipelineDb(db);
});

function events(): string[] {
  return (db.prepare(`SELECT event FROM system_audit ORDER BY id ASC`).all() as Array<{ event: string }>).map((r) => r.event);
}

function fp(taskId: string, deps: string[] = []): FlightPlanContract {
  return { task_id: taskId, description: `do ${taskId}`, deps, creates: [], modifies: [], consumes: [], preflight: [], scope_boundary: [], acceptance: [] };
}

describe('decideMerges (pure)', () => {
  const p1 = (id: string, v: P1Finding['verdict']): P1Finding => ({ task_id: id, verdict: v, detail: '', out_of_scope_files: [] });
  const p2of = (entries: Array<[string, boolean]>): P2Result => ({
    system_findings: [],
    per_task: entries.map(([task_id, fits_whole]) => ({ task_id, fits_whole, reason: '' })),
    remediation: [],
    catastrophic: false,
    catastrophic_reason: '',
  });

  test('merges only P1-clean AND P2-fits, in topological order', () => {
    const plans = [fp('A'), fp('B', ['A']), fp('C', ['B'])];
    const { mergeOrder, held } = decideMerges(plans, [p1('A', 'clean'), p1('B', 'clean'), p1('C', 'clean')], p2of([['A', true], ['B', true], ['C', true]]));
    assert.deepEqual(mergeOrder, ['A', 'B', 'C']);
    assert.deepEqual(held, []);
  });

  test('a P1-clean task that P2 says does not fit is held', () => {
    const plans = [fp('A'), fp('B', ['A'])];
    const { mergeOrder, held } = decideMerges(plans, [p1('A', 'clean'), p1('B', 'clean')], p2of([['A', true], ['B', false]]));
    assert.deepEqual(mergeOrder, ['A']);
    assert.deepEqual(held, ['B']);
  });

  test('a P1-flagged task is held even when P2 fits', () => {
    const plans = [fp('A'), fp('B')];
    const { held } = decideMerges(plans, [p1('A', 'clean'), p1('B', 'scope_drift')], p2of([['A', true], ['B', true]]));
    assert.deepEqual(held, ['B']);
  });

  test('interface gate: a clean consumer is HELD when its producer is held (no orphan merge)', () => {
    // This is the PIPE-SMOKE failure: TEST (deps MODULE) was clean and got
    // merged while MODULE was held, leaving a test importing a missing module.
    const plans = [fp('MODULE'), fp('TEST', ['MODULE'])];
    const { mergeOrder, held } = decideMerges(
      plans,
      [p1('MODULE', 'conflict'), p1('TEST', 'clean')],
      p2of([['MODULE', false], ['TEST', true]]),
    );
    assert.deepEqual(mergeOrder, [], 'nothing merges — the consumer cannot land without its producer');
    assert.deepEqual(held.sort(), ['MODULE', 'TEST']);
  });

  test('interface gate cascades transitively (A held → B → C all held)', () => {
    const plans = [fp('A'), fp('B', ['A']), fp('C', ['B'])];
    const { mergeOrder, held } = decideMerges(
      plans,
      [p1('A', 'failed'), p1('B', 'clean'), p1('C', 'clean')],
      p2of([['A', false], ['B', true], ['C', true]]),
    );
    assert.deepEqual(mergeOrder, []);
    assert.deepEqual(held.sort(), ['A', 'B', 'C']);
  });

  test('interface gate holds a consumer linked only by `consumes` (not deps)', () => {
    const consumer: FlightPlanContract = {
      task_id: 'TEST', description: '', deps: [], creates: [], modifies: [],
      consumes: [{ from_task: 'MODULE', symbol: 'x', expected_signature: '' }],
      preflight: [], scope_boundary: [], acceptance: [],
    };
    const { held } = decideMerges([fp('MODULE'), consumer], [p1('MODULE', 'conflict'), p1('TEST', 'clean')], p2of([['MODULE', false], ['TEST', true]]));
    assert.deepEqual(held.sort(), ['MODULE', 'TEST']);
  });
});

// ─── Real-git integration ─────────────────────────────────────────────────────

function g(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-redux-'));
  g('git init -q', dir);
  g('git config user.email t@t.t', dir);
  g('git config user.name tester', dir);
  writeFileSync(resolve(dir, 'shared.txt'), 'line1\n');
  g('git add -A', dir);
  g('git commit -q -m base', dir);
  g('git checkout -q -B integration', dir);
  return dir;
}

function makeBranch(base: string, branch: string, write: () => void): void {
  g(`git checkout -q -B "${branch}" integration`, base);
  write();
  g('git add -A', base);
  g(`git commit -q -m "${branch}"`, base);
  g('git checkout -q integration', base);
}

function lsTree(base: string): string[] {
  return g('git ls-tree -r --name-only integration', base).split('\n').filter(Boolean);
}

function coder(taskId: string, branch: string, status: CoderResult['status'] = 'committed'): CoderResult {
  return { task_id: taskId, branch, status, commit: status === 'failed' ? null : 'sha', files_changed: [], exit_code: status === 'failed' ? 1 : 0, log: '' };
}

function seedRun(id: string, base: string, plans: FlightPlanContract[], coders: CoderResult[]): void {
  createRun({ id, taskId: 'T', prompt: 'build', now: 1000 });
  const plan: PlanningResult = { dag: { nodes: [] }, plans, alignment: { conflicts: [], preflight: [], decisions: [] } };
  updateRun(id, { status: 'executing', plan_json: freezePlan(plan), coder_results: JSON.stringify(coders), worktree_base: base, integration_branch: 'integration' }, 1000);
}

const cleanP1 = async (plan: FlightPlanContract): Promise<P1Finding> => ({ task_id: plan.task_id, verdict: 'clean', detail: '', out_of_scope_files: [] });
const fitAllP2 = async (plans: FlightPlanContract[]): Promise<P2Result> => ({
  system_findings: [], per_task: plans.map((p) => ({ task_id: p.task_id, fits_whole: true, reason: '' })), remediation: [], catastrophic: false, catastrophic_reason: '',
});

describe('runRedux (real git base + injected judges)', () => {
  test('non-conflicting coders all merge into the integration branch', async () => {
    const base = makeBase();
    try {
      makeBranch(base, 'br-a', () => writeFileSync(resolve(base, 'a.txt'), 'A\n'));
      makeBranch(base, 'br-b', () => writeFileSync(resolve(base, 'b.txt'), 'B\n'));
      seedRun('pr_clean', base, [fp('A'), fp('B', ['A'])], [coder('A', 'br-a'), coder('B', 'br-b')]);

      const result = await runRedux(getRun('pr_clean')!, { judgeP1: cleanP1, judgeP2: fitAllP2 });
      assert.deepEqual(result.merged, ['A', 'B']);
      assert.deepEqual(result.held, []);
      const tree = lsTree(base);
      assert.ok(tree.includes('a.txt') && tree.includes('b.txt'), 'both files integrated');
      assert.ok(events().includes('pipeline.redux.complete'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the merge queue is authoritative — a branch that conflicts after a sibling merged is held', async () => {
    const base = makeBase();
    try {
      // Both edit shared.txt line1 → A merges clean into integration, then B conflicts.
      makeBranch(base, 'br-a', () => writeFileSync(resolve(base, 'shared.txt'), 'A-change\n'));
      makeBranch(base, 'br-b', () => writeFileSync(resolve(base, 'shared.txt'), 'B-change\n'));
      seedRun('pr_conf', base, [fp('A'), fp('B')], [coder('A', 'br-a'), coder('B', 'br-b')]);

      const result = await runRedux(getRun('pr_conf')!, { judgeP1: cleanP1, judgeP2: fitAllP2 });
      assert.equal(result.merged.length, 1, 'exactly one of the conflicting pair merges');
      assert.equal(result.held.length, 1, 'the other is held');
      assert.notDeepEqual(result.merged, result.held);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a failed coder is overridden to held regardless of the P1 judge', async () => {
    const base = makeBase();
    try {
      makeBranch(base, 'br-a', () => writeFileSync(resolve(base, 'a.txt'), 'A\n'));
      seedRun('pr_fail', base, [fp('A'), fp('B')], [coder('A', 'br-a'), coder('B', 'br-b', 'failed')]);

      const result = await runRedux(getRun('pr_fail')!, { judgeP1: cleanP1, judgeP2: fitAllP2 });
      assert.ok(result.merged.includes('A'));
      assert.ok(result.held.includes('B'), 'failed coder held');
      assert.equal(result.p1.find((f) => f.task_id === 'B')?.verdict, 'failed', 'verdict overridden to failed');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('a catastrophic P2 verdict emits the short-circuit event + persists remediation', async () => {
    const base = makeBase();
    try {
      makeBranch(base, 'br-a', () => writeFileSync(resolve(base, 'a.txt'), 'A\n'));
      seedRun('pr_cat', base, [fp('A')], [coder('A', 'br-a')]);
      const catP2 = async (): Promise<P2Result> => ({
        system_findings: [{ detail: 'irrecoverable', involved: ['A'] }],
        per_task: [{ task_id: 'A', fits_whole: false, reason: 'broken' }],
        remediation: [{ task_id: 'A', problem: 'X', target_state: 'Y' }],
        catastrophic: true,
        catastrophic_reason: 'unrecoverable state',
      });
      await runRedux(getRun('pr_cat')!, { judgeP1: cleanP1, judgeP2: catP2 });
      assert.ok(events().includes('pipeline.short_circuit'));
      const stored = JSON.parse(getRun('pr_cat')!.remediation_plan!) as Array<{ task_id: string }>;
      assert.equal(stored[0]?.task_id, 'A');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
