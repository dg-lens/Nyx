import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import type { AuditRow } from '../src/audit.js';
import { _setAuditDb, audit, readAuditRowsSince } from '../src/audit.js';
import { projectRunTrees, terminalRuns, type RunTree } from '../src/eval/run-tree.js';
import { evaluateDrift, formatDriftAlert, DEFAULT_DRIFT_THRESHOLDS } from '../src/eval/drift-monitor.js';
import {
  selectRunsToScore,
  shouldSampleRun,
  parseJudgeVerdict,
} from '../src/eval/online-eval.js';
import {
  _setEvalDb,
  saveEvalScore,
  scoredCorrelationIds,
  scoresInWindow,
} from '../src/eval/db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let id = 0;
function row(event: string, payload: Record<string, unknown>, at?: string): AuditRow {
  id++;
  return {
    id,
    at: at ?? new Date(Date.UTC(2026, 5, 1, 0, 0, id)).toISOString(),
    event: event as AuditRow['event'],
    actor: 'dispatcher',
    payload: JSON.stringify(payload),
    row_hash: 'x',
    prev_hash: 'y',
  };
}

function makeRun(overrides: Partial<RunTree>): RunTree {
  return {
    correlationId: 'T-1',
    isPipeline: false,
    events: [],
    outcome: 'completed',
    startedAt: '2026-06-01T00:00:00.000Z',
    endedAt: '2026-06-01T00:01:00.000Z',
    flagged: false,
    estimatedCostUsd: null,
    taskType: 'code',
    ...overrides,
  };
}

beforeEach(() => {
  id = 0;
});

// ── Run-tree projection ──────────────────────────────────────────────────────

describe('projectRunTrees', () => {
  test('groups flat events by taskId into one tree, in order', () => {
    const rows = [
      row('task.started', { taskId: 'A', type: 'code' }),
      row('task.started', { taskId: 'B', type: 'analysis' }),
      row('task.claude.exited', { taskId: 'A', exitCode: 0 }),
      row('task.completed', { taskId: 'A' }),
      row('task.completed', { taskId: 'B' }),
    ];
    const trees = projectRunTrees(rows);
    assert.equal(trees.length, 2);
    const a = trees.find((t) => t.correlationId === 'A')!;
    assert.equal(a.events.length, 3);
    assert.equal(a.outcome, 'completed');
    assert.equal(a.taskType, 'code');
    // Events preserve chain order.
    assert.deepEqual(a.events.map((e) => e.event), ['task.started', 'task.claude.exited', 'task.completed']);
  });

  test('drops rows with no correlation id (system ticks)', () => {
    const rows = [
      row('dispatch.tick', { pid: 1, slot: 0 }),
      row('dispatch.idle', {}),
      row('task.started', { taskId: 'A', type: 'code' }),
      row('task.completed', { taskId: 'A' }),
    ];
    const trees = projectRunTrees(rows);
    assert.equal(trees.length, 1);
    assert.equal(trees[0]!.correlationId, 'A');
  });

  test('last terminal event wins — failed-then-resumed-then-completed ends completed', () => {
    const rows = [
      row('task.started', { taskId: 'A', type: 'code' }),
      row('task.failed', { taskId: 'A', stage: 'gate' }),
      row('task.resumed', { taskId: 'A' }),
      row('task.completed', { taskId: 'A' }),
    ];
    const [a] = projectRunTrees(rows);
    assert.equal(a!.outcome, 'completed');
  });

  test('flags a run that hit audit routing / halt / stall', () => {
    const clean = projectRunTrees([
      row('task.started', { taskId: 'CLEAN', type: 'code' }),
      row('task.completed', { taskId: 'CLEAN' }),
    ])[0]!;
    assert.equal(clean.flagged, false);

    const flagged = projectRunTrees([
      row('task.started', { taskId: 'BAD', type: 'code' }),
      row('task.audit.started', { taskId: 'BAD' }),
      row('task.halted_for_review', { taskId: 'BAD' }),
    ])[0]!;
    assert.equal(flagged.flagged, true);
    assert.equal(flagged.outcome, 'halted');
  });

  test('groups pipeline events by runId and marks isPipeline', () => {
    const trees = projectRunTrees([
      row('pipeline.run.started', { runId: 'R-9', taskId: 'PIPE-1' }),
      row('pipeline.stage.advanced', { runId: 'R-9', stage: 'planning' }),
      row('pipeline.delivered', { runId: 'R-9' }),
    ]);
    assert.equal(trees.length, 1);
    const r = trees[0]!;
    assert.equal(r.correlationId, 'R-9');
    assert.equal(r.isPipeline, true);
    assert.equal(r.outcome, 'completed');
    assert.equal(r.taskType, 'pipeline');
  });

  test('folds estimated cost across metered events in a run', () => {
    const [a] = projectRunTrees([
      row('task.started', { taskId: 'A', type: 'code' }),
      row('task.usage.metered', { taskId: 'A', estimated_cost_usd: 0.4 }),
      row('task.usage.metered', { taskId: 'A', estimated_cost_usd: 0.1 }),
      row('task.completed', { taskId: 'A' }),
    ]);
    assert.ok(Math.abs(a!.estimatedCostUsd! - 0.5) < 1e-9);
  });

  test('terminalRuns filters out in-progress runs', () => {
    const trees = projectRunTrees([
      row('task.started', { taskId: 'DONE', type: 'code' }),
      row('task.completed', { taskId: 'DONE' }),
      row('task.started', { taskId: 'LIVE', type: 'code' }),
    ]);
    const terminal = terminalRuns(trees);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]!.correlationId, 'DONE');
  });
});

