import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setComposerDb, saveFlightPlan } from '../src/composer/db.js';
import {
  buildChainDag,
  kahnTopoSort,
  parseMergeTreeNameOnly,
  parseClassicMergeTree,
} from '../src/composer/dag.js';
import { FLIGHT_PLAN_SCHEMA_VERSION, type FlightPlan } from '../src/composer/types.js';
import type { ParsedTask } from '../src/types.js';

let db: DatabaseSync;

function makePlan(taskId: string, overrides: Partial<FlightPlan> = {}): FlightPlan {
  return {
    schema_version: FLIGHT_PLAN_SCHEMA_VERSION,
    task_id: taskId,
    task_summary: `summary for ${taskId}`,
    drafted_at: new Date().toISOString(),
    files: { create: [], modify: [], delete: [] },
    exports: [],
    depends_on_tasks: [],
    imports_from_chain: [],
    doc_updates: [],
    revisable: true,
    revision_of: null,
    estimated_risk: 'low',
    notes: '',
    ...overrides,
  };
}

function makeTask(id: string, depends?: string[]): ParsedTask {
  return {
    id,
    description: `task ${id}`,
    type: 'code',
    model: 'sonnet',
    ...(depends ? { depends } : {}),
  } as ParsedTask;
}

// `/tmp` is not a git repo with these task commits, so findCommitForTask returns
// null and the merge-tree probe contributes nothing — file-set intersection is
// the active signal in these tests. Use a non-repo working dir on purpose.
const NON_REPO_DIR = '/tmp';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
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
  _setAuditDb(db);
  _setComposerDb(db);
});

afterEach(() => {
  _setAuditDb(null);
  _setComposerDb(null);
  db.close();
});

// ── kahnTopoSort ───────────────────────────────────────────────────────

describe('kahnTopoSort', () => {
  test('orders dependencies before dependents', () => {
    // C -> B -> A  (C depends on B depends on A); A must come first.
    const nodes = ['C', 'B', 'A'];
    const edges: [string, string][] = [
      ['C', 'B'],
      ['B', 'A'],
    ];
    const { order, cycle } = kahnTopoSort(nodes, edges);
    assert.equal(cycle, null);
    assert.ok(order);
    assert.ok(order!.indexOf('A') < order!.indexOf('B'));
    assert.ok(order!.indexOf('B') < order!.indexOf('C'));
  });

  test('detects a cycle and returns null order', () => {
    const nodes = ['A', 'B'];
    const edges: [string, string][] = [
      ['A', 'B'],
      ['B', 'A'],
    ];
    const { order, cycle } = kahnTopoSort(nodes, edges);
    assert.equal(order, null);
    assert.ok(cycle);
    assert.deepEqual(cycle, ['A', 'B']);
  });

  test('handles a single node with no edges', () => {
    const { order, cycle } = kahnTopoSort(['A'], []);
    assert.equal(cycle, null);
    assert.deepEqual(order, ['A']);
  });
});

// ── buildChainDag ──────────────────────────────────────────────────────

