import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { config } from '../src/config.js';
import { _setComposerDb, getNormalizationsForTask } from '../src/composer/db.js';
import { maybeRunShadowNormalize, runShadowNormalizePhase } from '../src/composer/orchestrate.js';
import { _setOutcomesDb, getOutcomesForTask } from '../src/outcomes.js';
import type { AncestorContext } from '../src/composer/chain-context.js';
import type { NormalizerSpawnOutcome } from '../src/composer/normalizer-spawner.js';
import type { NormalizationVerdict, NormalizedSpec } from '../src/composer/types.js';
import type { ParsedTask } from '../src/types.js';

let db: DatabaseSync;

function makeTask(id: string): ParsedTask {
  return { id, description: `task ${id}`, type: 'code', model: 'sonnet' } as ParsedTask;
}

function spec(verdict: Partial<NormalizationVerdict> = {}): NormalizedSpec {
  return {
    task_id: 'TASK-X',
    tightened_body: 'b',
    acceptance_criteria: [],
    anti_examples: [],
    resolved_paths: [],
    verdict: { solvable: 'yes', complete: 'yes', redundant_with: [], blocking_issues: [], ...verdict },
  };
}

function fakeSpawn(s: NormalizedSpec): () => Promise<NormalizerSpawnOutcome> {
  return async () => ({ ok: true, result: { spec: s, rawResponse: JSON.stringify(s) } });
}

/** Toggle the (deeply-readonly) config flag for a single test, restoring after. */
function withNormalizerEnabled<T>(enabled: boolean, fn: () => T): T {
  const mutable = config.composer.normalizer as { enabled: boolean };
  const prev = mutable.enabled;
  mutable.enabled = enabled;
  try {
    return fn();
  } finally {
    mutable.enabled = prev;
  }
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
  _setOutcomesDb(db);
});

afterEach(() => {
  _setAuditDb(null);
  _setComposerDb(null);
  _setOutcomesDb(null);
  db.close();
});