// ── Drift threshold ──────────────────────────────────────────────────────────

describe('evaluateDrift', () => {
  test('flags a regression when recent mean drops past minDelta', () => {
    const baseline = [0.9, 0.9, 0.9, 0.9, 0.9];
    const recent = [0.7, 0.7, 0.7, 0.7, 0.7];
    const v = evaluateDrift('code', recent, baseline);
    assert.equal(v.regressed, true);
    assert.ok(v.delta < 0);
    assert.equal(v.insufficientReason, null);
  });

  test('does NOT flag when the drop is below minDelta', () => {
    const baseline = [0.9, 0.9, 0.9, 0.9, 0.9];
    const recent = [0.85, 0.85, 0.85, 0.85, 0.85];
    const v = evaluateDrift('code', recent, baseline);
    assert.equal(v.regressed, false);
  });

  test('does NOT flag below the sample floor even on a large drop', () => {
    const v = evaluateDrift('code', [0.1], [0.9, 0.9, 0.9, 0.9, 0.9]);
    assert.equal(v.regressed, false);
    assert.ok(v.insufficientReason);
  });

  test('does NOT flag on an improvement', () => {
    const v = evaluateDrift('code', [0.95, 0.95, 0.95, 0.95, 0.95], [0.7, 0.7, 0.7, 0.7, 0.7]);
    assert.equal(v.regressed, false);
    assert.ok(v.delta > 0);
  });

  test('boundary: a drop exactly at minDelta flags', () => {
    const baseline = [1, 1, 1, 1, 1];
    const recent = [
      1 - DEFAULT_DRIFT_THRESHOLDS.minDelta,
      1 - DEFAULT_DRIFT_THRESHOLDS.minDelta,
      1 - DEFAULT_DRIFT_THRESHOLDS.minDelta,
      1 - DEFAULT_DRIFT_THRESHOLDS.minDelta,
      1 - DEFAULT_DRIFT_THRESHOLDS.minDelta,
    ];
    const v = evaluateDrift('code', recent, baseline);
    assert.equal(v.regressed, true);
  });

  test('formatDriftAlert reports the delta in pp', () => {
    const v = evaluateDrift('analysis', [0.7, 0.7, 0.7, 0.7, 0.7], [0.9, 0.9, 0.9, 0.9, 0.9]);
    const msg = formatDriftAlert(v);
    assert.match(msg, /analysis/);
    assert.match(msg, /70\.0%/);
    assert.match(msg, /90\.0%/);
  });
});

// ── Online-eval sampling ─────────────────────────────────────────────────────

describe('online-eval sampling', () => {
  test('flagged runs are always scored regardless of sample rate', () => {
    const run = makeRun({ correlationId: 'FLAG', flagged: true });
    const { sample, reason } = shouldSampleRun(run, 0);
    assert.equal(sample, true);
    assert.equal(reason, 'flagged');
  });

  test('in-progress runs are never sampled', () => {
    const run = makeRun({ outcome: 'in-progress', flagged: true });
    assert.equal(shouldSampleRun(run, 1).sample, false);
  });

  test('sampleRate=1 scores every clean terminal run; rate=0 scores none', () => {
    const run = makeRun({ correlationId: 'CLEAN-1' });
    assert.equal(shouldSampleRun(run, 1).sample, true);
    assert.equal(shouldSampleRun(run, 0).sample, false);
  });

  test('sampling is STABLE per id — same id, same decision across calls', () => {
    const run = makeRun({ correlationId: 'stable-xyz' });
    const a = shouldSampleRun(run, 0.5).sample;
    const b = shouldSampleRun(run, 0.5).sample;
    assert.equal(a, b);
  });

  test('selectRunsToScore skips already-scored ids and respects flagged', () => {
    const runs = [
      makeRun({ correlationId: 'A', flagged: true }),
      makeRun({ correlationId: 'B', flagged: true }),
      makeRun({ correlationId: 'C', outcome: 'in-progress' }),
    ];
    const selected = selectRunsToScore(runs, 0, new Set(['B']));
    // A is flagged + not scored → in. B is scored → out. C is in-progress → out.
    assert.deepEqual(selected.map((s) => s.run.correlationId), ['A']);
    assert.equal(selected[0]!.reason, 'flagged');
  });
});

