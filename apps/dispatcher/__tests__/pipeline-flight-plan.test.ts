import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  buildPreviewBrief,
  detectScopeOverlaps,
  extractJson,
  freezePlan,
  groupPhases,
  hasBlockingConflicts,
  parseAlignment,
  parseDag,
  parseFlightPlanContract,
  parsePlanJson,
  previewRecommendation,
  renderCoderSpec,
  type FlightPlanContract,
  type PlanningResult,
} from '../src/pipeline/flight-plan.js';

describe('extractJson', () => {
  test('parses clean JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
  });

  test('extracts a JSON object embedded in prose', () => {
    const raw = 'Sure! Here is the plan:\n\n{"nodes": [{"id": "T1"}]}\n\nLet me know.';
    assert.deepEqual(extractJson(raw), { nodes: [{ id: 'T1' }] });
  });

  test('handles braces inside strings without miscounting depth', () => {
    const raw = 'noise {"k": "a } b { c"} tail';
    assert.deepEqual(extractJson(raw), { k: 'a } b { c' });
  });

  test('returns null when there is no JSON', () => {
    assert.equal(extractJson('no json here'), null);
  });
});

describe('parseDag', () => {
  test('parses {nodes:[...]} and defaults missing fields', () => {
    const dag = parseDag('{"nodes":[{"id":"A","description":"do a","deps":[],"type":"code","target_paths":["src/a.ts"]},{"id":"B","deps":["A"]}]}');
    assert.ok(dag);
    assert.equal(dag?.nodes.length, 2);
    assert.equal(dag?.nodes[1]?.type, 'code'); // defaulted
    assert.deepEqual(dag?.nodes[1]?.deps, ['A']);
  });

  test('accepts a bare array of nodes', () => {
    const dag = parseDag('[{"id":"X"}]');
    assert.equal(dag?.nodes.length, 1);
  });

  test('drops nodes without an id and returns null if all dropped', () => {
    assert.equal(parseDag('{"nodes":[{"description":"no id"}]}'), null);
  });
});

describe('parseFlightPlanContract', () => {
  test('parses a full contract', () => {
    const raw = JSON.stringify({
      task_id: 'A',
      description: 'add endpoint',
      deps: [],
      creates: [{ symbol: 'getFoo', signature: '() => Foo', file: 'src/foo.ts', purpose: 'fetch foo' }],
      modifies: ['src/router.ts'],
      consumes: [{ from_task: 'B', symbol: 'Foo', expected_signature: 'interface Foo' }],
      preflight: ['SUPABASE_DB_URL'],
      scope_boundary: ['do not touch auth.ts'],
      acceptance: ['GET /foo returns 200'],
    });
    const c = parseFlightPlanContract(raw);
    assert.equal(c?.task_id, 'A');
    assert.equal(c?.creates[0]?.symbol, 'getFoo');
    assert.equal(c?.consumes[0]?.from_task, 'B');
    assert.deepEqual(c?.preflight, ['SUPABASE_DB_URL']);
  });

  test('uses fallback task id when absent', () => {
    const c = parseFlightPlanContract('{"description":"x"}', 'FALLBACK');
    assert.equal(c?.task_id, 'FALLBACK');
  });

  test('returns null with no task id and no fallback', () => {
    assert.equal(parseFlightPlanContract('{"description":"x"}'), null);
  });
});

describe('parseAlignment', () => {
  test('coerces conflict kinds + preflight statuses', () => {
    const raw = JSON.stringify({
      conflicts: [
        { kind: 'interface_mismatch', detail: 'A exports X, B expects Y', involved: ['A', 'B'], needs_operator: true },
        { kind: 'banana', detail: 'unknown kind', involved: [] },
      ],
      preflight: [
        { item: 'SUPABASE_DB_URL', status: 'missing', note: 'set it' },
        { item: 'repo access', status: 'wat' },
      ],
    });
    const a = parseAlignment(raw);
    assert.equal(a.conflicts[0]?.kind, 'interface_mismatch');
    assert.equal(a.conflicts[0]?.needs_operator, true);
    assert.equal(a.conflicts[1]?.kind, 'other'); // coerced
    assert.equal(a.preflight[0]?.status, 'missing');
    assert.equal(a.preflight[1]?.status, 'unclear'); // coerced
  });

  test('empty/garbage input yields empty alignment', () => {
    assert.deepEqual(parseAlignment('garbage'), { conflicts: [], preflight: [] });
  });
});

