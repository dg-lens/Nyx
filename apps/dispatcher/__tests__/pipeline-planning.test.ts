import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { config } from '../src/config.js';
import {
  ALIGN_ARTIFACT,
  DAG_ARTIFACT,
  PlanningError,
  planArtifact,
  runPlanning,
  setupPlanningDir,
  topoSort,
  type PlanningSpawn,
  type PlanningSpawnArgs,
} from '../src/pipeline/planning.js';
import type { PipelineRun } from '../src/pipeline/types.js';
import { withAppsDir } from './helpers.js';

beforeEach(() => {
  _setAuditDb(new DatabaseSync(':memory:'));
});

function minimalRun(id: string): PipelineRun {
  return {
    id,
    task_id: 'PIPE-1',
    prompt: 'build the foo feature',
    repo: null,
    status: 'planning',
    current_stage: null,
    plan_json: null,
    authorities: null,
    bz_brief_path: null,
    operator_decision: null,
    integration_branch: null,
    redux_findings: null,
    remediation_plan: null,
    diagnostic_round: 0,
    cost_actuals: null,
    worktree_base: null,
    coder_results: null,
    fix_directive: null,
    error: null,
    created_at: 0,
    updated_at: 0,
  };
}

function writeArtifact(workingDir: string, rel: string, json: unknown): void {
  const p = resolve(workingDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(json), 'utf8');
}

/** A spawn that writes the artifact each stage expects, keyed on the label. */
function scriptedSpawn(workingDir: string, opts: { skipPlanFor?: string; skipDag?: boolean } = {}): PlanningSpawn {
  return async (a: PlanningSpawnArgs) => {
    if (a.label === 'pipeline-decompose') {
      if (!opts.skipDag) {
        writeArtifact(workingDir, DAG_ARTIFACT, {
          nodes: [
            { id: 'A', description: 'add Foo type', deps: [], type: 'code', target_paths: ['src/foo.ts'] },
            { id: 'B', description: 'use Foo', deps: ['A'], type: 'code', target_paths: ['src/router.ts'] },
          ],
        });
      }
    } else if (a.label.startsWith('pipeline-flightplan-')) {
      const id = a.label.replace('pipeline-flightplan-', '');
      if (opts.skipPlanFor === id) return { exitCode: 0, stdout: '', stderr: '' };
      if (id === 'A') {
        writeArtifact(workingDir, planArtifact('A'), {
          task_id: 'A',
          description: 'add Foo type',
          deps: [],
          creates: [{ symbol: 'Foo', signature: 'interface Foo', file: 'src/foo.ts', purpose: 'shape' }],
          modifies: [],
          consumes: [],
          preflight: [],
          scope_boundary: ['src/router.ts'],
          acceptance: ['tsc passes'],
        });
      } else {
        writeArtifact(workingDir, planArtifact(id), {
          task_id: id,
          description: 'use Foo',
          deps: ['A'],
          creates: [],
          modifies: ['src/router.ts'],
          consumes: [{ from_task: 'A', symbol: 'Foo', expected_signature: 'interface Foo' }],
          preflight: ['SUPABASE_DB_URL'],
          scope_boundary: [],
          acceptance: ['route works'],
        });
      }
    } else if (a.label === 'pipeline-align') {
      writeArtifact(workingDir, ALIGN_ARTIFACT, {
        conflicts: [],
        preflight: [{ item: 'SUPABASE_DB_URL', status: 'ready', note: '' }],
      });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

describe('topoSort', () => {
  test('orders dependents after dependencies', () => {
    const order = topoSort({
      nodes: [
        { id: 'C', description: '', deps: ['B'], type: 'code', target_paths: [] },
        { id: 'A', description: '', deps: [], type: 'code', target_paths: [] },
        { id: 'B', description: '', deps: ['A'], type: 'code', target_paths: [] },
      ],
    }).map((n) => n.id);
    assert.ok(order.indexOf('A') < order.indexOf('B'));
    assert.ok(order.indexOf('B') < order.indexOf('C'));
  });

  test('cycle does not drop nodes', () => {
    const order = topoSort({
      nodes: [
        { id: 'X', description: '', deps: ['Y'], type: 'code', target_paths: [] },
        { id: 'Y', description: '', deps: ['X'], type: 'code', target_paths: [] },
      ],
    }).map((n) => n.id);
    assert.deepEqual(order.sort(), ['X', 'Y']);
  });
});

describe('runPlanning (injected spawn + working dir)', () => {
  test('produces a DAG, aligned flight plans, and alignment', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'nyx-plan-'));
    const result = await runPlanning(minimalRun('pr_x'), { id: 'PIPE-1', description: 'build foo' }, {
      spawn: scriptedSpawn(wd),
      workingDir: wd,
    });
    assert.equal(result.dag.nodes.length, 2);
    assert.equal(result.plans.length, 2);
    // sequential order means A (a dep of B) is planned first
    assert.equal(result.plans[0]?.task_id, 'A');
    assert.equal(result.plans[0]?.creates[0]?.symbol, 'Foo');
    // B consumes Foo from A — the synchronicity link survives the round trip
    const b = result.plans.find((p) => p.task_id === 'B');
    assert.equal(b?.consumes[0]?.from_task, 'A');
    assert.equal(result.alignment.preflight[0]?.item, 'SUPABASE_DB_URL');
  });

  test('a missing flight-plan artifact degrades to a minimal contract', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'nyx-plan-'));
    const result = await runPlanning(minimalRun('pr_y'), { id: 'PIPE-1', description: 'build foo' }, {
      spawn: scriptedSpawn(wd, { skipPlanFor: 'B' }),
      workingDir: wd,
    });
    const b = result.plans.find((p) => p.task_id === 'B');
    assert.ok(b, 'B still present as a degraded contract');
    assert.deepEqual(b?.modifies, ['src/router.ts']); // from DAG target_paths
    assert.equal(b?.creates.length, 0);
  });

  test('throws PlanningError when decompose produces no DAG', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'nyx-plan-'));
    await assert.rejects(
      runPlanning(minimalRun('pr_z'), { id: 'PIPE-1', description: 'build foo' }, {
        spawn: scriptedSpawn(wd, { skipDag: true }),
        workingDir: wd,
      }),
      PlanningError,
    );
  });
});