// ── Judge verdict parsing ────────────────────────────────────────────────────

describe('parseJudgeVerdict', () => {
  test('parses the final JSON line after CoT reasoning', () => {
    const out = [
      'cleanliness: direct completion, no audit rescue.',
      'completeness: committed and pushed.',
      'cost-shape: nominal.',
      '{"score": 0.92, "rationale": "clean direct completion"}',
    ].join('\n');
    const v = parseJudgeVerdict(out)!;
    assert.equal(v.score, 0.92);
    assert.equal(v.rationale, 'clean direct completion');
  });

  test('clamps an out-of-range score into [0,1]', () => {
    assert.equal(parseJudgeVerdict('{"score": 1.5}')!.score, 1);
    assert.equal(parseJudgeVerdict('{"score": -0.3}')!.score, 0);
  });

  test('returns null on no parseable verdict', () => {
    assert.equal(parseJudgeVerdict('I think it was fine, no JSON here.'), null);
    assert.equal(parseJudgeVerdict('{"notscore": 1}'), null);
  });

  test('takes the LAST score line when several appear', () => {
    const out = '{"score": 0.1}\nmore reasoning\n{"score": 0.8, "rationale": "final"}';
    assert.equal(parseJudgeVerdict(out)!.score, 0.8);
  });
});

// ── Eval DB round-trip + projection over the real chain reader ───────────────

describe('eval_scores DB', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    // audit() fires from readAuditRowsSince's open() path indirectly; stub both.
    db.exec(`
      CREATE TABLE system_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL,
        payload TEXT NOT NULL, row_hash TEXT NOT NULL, prev_hash TEXT NOT NULL
      );
      CREATE TABLE system_audit_chainpoint (
        id INTEGER PRIMARY KEY CHECK (id = 0), last_id INTEGER NOT NULL, last_hash TEXT NOT NULL
      );
    `);
    _setAuditDb(db);
    _setEvalDb(db);
  });
  afterEach(() => {
    _setAuditDb(null);
    _setEvalDb(null);
    db.close();
  });

  test('saves and reads back scores, deduping by correlation id window', () => {
    const t0 = new Date(Date.UTC(2026, 5, 5, 0, 0, 0)).toISOString();
    saveEvalScore({ correlationId: 'A', taskType: 'code', score: 0.8, reason: 'sampled', judgeModel: 'haiku', rationale: 'ok' });
    saveEvalScore({ correlationId: 'B', taskType: 'code', score: 0.4, reason: 'flagged', judgeModel: 'haiku', rationale: null });
    const ids = scoredCorrelationIds(t0);
    assert.ok(ids.has('A'));
    assert.ok(ids.has('B'));
    const codeScores = scoresInWindow('code', t0, new Date(Date.UTC(2027, 0, 1)).toISOString());
    assert.equal(codeScores.length, 2);
    assert.deepEqual([...codeScores].sort(), [0.4, 0.8]);
  });

  test('scoresInWindow excludes scores outside [start,end) and other types', () => {
    saveEvalScore({ correlationId: 'X', taskType: 'analysis', score: 0.9, reason: 'sampled', judgeModel: 'haiku', rationale: null });
    const future = new Date(Date.UTC(2027, 0, 1)).toISOString();
    const farFuture = new Date(Date.UTC(2028, 0, 1)).toISOString();
    // Window entirely in the future → no scores.
    assert.equal(scoresInWindow('analysis', future, farFuture).length, 0);
    // Wrong type → no scores.
    assert.equal(scoresInWindow('code', new Date(0).toISOString(), farFuture).length, 0);
  });

  test('readAuditRowsSince feeds the projection end-to-end', () => {
    audit('task.started', 'dispatcher', { taskId: 'E2E', type: 'code' });
    audit('task.audit.started', 'dispatcher', { taskId: 'E2E' });
    audit('task.completed', 'dispatcher', { taskId: 'E2E' });
    const rows = readAuditRowsSince(new Date(0).toISOString());
    const trees = terminalRuns(projectRunTrees(rows));
    assert.equal(trees.length, 1);
    assert.equal(trees[0]!.correlationId, 'E2E');
    assert.equal(trees[0]!.flagged, true);
    assert.equal(trees[0]!.outcome, 'completed');
  });
});
