import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import {
  FAILURE_CLASSES,
  OUTCOMES,
  OUTCOME_STAGES,
  SKIP_REASONS,
  _setOutcomesDb,
  getOutcomesForTask,
  getRecentFailures,
  getRecentOutcomesByStage,
  recordOutcome,
  rollupByStage,
  validateOutcomeInput,
} from '../src/outcomes.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setOutcomesDb(db);
});

afterEach(() => {
  _setOutcomesDb(null);
  db.close();
});

// ── Taxonomy invariants ────────────────────────────────────────────────

describe('outcomes — taxonomy invariants', () => {
  test('OUTCOME_STAGES is the closed set every consumer reads', () => {
    assert.deepEqual(
      [...OUTCOME_STAGES].sort(),
      [
        'audit',
        'composer.normalize',
        'composer.plan',
        'composer.run',
        'delivery',
        'dispatch',
        'gate',
        'intake',
        'preflight',
        'verify',
        'wisdom',
      ],
    );
  });

  test('OUTCOMES is exactly {ok, skipped, failed}', () => {
    assert.deepEqual([...OUTCOMES].sort(), ['failed', 'ok', 'skipped']);
  });

  test('FAILURE_CLASSES contains a class for each of the four normalizer-spawn causes', () => {
    for (const cls of [
      'spawn_failed',
      'artifact_missing',
      'artifact_unreadable',
      'artifact_malformed_json',
      'artifact_invalid_shape',
    ] as const) {
      assert.ok(
        (FAILURE_CLASSES as readonly string[]).includes(cls),
        `missing failure_class: ${cls}`,
      );
    }
  });

  test('FAILURE_CLASSES carries `unknown` as the explicit "no other class fits" bucket', () => {
    assert.ok((FAILURE_CLASSES as readonly string[]).includes('unknown'));
  });

  test('SKIP_REASONS distinguishes structural skips from failures', () => {
    for (const r of ['disabled', 'depends_unmet', 'in_flight', 'rate_limit_cooldown'] as const) {
      assert.ok((SKIP_REASONS as readonly string[]).includes(r));
    }
  });
});

// ── validateOutcomeInput ───────────────────────────────────────────────

describe('outcomes — validateOutcomeInput', () => {
  test('ok with no class/reason passes', () => {
    assert.equal(
      validateOutcomeInput({ task_id: 'T1', stage: 'gate', outcome: 'ok' }),
      null,
    );
  });

  test('failed requires failure_class', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      stage: 'gate',
      outcome: 'failed',
    });
    assert.match(err!, /requires failure_class/);
  });

  test('failed must not carry skip_reason', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
      skip_reason: 'disabled',
    });
    assert.match(err!, /must not carry skip_reason/);
  });

  test('skipped requires skip_reason', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      stage: 'composer.normalize',
      outcome: 'skipped',
    });
    assert.match(err!, /requires skip_reason/);
  });

  test('skipped must not carry failure_class', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      stage: 'composer.normalize',
      outcome: 'skipped',
      skip_reason: 'disabled',
      failure_class: 'spawn_failed',
    });
    assert.match(err!, /must not carry failure_class/);
  });

  test('ok must not carry either', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      stage: 'gate',
      outcome: 'ok',
      failure_class: 'tests_failed',
    });
    assert.match(err!, /must not carry failure_class/);
  });

  test('unknown stage rejected', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      // @ts-expect-error — bad input is the whole point
      stage: 'made-up',
      outcome: 'ok',
    });
    assert.match(err!, /unknown stage/);
  });

  test('unknown failure_class rejected', () => {
    const err = validateOutcomeInput({
      task_id: 'T1',
      stage: 'gate',
      outcome: 'failed',
      // @ts-expect-error
      failure_class: 'made-up',
    });
    assert.match(err!, /unknown failure_class/);
  });

  test('missing task_id rejected', () => {
    const err = validateOutcomeInput({
      task_id: '',
      stage: 'gate',
      outcome: 'ok',
    });
    assert.match(err!, /task_id/);
  });
});