describe('orchestrate phase-3 (shadow normalizer)', () => {
  test('returns void — structurally cannot alter runComposerLayer return/status', async () => {
    const ret = await withNormalizerEnabled(true, () =>
      runShadowNormalizePhase(makeTask('TASK-A'), '/tmp', [], fakeSpawn(spec())),
    );
    // void return — the helper yields nothing the orchestrator could fold into
    // its { flightPlan, status } result.
    assert.equal(ret, undefined);
  });

  test('enabled → persists a normalization', async () => {
    await withNormalizerEnabled(true, () =>
      runShadowNormalizePhase(makeTask('TASK-EN'), '/tmp', [], fakeSpawn(spec())),
    );
    const got = getNormalizationsForTask('TASK-EN');
    assert.equal(got.length, 1);
    assert.equal(got[0]?.task_id, 'TASK-EN');
  });

  test('disabled → no-op (nothing persisted), same void return as enabled', async () => {
    const retDisabled = await withNormalizerEnabled(false, () =>
      runShadowNormalizePhase(makeTask('TASK-DIS'), '/tmp', [], fakeSpawn(spec())),
    );
    assert.equal(retDisabled, undefined);
    assert.equal(getNormalizationsForTask('TASK-DIS').length, 0);
  });

  test('a would_reject spec is recorded but never halts/throws', async () => {
    const ret = await withNormalizerEnabled(true, () =>
      runShadowNormalizePhase(
        makeTask('TASK-WR'),
        '/tmp',
        [],
        fakeSpawn(spec({ solvable: 'no', blocking_issues: ['unresolvable'] })),
      ),
    );
    assert.equal(ret, undefined, 'must complete normally, never halt');
    const got = getNormalizationsForTask('TASK-WR');
    assert.equal(got.length, 1);
    assert.equal(got[0]?.would_reject, true);
  });

  test('spawn-failure outcome → audit skipped, no throw, structured outcome recorded', async () => {
    const ret = await withNormalizerEnabled(true, () =>
      runShadowNormalizePhase(makeTask('TASK-NULL'), '/tmp', [], async () => ({
        ok: false,
        failure_class: 'spawn_failed',
      })),
    );
    assert.equal(ret, undefined);
    assert.equal(getNormalizationsForTask('TASK-NULL').length, 0);
    const outs = getOutcomesForTask('TASK-NULL');
    assert.equal(outs.length, 1);
    assert.equal(outs[0]?.stage, 'composer.normalize');
    assert.equal(outs[0]?.outcome, 'failed');
    assert.equal(outs[0]?.failure_class, 'spawn_failed');
  });

  test('each of the four artifact-causes records its own failure_class', async () => {
    for (const fc of [
      'artifact_missing',
      'artifact_unreadable',
      'artifact_malformed_json',
      'artifact_invalid_shape',
    ] as const) {
      const taskId = `TASK-${fc}`;
      await withNormalizerEnabled(true, () =>
        runShadowNormalizePhase(makeTask(taskId), '/tmp', [], async () => ({
          ok: false,
          failure_class: fc,
        })),
      );
      const outs = getOutcomesForTask(taskId);
      assert.equal(outs.length, 1, `${fc}: outcome row missing`);
      assert.equal(outs[0]?.failure_class, fc);
    }
  });

  test('spawn throwing → swallowed (audit skipped), recorded as internal_error', async () => {
    let threw = false;
    try {
      await withNormalizerEnabled(true, () =>
        runShadowNormalizePhase(makeTask('TASK-THROW'), '/tmp', [], async () => {
          throw new Error('spawn exploded');
        }),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'phase-3 must never propagate a throw');
    assert.equal(getNormalizationsForTask('TASK-THROW').length, 0);
    const outs = getOutcomesForTask('TASK-THROW');
    assert.equal(outs.length, 1);
    assert.equal(outs[0]?.outcome, 'failed');
    assert.equal(outs[0]?.failure_class, 'internal_error');
  });

  test('ok path records an outcome row with stage=composer.normalize, outcome=ok', async () => {
    await withNormalizerEnabled(true, () =>
      runShadowNormalizePhase(makeTask('TASK-OK'), '/tmp', [], fakeSpawn(spec())),
    );
    const outs = getOutcomesForTask('TASK-OK');
    assert.equal(outs.length, 1);
    assert.equal(outs[0]?.stage, 'composer.normalize');
    assert.equal(outs[0]?.outcome, 'ok');
    assert.equal(outs[0]?.failure_class, null);
  });
});

/**
 * The dispatch-path wiring contract — exactly what `attemptTask` in
 * `cli/run-once.ts` relies on. run-once.ts has zero exports and runs `main()` on
 * import, so we test the inert, side-effect-free seam it calls instead.
 */
describe('maybeRunShadowNormalize (dispatch-path wiring)', () => {
  test('flag OFF (shipped default) → normalizer NEVER invoked, no ancestor gather', async () => {
    let gathered = false;
    let ran = false;
    await withNormalizerEnabled(false, () =>
      maybeRunShadowNormalize(makeTask('TASK-OFF'), '/tmp', {
        gatherAncestors: () => {
          gathered = true;
          return [];
        },
        runShadow: async () => {
          ran = true;
        },
      }),
    );
    assert.equal(gathered, false, 'must not gather ancestors when disabled');
    assert.equal(ran, false, 'must not invoke the shadow normalizer when disabled');
    assert.equal(getNormalizationsForTask('TASK-OFF').length, 0);
  });

  test('flag ON → normalizer invoked with gathered ancestors', async () => {
    const ancestors: AncestorContext[] = [{ task_id: 'PARENT', plan: null, actual_diff: null }];
    let seen: AncestorContext[] | null = null;
    await withNormalizerEnabled(true, () =>
      maybeRunShadowNormalize(makeTask('TASK-ON'), '/tmp', {
        gatherAncestors: () => ancestors,
        runShadow: async (_t, _wd, anc) => {
          seen = anc;
        },
      }),
    );
    assert.deepEqual(seen, ancestors, 'gathered ancestors must reach the shadow phase');
  });

  test('flag ON + a thrown normalizer → swallowed; dispatch caller proceeds', async () => {
    let threw = false;
    try {
      await withNormalizerEnabled(true, () =>
        maybeRunShadowNormalize(makeTask('TASK-WIRE-THROW'), '/tmp', {
          gatherAncestors: () => [],
          runShadow: async () => {
            throw new Error('normalizer exploded');
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'wiring must never propagate a throw to the dispatch path');
  });

  test('flag ON + a thrown ancestor-gather → swallowed; normalizer still runs with []', async () => {
    let ranWith: AncestorContext[] | null = null;
    let threw = false;
    try {
      await withNormalizerEnabled(true, () =>
        maybeRunShadowNormalize(makeTask('TASK-GATHER-THROW'), '/tmp', {
          gatherAncestors: () => {
            throw new Error('git blew up');
          },
          runShadow: async (_t, _wd, anc) => {
            ranWith = anc;
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'a gather throw must never reach the dispatch path');
    assert.deepEqual(ranWith, [], 'normalizer still runs, with empty ancestors');
  });
});