function sampleResult(): PlanningResult {
  return {
    dag: {
      nodes: [
        { id: 'A', description: 'add Foo type', phase: 0, deps: [], type: 'code', target_paths: ['src/foo.ts'] },
        { id: 'B', description: 'use Foo', phase: 1, deps: ['A'], type: 'code', target_paths: ['src/router.ts'] },
      ],
    },
    plans: [
      {
        task_id: 'A',
        description: 'add Foo type',
        phase: 0,
        deps: [],
        creates: [{ symbol: 'Foo', signature: 'interface Foo', file: 'src/foo.ts', purpose: 'shape' }],
        modifies: [],
        consumes: [],
        preflight: [],
        scope_boundary: ['router.ts'],
        acceptance: ['tsc passes'],
      },
      {
        task_id: 'B',
        description: 'use Foo',
        phase: 1,
        deps: ['A'],
        creates: [],
        modifies: ['src/router.ts'],
        consumes: [{ from_task: 'A', symbol: 'Foo', expected_signature: 'interface Foo' }],
        preflight: ['SUPABASE_DB_URL'],
        scope_boundary: [],
        acceptance: ['route works'],
      },
    ],
    alignment: {
      conflicts: [{ kind: 'preflight_gap', detail: 'DB url not confirmed', involved: ['B'], needs_operator: true }],
      preflight: [{ item: 'SUPABASE_DB_URL', status: 'missing', note: 'paste it' }],
    },
  };
}

describe('freeze / thaw', () => {
  test('round-trips a PlanningResult', () => {
    const r = sampleResult();
    const frozen = freezePlan(r);
    const thawed = parsePlanJson(frozen);
    assert.deepEqual(thawed, r);
  });

  test('parsePlanJson rejects junk', () => {
    assert.equal(parsePlanJson(null), null);
    assert.equal(parsePlanJson('not json'), null);
    assert.equal(parsePlanJson('{"plans":"notarray"}'), null);
  });
});

function contract(overrides: Partial<FlightPlanContract> = {}): FlightPlanContract {
  return {
    task_id: 'A', description: 'do A', phase: 0, deps: [], creates: [], modifies: [], consumes: [], preflight: [], scope_boundary: [], acceptance: [],
    ...overrides,
  };
}

describe('renderCoderSpec', () => {
  test('renders only the task slice — never an "overall goal"', () => {
    const spec = renderCoderSpec(contract({
      task_id: 'PIPE-SMOKE-MODULE',
      description: 'create the pipeline-smoke module',
      creates: [{ symbol: 'pipelineSmoke', signature: '() => PipelineSmoke', file: 'src/lib/pipeline-smoke.ts', purpose: 'probe' }],
      acceptance: ['tsc passes for the module'],
    }));
    assert.match(spec, /# Coder task: PIPE-SMOKE-MODULE/);
    assert.match(spec, /Create exactly these/);
    assert.match(spec, /pipelineSmoke.*src\/lib\/pipeline-smoke\.ts/);
    assert.match(spec, /HARD scope/);
    // The compiled spec has no notion of the overall operator goal — by
    // construction it takes only the contract, so a coder can't see sibling work.
    assert.doesNotMatch(spec, /overall goal/i);
  });

  test('renders consumed symbols as sibling-provided + do-not-create', () => {
    const spec = renderCoderSpec(contract({
      task_id: 'PIPE-SMOKE-TEST',
      description: 'add the smoke test',
      creates: [{ symbol: 'test', signature: '', file: 'src/lib/__tests__/pipeline-smoke.test.ts', purpose: '' }],
      consumes: [{ from_task: 'PIPE-SMOKE-MODULE', symbol: 'pipelineSmoke', expected_signature: '() => PipelineSmoke' }],
    }));
    assert.match(spec, /Provided by sibling coders/);
    assert.match(spec, /pipelineSmoke.*from task PIPE-SMOKE-MODULE/);
    assert.match(spec, /do NOT create them|NOT your job to define it/);
  });

  test('a create-only task is told it modifies nothing', () => {
    const spec = renderCoderSpec(contract({ creates: [{ symbol: 'x', signature: '', file: 'a.ts', purpose: '' }] }));
    assert.match(spec, /modify nothing/i);
  });
});

describe('groupPhases', () => {
  test('groups by phase ascending; same-phase tasks share a bucket', () => {
    const groups = groupPhases([
      contract({ task_id: 'TEST', phase: 1 }),
      contract({ task_id: 'MODULE', phase: 0 }),
      contract({ task_id: 'MODULE2', phase: 0 }),
      contract({ task_id: 'WIRE', phase: 2 }),
    ]);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0]?.map((p) => p.task_id).sort(), ['MODULE', 'MODULE2']);
    assert.deepEqual(groups[1]?.map((p) => p.task_id), ['TEST']);
    assert.deepEqual(groups[2]?.map((p) => p.task_id), ['WIRE']);
  });

  test('collapses gaps in phase numbers into dense ordered buckets', () => {
    const groups = groupPhases([contract({ task_id: 'A', phase: 0 }), contract({ task_id: 'B', phase: 5 })]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.[0]?.task_id, 'A');
    assert.equal(groups[1]?.[0]?.task_id, 'B');
  });
});