// ── recordOutcome ──────────────────────────────────────────────────────

describe('outcomes — recordOutcome persistence', () => {
  test('ok outcome roundtrips with no class/reason', () => {
    recordOutcome({ task_id: 'TASK-OK', stage: 'gate', outcome: 'ok', duration_ms: 42 });
    const rows = getOutcomesForTask('TASK-OK');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.stage, 'gate');
    assert.equal(rows[0]?.outcome, 'ok');
    assert.equal(rows[0]?.failure_class, null);
    assert.equal(rows[0]?.skip_reason, null);
    assert.equal(rows[0]?.duration_ms, 42);
  });

  test('failed outcome roundtrips with failure_class + detail + payload', () => {
    recordOutcome({
      task_id: 'TASK-F',
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class: 'artifact_malformed_json',
      detail: 'JSON.parse failed at byte 437',
      payload: { excerpt: '{ "task_id": ' },
    });
    const rows = getOutcomesForTask('TASK-F');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, 'failed');
    assert.equal(rows[0]?.failure_class, 'artifact_malformed_json');
    assert.equal(rows[0]?.detail, 'JSON.parse failed at byte 437');
    assert.deepEqual(rows[0]?.payload, { excerpt: '{ "task_id": ' });
  });

  test('skipped outcome roundtrips with skip_reason', () => {
    recordOutcome({
      task_id: 'TASK-S',
      stage: 'composer.normalize',
      outcome: 'skipped',
      skip_reason: 'disabled',
      detail: 'normalizer feature flag off',
    });
    const rows = getOutcomesForTask('TASK-S');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, 'skipped');
    assert.equal(rows[0]?.skip_reason, 'disabled');
  });

  test('recordOutcome throws on a taxonomy violation rather than writing garbage', () => {
    assert.throws(
      () =>
        recordOutcome({
          task_id: 'TASK-BAD',
          stage: 'gate',
          outcome: 'failed',
        }),
      /failure_class/,
    );
    assert.equal(getOutcomesForTask('TASK-BAD').length, 0);
  });

  test('multiple outcomes for one task come back newest first', () => {
    recordOutcome({
      task_id: 'TASK-M',
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class: 'spawn_failed',
    });
    recordOutcome({ task_id: 'TASK-M', stage: 'gate', outcome: 'ok' });
    const rows = getOutcomesForTask('TASK-M');
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.stage, 'gate');
    assert.equal(rows[1]?.stage, 'composer.normalize');
  });

  test('omitting payload roundtrips as null (column nullable)', () => {
    recordOutcome({
      task_id: 'TASK-NP',
      stage: 'gate',
      outcome: 'ok',
    });
    const rows = getOutcomesForTask('TASK-NP');
    assert.equal(rows[0]?.payload, null);
    assert.equal(rows[0]?.duration_ms, null);
    assert.equal(rows[0]?.detail, null);
  });
});

// ── Queries: rollups and filters ───────────────────────────────────────