describe('setupPlanningDir (app:<slug> collision refusal)', () => {
  test('refuses an existing destination BEFORE any filesystem mutation', () => {
    withAppsDir((appsDir) => {
      const dest = resolve(appsDir, 'taken');
      mkdirSync(dest, { recursive: true });
      writeFileSync(resolve(dest, 'precious.txt'), 'do not touch\n');
      const run = minimalRun('pr_appcollide');
      run.repo = 'app:taken';
      const planDir = `${config.cloneRootPrefix}${run.id}-plan`;
      assert.throws(
        () => setupPlanningDir(run, { id: 'PIPE-1', description: 'build', repo: 'app:taken' }),
        /app destination .* already exists/,
      );
      assert.equal(readFileSync(resolve(dest, 'precious.txt'), 'utf8'), 'do not touch\n', 'destination untouched');
      assert.equal(existsSync(planDir), false, 'no throwaway plan dir created — refusal precedes all mutation');
    });
  });

  test('exempts the run\'s OWN base so replan/rollback re-entry survives', () => {
    withAppsDir((appsDir) => {
      const dest = resolve(appsDir, 'mine');
      mkdirSync(dest, { recursive: true });
      writeFileSync(resolve(dest, 'app.ts'), 'built in a prior phase\n');
      const run = minimalRun('pr_appown');
      run.repo = 'app:mine';
      run.worktree_base = dest;
      const wd = setupPlanningDir(run, { id: 'PIPE-1', description: 'build', repo: 'app:mine' });
      try {
        assert.equal(wd.path, `${config.cloneRootPrefix}${run.id}-plan`, 'plans in the throwaway /tmp dir');
        assert.equal(readFileSync(resolve(dest, 'app.ts'), 'utf8'), 'built in a prior phase\n', 'own base untouched');
      } finally {
        wd.cleanup();
      }
    });
  });

  test('fresh slug plans in a throwaway /tmp dir; the destination is never created at planning', () => {
    withAppsDir((appsDir) => {
      const dest = resolve(appsDir, 'fresh');
      const run = minimalRun('pr_appfresh');
      run.repo = 'app:fresh';
      const wd = setupPlanningDir(run, { id: 'PIPE-1', description: 'build', repo: 'app:fresh' });
      try {
        assert.equal(wd.path, `${config.cloneRootPrefix}${run.id}-plan`);
        assert.equal(existsSync(dest), false, 'real destination is scaffolded at integration-base time, not planning');
      } finally {
        wd.cleanup();
      }
    });
  });
});
