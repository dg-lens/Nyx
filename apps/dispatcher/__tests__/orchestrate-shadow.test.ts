import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { config } from '../src/config.js';
import { _setComposerDb, getNormalizationsForTask } from '../src/composer/db.js';
import {
  formatNormalizedSpecBlock,
  maybeRunShadowNormalize,
  runShadowNormalizePhase,
  type ShadowNormalizeResult,
} from '../src/composer/orchestrate.js';
import { _setOutcomesDb, getOutcomesForTask } from '../src/outcomes.js';
import type { AncestorContext } from '../src/composer/chain-context.js';
import type { NormalizerSpawnOutcome } from '../src/composer/normalizer-spawner.js';
import type {
  NormalizationResult,
  NormalizationVerdict,
  NormalizedSpec,
} from '../src/composer/types.js';
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

function normResult(over: Partial<NormalizationResult> = {}): NormalizationResult {
  return {
    normalization_id: 'norm-1',
    task_id: 'TASK-X',
    spec: spec(),
    dag: null,
    enforced: true,
    would_reject: false,
    reject_reason: null,
    duration_ms: 1,
    model: 'sonnet',
    raw_response: '{}',
    ...over,
  };
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

/**
 * Toggle BOTH enabled + enforced for a single test, restoring after. ASYNC +
 * awaits `fn` before restoring: `enforced` is read AFTER an internal `await` in
 * `maybeRunShadowNormalize`, so a synchronous-restore helper would reset the flag
 * before the function reads it. (`enabled` is read synchronously, so the sync
 * `withNormalizerEnabled` helper above is fine for it.)
 */
async function withNormalizerEnforced<T>(enforced: boolean, fn: () => Promise<T>): Promise<T> {
  const mutable = config.composer.normalizer as { enabled: boolean; enforced: boolean };
  const prevEnabled = mutable.enabled;
  const prevEnforced = mutable.enforced;
  mutable.enabled = true;
  mutable.enforced = enforced;
  try {
    return await fn();
  } finally {
    mutable.enabled = prevEnabled;
    mutable.enforced = prevEnforced;
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
  test('flag OFF (shipped default) → normalizer NEVER invoked, proceed action', async () => {
    let gathered = false;
    let ran = false;
    const decision = await withNormalizerEnabled(false, () =>
      maybeRunShadowNormalize(makeTask('TASK-OFF'), '/tmp', {
        gatherAncestors: () => {
          gathered = true;
          return [];
        },
        record: async () => {
          ran = true;
          return normResult();
        },
      }),
    );
    assert.equal(gathered, false, 'must not gather ancestors when disabled');
    assert.equal(ran, false, 'must not invoke the normalizer when disabled');
    assert.deepEqual(decision, { action: 'proceed' });
    assert.equal(getNormalizationsForTask('TASK-OFF').length, 0);
  });

  test('flag ON → normalizer invoked with gathered ancestors', async () => {
    const ancestors: AncestorContext[] = [{ task_id: 'PARENT', plan: null, actual_diff: null }];
    let seen: AncestorContext[] | null = null;
    await withNormalizerEnabled(true, () =>
      maybeRunShadowNormalize(makeTask('TASK-ON'), '/tmp', {
        gatherAncestors: () => ancestors,
        record: async (_t, _wd, anc) => {
          seen = anc;
          return normResult();
        },
      }),
    );
    assert.deepEqual(seen, ancestors, 'gathered ancestors must reach the normalizer');
  });

  test('flag ON + a thrown normalizer → swallowed; caller proceeds (fail-open)', async () => {
    let threw = false;
    let decision: ShadowNormalizeResult = { action: 'reject', blockingIssues: [], rejectReason: null };
    try {
      decision = await withNormalizerEnabled(true, () =>
        maybeRunShadowNormalize(makeTask('TASK-WIRE-THROW'), '/tmp', {
          gatherAncestors: () => [],
          record: async () => {
            throw new Error('normalizer exploded');
          },
        }),
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'wiring must never propagate a throw to the dispatch path');
    assert.deepEqual(decision, { action: 'proceed' }, 'a wiring throw fails open to proceed');
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
          record: async (_t, _wd, anc) => {
            ranWith = anc;
            return normResult();
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

describe('maybeRunShadowNormalize — ENFORCEMENT (PRE-DISPATCH ONLY)', () => {
  test('enforced=false (shadow) + clean verdict → proceed, NO prompt change', async () => {
    const decision = await withNormalizerEnforced(false, () =>
      maybeRunShadowNormalize(makeTask('TASK-SHADOW'), '/tmp', {
        gatherAncestors: () => [],
        record: async () => normResult({ would_reject: false }),
      }),
    );
    // Byte-identical-to-shadow: no inject, no reject — the coder's prompt is
    // unchanged even though the normalization WAS recorded.
    assert.deepEqual(decision, { action: 'proceed' });
  });

  test('enforced=false (shadow) + would_reject → STILL proceeds (no halt)', async () => {
    const decision = await withNormalizerEnforced(false, () =>
      maybeRunShadowNormalize(makeTask('TASK-SHADOW-WR'), '/tmp', {
        gatherAncestors: () => [],
        record: async () =>
          normResult({ would_reject: true, reject_reason: 'unsolvable', enforced: false }),
      }),
    );
    assert.deepEqual(decision, { action: 'proceed' }, 'shadow mode never rejects');
  });

  test('enforced=true + clean verdict → inject the NORMALIZED SPEC block', async () => {
    const decision = await withNormalizerEnforced(true, () =>
      maybeRunShadowNormalize(makeTask('TASK-INJECT'), '/tmp', {
        gatherAncestors: () => [],
        record: async () =>
          normResult({
            would_reject: false,
            spec: {
              ...spec(),
              tightened_body: 'do exactly X',
              acceptance_criteria: ['X compiles'],
              anti_examples: ['do not do Y'],
            },
          }),
      }),
    );
    assert.equal(decision.action, 'inject');
    if (decision.action !== 'inject') throw new Error('unreachable');
    assert.match(decision.normalizedSpecBlock, /## NORMALIZED SPEC \(composer-compiled\)/);
    assert.match(decision.normalizedSpecBlock, /do exactly X/);
    assert.match(decision.normalizedSpecBlock, /X compiles/);
    assert.match(decision.normalizedSpecBlock, /do not do Y/);
  });

  test('enforced=true + would_reject → reject (coder must NOT spawn)', async () => {
    const decision = await withNormalizerEnforced(true, () =>
      maybeRunShadowNormalize(makeTask('TASK-REJECT'), '/tmp', {
        gatherAncestors: () => [],
        record: async () =>
          normResult({
            would_reject: true,
            reject_reason: 'spec is incomplete',
            spec: { ...spec(), verdict: { ...spec().verdict, complete: 'no', blocking_issues: ['missing schema'] } },
          }),
      }),
    );
    assert.equal(decision.action, 'reject');
    if (decision.action !== 'reject') throw new Error('unreachable');
    assert.deepEqual(decision.blockingIssues, ['missing schema']);
    assert.equal(decision.rejectReason, 'spec is incomplete');
  });

  test('enforced=true + normalizer null (failed/skipped) → proceed unmodified', async () => {
    const decision = await withNormalizerEnforced(true, () =>
      maybeRunShadowNormalize(makeTask('TASK-NULL-ENF'), '/tmp', {
        gatherAncestors: () => [],
        record: async () => null,
      }),
    );
    // NEVER block on the normalizer's own failure.
    assert.deepEqual(decision, { action: 'proceed' });
  });
});

describe('formatNormalizedSpecBlock', () => {
  test('renders all three sections with header + tightened body', () => {
    const block = formatNormalizedSpecBlock(
      normResult({
        spec: {
          ...spec(),
          tightened_body: 'TBODY',
          acceptance_criteria: ['AC1', 'AC2'],
          anti_examples: ['ANTI1'],
        },
      }),
    );
    assert.match(block, /^## NORMALIZED SPEC \(composer-compiled\)/);
    assert.match(block, /### Tightened body\nTBODY/);
    assert.match(block, /- AC1/);
    assert.match(block, /- AC2/);
    assert.match(block, /- ANTI1/);
  });
});