describe('outcomes — rollup + filter queries', () => {
  function seedFourNormalizerCauses(): void {
    for (const fc of [
      'spawn_failed',
      'artifact_missing',
      'artifact_malformed_json',
      'artifact_invalid_shape',
    ] as const) {
      recordOutcome({
        task_id: `TASK-${fc}`,
        stage: 'composer.normalize',
        outcome: 'failed',
        failure_class: fc,
      });
    }
  }

  test('the prose-string collapse is now four distinct rollup buckets', () => {
    seedFourNormalizerCauses();
    const r = rollupByStage();
    const normalizeFailures = r.filter(
      (row) => row.stage === 'composer.normalize' && row.outcome === 'failed',
    );
    assert.equal(normalizeFailures.length, 4);
    const classes = normalizeFailures.map((row) => row.failure_class).sort();
    assert.deepEqual(classes, [
      'artifact_invalid_shape',
      'artifact_malformed_json',
      'artifact_missing',
      'spawn_failed',
    ]);
    for (const row of normalizeFailures) {
      assert.equal(row.count, 1);
    }
  });

  test('rollupByStage honors sinceIso to bound the rollup window', () => {
    recordOutcome({
      task_id: 'T-OLD',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = rollupByStage({ sinceIso: future });
    assert.deepEqual(r, []);
  });

  test('getRecentFailures returns only failed rows, newest first', () => {
    recordOutcome({ task_id: 'OK1', stage: 'gate', outcome: 'ok' });
    recordOutcome({
      task_id: 'F1',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
    });
    recordOutcome({
      task_id: 'F2',
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class: 'spawn_failed',
    });
    recordOutcome({
      task_id: 'SK1',
      stage: 'composer.normalize',
      outcome: 'skipped',
      skip_reason: 'disabled',
    });

    const recent = getRecentFailures({ limit: 10 });
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.task_id, 'F2');
    assert.equal(recent[1]?.task_id, 'F1');
  });

  test('getRecentFailures filters by stage', () => {
    seedFourNormalizerCauses();
    recordOutcome({
      task_id: 'G-FAIL',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
    });
    const gateFailures = getRecentFailures({ stage: 'gate', limit: 10 });
    assert.equal(gateFailures.length, 1);
    assert.equal(gateFailures[0]?.task_id, 'G-FAIL');
  });

  test('getRecentFailures filters by failure_class', () => {
    seedFourNormalizerCauses();
    recordOutcome({
      task_id: 'OTHER',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'spawn_failed',
    });
    const spawnFails = getRecentFailures({ failure_class: 'spawn_failed', limit: 10 });
    assert.equal(spawnFails.length, 2);
    for (const row of spawnFails) assert.equal(row.failure_class, 'spawn_failed');
  });

  test('getRecentFailures filters by stage + failure_class together', () => {
    seedFourNormalizerCauses();
    recordOutcome({
      task_id: 'OTHER',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'spawn_failed',
    });
    const narrowed = getRecentFailures({
      stage: 'composer.normalize',
      failure_class: 'spawn_failed',
      limit: 10,
    });
    assert.equal(narrowed.length, 1);
    assert.equal(narrowed[0]?.stage, 'composer.normalize');
    assert.equal(narrowed[0]?.failure_class, 'spawn_failed');
  });

  test('getRecentOutcomesByStage returns mixed outcomes for one stage, newest first', () => {
    recordOutcome({ task_id: 'T1', stage: 'gate', outcome: 'ok' });
    recordOutcome({
      task_id: 'T2',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
    });
    recordOutcome({
      task_id: 'T3',
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class: 'spawn_failed',
    });
    const gate = getRecentOutcomesByStage('gate', 10);
    assert.equal(gate.length, 2);
    assert.equal(gate[0]?.task_id, 'T2');
    assert.equal(gate[1]?.task_id, 'T1');
  });

  test('rollup groups ok rows separately from failures of the same stage', () => {
    recordOutcome({ task_id: 'A', stage: 'gate', outcome: 'ok' });
    recordOutcome({ task_id: 'B', stage: 'gate', outcome: 'ok' });
    recordOutcome({
      task_id: 'C',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
    });
    const r = rollupByStage();
    const okGate = r.find((row) => row.stage === 'gate' && row.outcome === 'ok');
    const failedGate = r.find((row) => row.stage === 'gate' && row.outcome === 'failed');
    assert.equal(okGate?.count, 2);
    assert.equal(failedGate?.count, 1);
    assert.equal(failedGate?.failure_class, 'tests_failed');
  });
});

// ── Empty-state ────────────────────────────────────────────────────────

describe('outcomes — empty state', () => {
  test('queries on an empty table return []', () => {
    assert.deepEqual(getOutcomesForTask('NONE'), []);
    assert.deepEqual(getRecentFailures({ limit: 10 }), []);
    assert.deepEqual(getRecentOutcomesByStage('gate', 10), []);
    assert.deepEqual(rollupByStage(), []);
  });
});