describe('buildChainDag', () => {
  test('returns null when the task has no [depends:]', () => {
    const dag = buildChainDag(makeTask('SOLO'), [], NON_REPO_DIR);
    assert.equal(dag, null);
  });

  test('returns null for empty depends array', () => {
    const dag = buildChainDag(makeTask('SOLO', []), [], NON_REPO_DIR);
    assert.equal(dag, null);
  });

  test('builds nodes + edges + topo order for a linear chain', () => {
    const task = makeTask('TASK-C', ['TASK-B']);
    const ancestors = [{ task_id: 'TASK-B', plan: makePlan('TASK-B', { depends_on_tasks: ['TASK-A'] }) }];
    const dag = buildChainDag(task, ancestors, NON_REPO_DIR);
    assert.ok(dag);
    // nodes: C (self), B (dep), A (B's dep, one level out)
    assert.deepEqual([...dag!.nodes].sort(), ['TASK-A', 'TASK-B', 'TASK-C']);
    // edges: C->B and B->A
    assert.ok(dag!.edges.some(([f, t]) => f === 'TASK-C' && t === 'TASK-B'));
    assert.ok(dag!.edges.some(([f, t]) => f === 'TASK-B' && t === 'TASK-A'));
    // topo: A before B before C
    assert.ok(dag!.topo_order);
    assert.ok(dag!.topo_order!.indexOf('TASK-A') < dag!.topo_order!.indexOf('TASK-B'));
    assert.ok(dag!.topo_order!.indexOf('TASK-B') < dag!.topo_order!.indexOf('TASK-C'));
    assert.equal(dag!.cycle, null);
  });

  test('detects a cycle via ancestor depends_on_tasks pointing back to self', () => {
    const task = makeTask('TASK-A', ['TASK-B']);
    // B declares it depends on A → A->B and B->A → cycle.
    const ancestors = [{ task_id: 'TASK-B', plan: makePlan('TASK-B', { depends_on_tasks: ['TASK-A'] }) }];
    const dag = buildChainDag(task, ancestors, NON_REPO_DIR);
    assert.ok(dag);
    assert.equal(dag!.topo_order, null);
    assert.ok(dag!.cycle);
    assert.deepEqual(dag!.cycle, ['TASK-A', 'TASK-B']);
  });

  test('predicts a conflict from file-set intersection of two plans', () => {
    const task = makeTask('TASK-B', ['TASK-A']);
    // Both tasks plan to modify src/auth.ts → file-set conflict.
    const ancestors = [
      {
        task_id: 'TASK-A',
        plan: makePlan('TASK-A', { files: { create: [], modify: ['src/auth.ts'], delete: [] } }),
      },
    ];
    // The task's own plan must be recorded so resolvePlan finds it.
    const taskPlan = makePlan('TASK-B', { files: { create: [], modify: ['src/auth.ts', 'src/other.ts'], delete: [] } });
    // Save TASK-B's plan into the composer DB (resolvePlan falls back to
    // getLatestFlightPlan). saveFlightPlan triggers schema creation.
    saveFlightPlan(taskPlan);

    const dag = buildChainDag(task, ancestors, NON_REPO_DIR);
    assert.ok(dag);
    assert.equal(dag!.predicted_conflicts.length, 1);
    const c = dag!.predicted_conflicts[0]!;
    assert.deepEqual([...c.between].sort(), ['TASK-A', 'TASK-B']);
    assert.deepEqual(c.files, ['src/auth.ts']);
  });

  test('no conflict when planned file sets are disjoint', () => {
    const task = makeTask('TASK-B', ['TASK-A']);
    const ancestors = [
      {
        task_id: 'TASK-A',
        plan: makePlan('TASK-A', { files: { create: ['src/a.ts'], modify: [], delete: [] } }),
      },
    ];
    const taskPlan = makePlan('TASK-B', { files: { create: ['src/b.ts'], modify: [], delete: [] } });
    saveFlightPlan(taskPlan);

    const dag = buildChainDag(task, ancestors, NON_REPO_DIR);
    assert.ok(dag);
    assert.equal(dag!.predicted_conflicts.length, 0);
  });
});

// ── merge-tree output parsers ──────────────────────────────────────────

describe('parseMergeTreeNameOnly', () => {
  test('drops the tree-OID first line, returns conflict paths', () => {
    const out = 'abc123deadbeef\nsrc/auth.ts\nsrc/db.ts\n';
    assert.deepEqual(parseMergeTreeNameOnly(out), ['src/auth.ts', 'src/db.ts']);
  });

  test('returns [] on a clean merge (OID only)', () => {
    assert.deepEqual(parseMergeTreeNameOnly('abc123deadbeef\n'), []);
  });

  test('splits NUL-separated path lists', () => {
    const out = 'oid\nsrc/a.ts\0src/b.ts\n';
    assert.deepEqual(parseMergeTreeNameOnly(out), ['src/a.ts', 'src/b.ts']);
  });
});

describe('parseClassicMergeTree', () => {
  test('extracts paths from "changed in both" blocks', () => {
    const out = [
      'changed in both',
      '  base   100644 abc src/auth.ts',
      '  our    100644 def src/auth.ts',
      '  their  100644 ghi src/auth.ts',
    ].join('\n');
    assert.deepEqual(parseClassicMergeTree(out), ['src/auth.ts']);
  });

  test('returns [] when there are no conflict blocks', () => {
    assert.deepEqual(parseClassicMergeTree('added in remote\n  their 100644 x src/new.ts'), []);
  });
});
