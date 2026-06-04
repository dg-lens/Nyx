import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import {
  _setComposerDb,
  getLatestFlightPlan,
  saveComposerRun,
  saveFlightPlan,
} from '../src/composer/db.js';
import { parseComposerOutput } from '../src/composer/composer-runner.js';
import { validateFlightPlanShape } from '../src/composer/plan-spawner.js';
import {
  FLIGHT_PLAN_SCHEMA_VERSION,
  type ComposerRunResult,
  type FlightPlan,
} from '../src/composer/types.js';

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

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  // Composer tests need both audit + composer tables — audit() fires from
  // every code path that touches the DB, so failing to stub the audit DB
  // would attempt to lock the real nyx.db.
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

// ── validateFlightPlanShape ────────────────────────────────────────────

describe('validateFlightPlanShape', () => {
  test('accepts a fully-shaped plan', () => {
    const valid = makePlan('TASK-A', {
      files: { create: ['src/foo.ts'], modify: [], delete: [] },
    });
    const result = validateFlightPlanShape(valid, 'TASK-A');
    assert.ok(result);
    assert.equal(result?.task_id, 'TASK-A');
    assert.deepEqual(result?.files.create, ['src/foo.ts']);
  });

  test('rejects wrong schema_version', () => {
    const result = validateFlightPlanShape({ schema_version: 999, task_id: 'X' }, 'X');
    assert.equal(result, null);
  });

  test('rejects non-object inputs', () => {
    assert.equal(validateFlightPlanShape(null, 'X'), null);
    assert.equal(validateFlightPlanShape('not an object', 'X'), null);
    assert.equal(validateFlightPlanShape(42, 'X'), null);
  });

  test('coerces missing fields to sensible defaults', () => {
    const result = validateFlightPlanShape(
      { schema_version: FLIGHT_PLAN_SCHEMA_VERSION },
      'TASK-DEFAULT',
    );
    assert.ok(result);
    assert.equal(result?.task_id, 'TASK-DEFAULT'); // falls back to taskId arg
    assert.deepEqual(result?.files, { create: [], modify: [], delete: [] });
    assert.equal(result?.estimated_risk, 'medium'); // default
    assert.equal(result?.revisable, true);
  });

  test('drops malformed entries inside array fields', () => {
    const result = validateFlightPlanShape(
      {
        schema_version: FLIGHT_PLAN_SCHEMA_VERSION,
        task_id: 'X',
        exports: [
          { file: 'a.ts', symbol: 'foo', signature: 'foo(): void', purpose: 'ok' },
          'not an object', // dropped
          null,            // dropped
          { file: 'b.ts', symbol: 'bar', signature: 'bar(): void', purpose: '' },
        ],
        files: {
          create: ['valid', 42, null, 'also-valid'], // non-strings dropped
          modify: [],
          delete: [],
        },
      },
      'X',
    );
    assert.ok(result);
    assert.equal(result?.exports.length, 2);
    assert.deepEqual(result?.files.create, ['valid', 'also-valid']);
  });

  test('clamps invalid tier values to T2', () => {
    const result = validateFlightPlanShape(
      {
        schema_version: FLIGHT_PLAN_SCHEMA_VERSION,
        task_id: 'X',
        doc_updates: [{ tier: 'T99', path: '/foo', section: 'x', change_summary: 'y' }],
      },
      'X',
    );
    assert.equal(result?.doc_updates[0]?.tier, 'T2');
  });
});

// ── parseComposerOutput ────────────────────────────────────────────────

describe('parseComposerOutput', () => {
  test('parses bare JSON array', () => {
    const out = parseComposerOutput(
      '[{"kind":"file_conflict","severity":"warn","detail":"two tasks touch x","involved":["A","B"],"payload":{}}]',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, 'file_conflict');
    assert.equal(out[0]?.severity, 'warn');
  });

  test('parses JSON inside markdown fences', () => {
    const out = parseComposerOutput(
      'Here are the findings:\n```json\n[{"kind":"interface_mismatch","severity":"block_recommended","detail":"sig mismatch","involved":["X"],"payload":{}}]\n```',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, 'interface_mismatch');
  });

  test('handles prose-wrapped JSON by finding the array span', () => {
    const out = parseComposerOutput(
      'I see one issue:\n[{"kind":"missing_doc_update","severity":"info","detail":"no doc","involved":["A"],"payload":{}}]\nThat is all.',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, 'missing_doc_update');
  });

  test('returns empty array for empty array output', () => {
    assert.deepEqual(parseComposerOutput('[]'), []);
    assert.deepEqual(parseComposerOutput('  \n[]\n  '), []);
  });

  test('returns empty array when no JSON array is found', () => {
    assert.deepEqual(parseComposerOutput(''), []);
    assert.deepEqual(parseComposerOutput('just prose, no array'), []);
  });

  test('drops findings with invalid kind, keeps valid ones', () => {
    const out = parseComposerOutput(
      '[{"kind":"bogus_kind","severity":"warn","detail":"","involved":[],"payload":{}},{"kind":"file_conflict","severity":"warn","detail":"ok","involved":["A"],"payload":{}}]',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.kind, 'file_conflict');
  });

  test('coerces invalid severity to info', () => {
    const out = parseComposerOutput(
      '[{"kind":"file_conflict","severity":"BOGUS","detail":"","involved":[],"payload":{}}]',
    );
    assert.equal(out[0]?.severity, 'info');
  });

  test('returns empty array on malformed JSON', () => {
    assert.deepEqual(parseComposerOutput('[{not json}]'), []);
  });
});