describe('detectScopeOverlaps', () => {
  test('flags two tasks that write the same file', () => {
    const c = detectScopeOverlaps([
      contract({ task_id: 'A', creates: [{ symbol: 'a', signature: '', file: 'src/shared.ts', purpose: '' }] }),
      contract({ task_id: 'B', modifies: ['src/shared.ts'] }),
    ]);
    assert.equal(c.length, 1);
    assert.equal(c[0]?.kind, 'overlap');
    assert.equal(c[0]?.needs_operator, true);
    assert.deepEqual(c[0]?.involved.sort(), ['A', 'B']);
    assert.match(c[0]!.detail, /src\/shared\.ts/);
  });

  test('disjoint tasks produce no overlap', () => {
    const c = detectScopeOverlaps([
      contract({ task_id: 'A', creates: [{ symbol: 'a', signature: '', file: 'a.ts', purpose: '' }] }),
      contract({ task_id: 'B', creates: [{ symbol: 'b', signature: '', file: 'b.ts', purpose: '' }] }),
    ]);
    assert.deepEqual(c, []);
  });
});

describe('previewRecommendation', () => {
  test('NEEDS INPUT when there are blocking questions / preflight gaps', () => {
    assert.match(previewRecommendation(sampleResult()), /NEEDS INPUT/);
  });
  test('GO when the plan is clean', () => {
    const clean = sampleResult();
    clean.alignment = { conflicts: [], preflight: [{ item: 'X', status: 'ready', note: '' }] };
    assert.match(previewRecommendation(clean), /^GO —/);
  });
});

describe('buildPreviewBrief', () => {
  test('leads with the recommendation + decide commands, surfaces only what needs attention, NO prompt echo', () => {
    const brief = buildPreviewBrief('pr_1', 'build the foo feature — a very long operator prompt', sampleResult());
    assert.match(brief, /# Preview gate — pr_1/);
    // recommendation headline up top, then the decide commands
    assert.match(brief, /\*\*NEEDS INPUT/);
    assert.match(brief, /nyx pipeline go pr_1/);
    // only-what-needs-attention sections
    assert.match(brief, /## ⚠️ Answer before go/);
    assert.match(brief, /## Preflight to confirm/);
    assert.match(brief, /⚠️ SUPABASE_DB_URL/);
    // plan detail is collapsed, not a full dump; the operator prompt is NOT echoed
    assert.match(brief, /<details><summary>Plan outline/);
    assert.doesNotMatch(brief, /a very long operator prompt/);
    assert.doesNotMatch(brief, /consumes \(synchronicity\)/);
  });

  test('hasBlockingConflicts reflects needs_operator', () => {
    assert.equal(hasBlockingConflicts(sampleResult()), true);
    const noBlock = sampleResult();
    noBlock.alignment.conflicts = [];
    assert.equal(hasBlockingConflicts(noBlock), false);
  });
});
