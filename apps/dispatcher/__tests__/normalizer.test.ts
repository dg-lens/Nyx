import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { _setComposerDb, saveFlightPlan } from '../src/composer/db.js';
import { FLIGHT_PLAN_SCHEMA_VERSION, type FlightPlan } from '../src/composer/types.js';
import { deriveWouldReject, normalizeTaskSpec } from '../src/composer/normalizer.js';
import type { NormalizerSpawnResult } from '../src/composer/normalizer-spawner.js';
import type { ChainDag, NormalizationVerdict, NormalizedSpec } from '../src/composer/types.js';
import type { ParsedTask } from '../src/types.js';

let db: DatabaseSync;

function makeTask(id: string, depends?: string[]): ParsedTask {
  return {
    id,
    description: `task ${id}`,
    type: 'code',
    model: 'sonnet',
    ...(depends ? { depends } : {}),
  } as ParsedTask;
}

function makeSpec(verdict: Partial<NormalizationVerdict>): NormalizedSpec {
  return {
    task_id: 'TASK-X',
    tightened_body: 'do the thing',
    acceptance_criteria: ['it works'],
    anti_examples: [],
    resolved_paths: [],
    verdict: {
      solvable: 'yes',
      complete: 'yes',
      redundant_with: [],
      blocking_issues: [],
      ...verdict,
    },
  };
}

function spawnReturning(spec: NormalizedSpec): NormalizerSpawnResult {
  return { spec, rawResponse: JSON.stringify(spec) };
}

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

// ── deriveWouldReject truth table ──────────────────────────────────────

describe('deriveWouldReject', () => {
  const noDag: ChainDag | null = null;

  test('clean verdict → would_reject false, reason null', () => {
    const r = deriveWouldReject({ spec: makeSpec({}), dag: noDag });
    assert.equal(r.wouldReject, false);
    assert.equal(r.reason, null);
  });

  test('solvable=no → would_reject true', () => {
    const r = deriveWouldReject({ spec: makeSpec({ solvable: 'no' }), dag: noDag });
    assert.equal(r.wouldReject, true);
    assert.match(r.reason!, /not solvable/);
  });

  test('complete=no → would_reject true', () => {
    const r = deriveWouldReject({ spec: makeSpec({ complete: 'no' }), dag: noDag });
    assert.equal(r.wouldReject, true);
    assert.match(r.reason!, /incomplete/);
  });

  test('blocking_issues non-empty → would_reject true', () => {
    const r = deriveWouldReject({
      spec: makeSpec({ blocking_issues: ['contradiction A', 'missing B'] }),
      dag: noDag,
    });
    assert.equal(r.wouldReject, true);
    assert.match(r.reason!, /2 blocking issue/);
  });

  test('solvable=uncertain alone → would_reject false', () => {
    const r = deriveWouldReject({ spec: makeSpec({ solvable: 'uncertain' }), dag: noDag });
    assert.equal(r.wouldReject, false);
  });

  test('dag cycle → would_reject true even with a clean verdict', () => {
    const dag: ChainDag = {
      nodes: ['A', 'B'],
      edges: [['A', 'B'], ['B', 'A']],
      topo_order: null,
      cycle: ['A', 'B'],
      predicted_conflicts: [],
    };
    const r = deriveWouldReject({ spec: makeSpec({}), dag });
    assert.equal(r.wouldReject, true);
    assert.match(r.reason!, /cycle/);
  });
});

// ── normalizeTaskSpec ──────────────────────────────────────────────────

describe('normalizeTaskSpec', () => {
  test('returns null (never throws) when the spawner returns null', async () => {
    const result = await normalizeTaskSpec(makeTask('TASK-A'), '/tmp', [], async () => null);
    assert.equal(result, null);
  });

  test('returns null (never throws) when the spawner throws', async () => {
    const result = await normalizeTaskSpec(makeTask('TASK-A'), '/tmp', [], async () => {
      throw new Error('boom');
    });
    assert.equal(result, null);
  });

  test('assembles a result with derived would_reject for a clean spec', async () => {
    const spec = makeSpec({});
    const result = await normalizeTaskSpec(
      makeTask('TASK-A'),
      '/tmp',
      [],
      async () => spawnReturning(spec),
    );
    assert.ok(result);
    assert.equal(result!.task_id, 'TASK-A');
    assert.equal(result!.would_reject, false);
    assert.equal(result!.reject_reason, null);
    assert.equal(result!.dag, null); // no [depends:]
    assert.equal(result!.model, 'sonnet');
    assert.ok(result!.normalization_id.startsWith('normalize-TASK-A-'));
  });

  test('sets would_reject true for an un-normalizable spec', async () => {
    const spec = makeSpec({ solvable: 'no', blocking_issues: ['cannot locate target module'] });
    const result = await normalizeTaskSpec(
      makeTask('TASK-A'),
      '/tmp',
      [],
      async () => spawnReturning(spec),
    );
    assert.ok(result);
    assert.equal(result!.would_reject, true);
    assert.ok(result!.reject_reason);
  });

  test('enforced flag is READ but NOT acted on — no throw/halt even when enforced is true', async () => {
    // The config default is enforced:false; this test asserts that regardless of
    // the value, normalizeTaskSpec only RECORDS it and never changes control flow.
    // We can't flip config here, but the contract is: enforced is copied onto the
    // result and the function returns normally. A would_reject=true spec under any
    // enforcement setting still returns a result (no halt/throw).
    const spec = makeSpec({ solvable: 'no' });
    const result = await normalizeTaskSpec(
      makeTask('TASK-A'),
      '/tmp',
      [],
      async () => spawnReturning(spec),
    );
    assert.ok(result, 'must return a result, never halt/throw');
    assert.equal(typeof result!.enforced, 'boolean');
    // would_reject is true, yet the function returned a value — proving the shadow
    // contract: it never blocks on the reject signal.
    assert.equal(result!.would_reject, true);
  });

  test('builds a dag (with conflicts) when the task has [depends:]', async () => {
    const spec = makeSpec({});
    const ancestors = [
      {
        task_id: 'TASK-DEP',
        plan: {
          schema_version: 1 as const,
          task_id: 'TASK-DEP',
          task_summary: '',
          drafted_at: new Date().toISOString(),
          files: { create: [], modify: ['src/shared.ts'], delete: [] },
          exports: [],
          depends_on_tasks: [],
          imports_from_chain: [],
          doc_updates: [],
          revisable: true,
          revision_of: null,
          estimated_risk: 'low' as const,
          notes: '',
        },
        actual_diff: null,
      },
    ];
    // Record the dependent task's own plan so the conflict detector can see it.
    const selfPlan: FlightPlan = {
      ...ancestors[0]!.plan,
      schema_version: FLIGHT_PLAN_SCHEMA_VERSION,
      task_id: 'TASK-MAIN',
      files: { create: [], modify: ['src/shared.ts'], delete: [] },
    };
    saveFlightPlan(selfPlan);

    const result = await normalizeTaskSpec(
      makeTask('TASK-MAIN', ['TASK-DEP']),
      '/tmp',
      ancestors,
      async () => spawnReturning(spec),
    );
    assert.ok(result);
    assert.ok(result!.dag);
    assert.equal(result!.dag!.predicted_conflicts.length, 1);
    assert.deepEqual(result!.dag!.predicted_conflicts[0]!.files, ['src/shared.ts']);
  });
});
