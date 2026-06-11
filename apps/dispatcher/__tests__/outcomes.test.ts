import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import {
  FAILURE_CLASSES,
  MAX_DETAIL_CHARS,
  OUTCOMES,
  OUTCOME_STAGES,
  SKIP_REASONS,
  _setOutcomesDb,
  getOutcomesForTask,
  getRecentFailures,
  getRecentOutcomesByStage,
  recordOutcome,
  rollupByStage,
  safeRecordOutcome,
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
        'doc_sweep',
        'expects',
        'finalize',
        'gate',
        'intake',
        'lint',
        'mcp',
        'notify',
        'pipeline',
        'plugin',
        'preflight',
        'spawn',
        'verify',
        'wisdom',
      ],
    );
  });

  test('OUTCOME_STAGES keeps the original 11 stages AND adds the 9 emitter-sweep stages', () => {
    const original = [
      'intake',
      'preflight',
      'composer.plan',
      'composer.run',
      'composer.normalize',
      'dispatch',
      'gate',
      'verify',
      'delivery',
      'audit',
      'wisdom',
    ];
    for (const s of original) {
      assert.ok((OUTCOME_STAGES as readonly string[]).includes(s), `lost original stage: ${s}`);
    }
    for (const s of [
      'spawn',
      'lint',
      'expects',
      'doc_sweep',
      'finalize',
      'notify',
      'mcp',
      'pipeline',
      'plugin',
    ]) {
      assert.ok((OUTCOME_STAGES as readonly string[]).includes(s), `missing new stage: ${s}`);
    }
    assert.equal(OUTCOME_STAGES.length, 20);
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

  test('FAILURE_CLASSES distinguishes spawn_timeout from spawn_failed', () => {
    assert.ok((FAILURE_CLASSES as readonly string[]).includes('spawn_timeout'));
    assert.ok((FAILURE_CLASSES as readonly string[]).includes('spawn_failed'));
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

// ── detail truncation ──────────────────────────────────────────────────

describe('outcomes — detail truncation', () => {
  test('detail longer than MAX_DETAIL_CHARS is clipped at write time', () => {
    const long = 'x'.repeat(MAX_DETAIL_CHARS + 250);
    recordOutcome({
      task_id: 'TASK-LONG',
      stage: 'composer.normalize',
      outcome: 'failed',
      failure_class: 'artifact_malformed_json',
      detail: long,
    });
    const rows = getOutcomesForTask('TASK-LONG');
    assert.equal(rows[0]?.detail?.length, MAX_DETAIL_CHARS);
    assert.equal(rows[0]?.detail, 'x'.repeat(MAX_DETAIL_CHARS));
  });

  test('detail at or under MAX_DETAIL_CHARS is stored verbatim', () => {
    const exact = 'y'.repeat(MAX_DETAIL_CHARS);
    recordOutcome({
      task_id: 'TASK-EXACT',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
      detail: exact,
    });
    assert.equal(getOutcomesForTask('TASK-EXACT')[0]?.detail, exact);
  });

  test('truncation also applies via safeRecordOutcome (both entry points share it)', () => {
    safeRecordOutcome({
      task_id: 'TASK-LONG-SAFE',
      stage: 'gate',
      outcome: 'failed',
      failure_class: 'tests_failed',
      detail: 'z'.repeat(MAX_DETAIL_CHARS + 100),
    });
    assert.equal(getOutcomesForTask('TASK-LONG-SAFE')[0]?.detail?.length, MAX_DETAIL_CHARS);
  });
});

// ── safeRecordOutcome — never throws ────────────────────────────────────

describe('outcomes — safeRecordOutcome (production entry point)', () => {
  test('a valid input persists exactly like recordOutcome', () => {
    safeRecordOutcome({ task_id: 'SAFE-OK', stage: 'gate', outcome: 'ok', duration_ms: 5 });
    const rows = getOutcomesForTask('SAFE-OK');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, 'ok');
  });

  test('a taxonomy violation is SWALLOWED (no throw) and nothing is written', () => {
    const prevError = console.error;
    let logged = false;
    console.error = () => {
      logged = true;
    };
    try {
      assert.doesNotThrow(() =>
        safeRecordOutcome({
          task_id: 'SAFE-BAD',
          stage: 'gate',
          outcome: 'failed', // missing failure_class → recordOutcome throws
        }),
      );
    } finally {
      console.error = prevError;
    }
    assert.equal(logged, true, 'the swallowed error must be console.error-logged');
    assert.equal(getOutcomesForTask('SAFE-BAD').length, 0);
  });

  test('a DB-layer error is swallowed too (monitoring never blocks dispatch)', () => {
    // Point the module at a closed DB so the INSERT throws — the wrapper must
    // still not propagate it.
    const broken = new DatabaseSync(':memory:');
    broken.close();
    _setOutcomesDb(broken);
    const prevError = console.error;
    console.error = () => {};
    try {
      assert.doesNotThrow(() =>
        safeRecordOutcome({ task_id: 'SAFE-DB', stage: 'gate', outcome: 'ok' }),
      );
    } finally {
      console.error = prevError;
      // Restore the per-test in-memory db for afterEach's close().
      _setOutcomesDb(db);
    }
  });
});

// ── schema idempotency ──────────────────────────────────────────────────

describe('outcomes — schema idempotency', () => {
  test('opening the table twice on the same db handle is a no-op (no error, no dupes)', () => {
    // Fresh, independent handle so this test owns its lifecycle end-to-end.
    const fresh = new DatabaseSync(':memory:');
    _setOutcomesDb(fresh);
    try {
      // First open via a write triggers CREATE TABLE IF NOT EXISTS + indexes.
      recordOutcome({ task_id: 'IDEMP', stage: 'gate', outcome: 'ok' });
      // Re-run the schema create directly: must not throw on the existing table.
      assert.doesNotThrow(() => {
        fresh.exec(`
          CREATE TABLE IF NOT EXISTS task_outcomes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            at              TEXT    NOT NULL,
            task_id         TEXT    NOT NULL,
            stage           TEXT    NOT NULL,
            outcome         TEXT    NOT NULL,
            failure_class   TEXT,
            skip_reason     TEXT,
            detail          TEXT,
            payload_json    TEXT,
            duration_ms     INTEGER,
            created_at      INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_task_outcomes_task
            ON task_outcomes(task_id, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_task_outcomes_stage
            ON task_outcomes(stage, outcome, created_at DESC);
          CREATE INDEX IF NOT EXISTS idx_task_outcomes_failure_class
            ON task_outcomes(failure_class, created_at DESC);
        `);
      });
      // A second write still works and the first row was not duplicated.
      recordOutcome({ task_id: 'IDEMP', stage: 'verify', outcome: 'ok' });
      const rows = getOutcomesForTask('IDEMP');
      assert.equal(rows.length, 2, 'exactly the two rows written — schema re-create added none');
    } finally {
      _setOutcomesDb(db);
      fresh.close();
    }
  });
});