// ── DB roundtrip ───────────────────────────────────────────────────────

describe('composer/db — flight_plans roundtrip', () => {
  test('saveFlightPlan + getLatestFlightPlan returns the saved plan', () => {
    const plan = makePlan('TASK-A', { task_summary: 'first version' });
    saveFlightPlan(plan);
    const got = getLatestFlightPlan('TASK-A');
    assert.ok(got);
    assert.equal(got?.task_summary, 'first version');
  });

  test('getLatestFlightPlan returns the most recent when multiple exist', async () => {
    const first = makePlan('TASK-B', {
      task_summary: 'v1',
      drafted_at: '2026-01-01T00:00:00Z',
    });
    const second = makePlan('TASK-B', {
      task_summary: 'v2',
      drafted_at: '2026-05-01T00:00:00Z',
    });
    saveFlightPlan(first);
    saveFlightPlan(second);
    const got = getLatestFlightPlan('TASK-B');
    assert.equal(got?.task_summary, 'v2');
  });

  test('getLatestFlightPlan returns null when no plan exists', () => {
    assert.equal(getLatestFlightPlan('NEVER-SEEN'), null);
  });
});

describe('composer/db — composer_runs + findings roundtrip', () => {
  test('saveComposerRun persists run + all findings atomically', () => {
    const result: ComposerRunResult = {
      composer_run_id: 'composer-TASK-X-1234-abcd1234',
      task_id: 'TASK-X',
      ancestor_task_ids: ['TASK-W'],
      findings: [
        {
          kind: 'file_conflict',
          severity: 'warn',
          detail: 'both touch auth.py',
          involved: ['TASK-X', 'TASK-W'],
          payload: { file: 'src/auth.py' },
        },
        {
          kind: 'interface_mismatch',
          severity: 'block_recommended',
          detail: 'sig differs',
          involved: ['TASK-X'],
          payload: {
            expected: 'getUser(id: UUID) -> User',
            actual: 'find_user(uuid: str) -> dict',
          },
        },
      ],
      raw_response: '[full composer output here]',
      duration_ms: 4321,
      model: 'sonnet',
    };
    saveComposerRun(result);

    // Query directly via the in-memory DB to verify shape — public reader API
    // doesn't expose composer_findings queries yet (v1+ tooling will).
    const runRow = db
      .prepare(`SELECT id, task_id, model, duration_ms FROM composer_runs WHERE id = ?`)
      .get(result.composer_run_id) as { id: string; task_id: string; model: string; duration_ms: number };
    assert.equal(runRow.task_id, 'TASK-X');
    assert.equal(runRow.model, 'sonnet');
    assert.equal(runRow.duration_ms, 4321);

    const findingRows = db
      .prepare(`SELECT kind, severity, detail FROM composer_findings WHERE composer_run_id = ? ORDER BY id ASC`)
      .all(result.composer_run_id) as Array<{ kind: string; severity: string; detail: string }>;
    assert.equal(findingRows.length, 2);
    assert.equal(findingRows[0]?.kind, 'file_conflict');
    assert.equal(findingRows[1]?.kind, 'interface_mismatch');
    assert.equal(findingRows[1]?.severity, 'block_recommended');
  });

  test('saveComposerRun with empty findings persists run but no finding rows', () => {
    const result: ComposerRunResult = {
      composer_run_id: 'composer-TASK-Y-5678-efgh5678',
      task_id: 'TASK-Y',
      ancestor_task_ids: [],
      findings: [],
      raw_response: '[]',
      duration_ms: 100,
      model: 'sonnet',
    };
    saveComposerRun(result);

    const findingCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM composer_findings WHERE composer_run_id = ?`)
      .get(result.composer_run_id) as { n: number }).n;
    assert.equal(findingCount, 0);

    const runCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM composer_runs WHERE id = ?`)
      .get(result.composer_run_id) as { n: number }).n;
    assert.equal(runCount, 1);
  });
});
