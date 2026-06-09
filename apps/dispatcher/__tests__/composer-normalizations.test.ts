import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import {
  _setComposerDb,
  getNormalizationsForTask,
  getRecentNormalizations,
  saveNormalization,
} from '../src/composer/db.js';
import type { NormalizationResult } from '../src/composer/types.js';

let db: DatabaseSync;

function makeResult(
  taskId: string,
  overrides: Partial<NormalizationResult> = {},
): NormalizationResult {
  return {
    normalization_id: `normalize-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    task_id: taskId,
    spec: {
      task_id: taskId,
      tightened_body: `tightened body for ${taskId}`,
      acceptance_criteria: ['criterion'],
      anti_examples: ['anti'],
      resolved_paths: [{ path: 'src/foo.ts', exists: true }],
      verdict: {
        solvable: 'yes',
        complete: 'yes',
        redundant_with: [],
        blocking_issues: [],
      },
    },
    dag: null,
    enforced: false,
    would_reject: false,
    reject_reason: null,
    duration_ms: 1234,
    model: 'sonnet',
    raw_response: '{}',
    ...overrides,
  };
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

describe('composer/db — normalizations roundtrip', () => {
  test('saveNormalization + getNormalizationsForTask returns the saved result', () => {
    const r = makeResult('TASK-N', {
      would_reject: true,
      reject_reason: 'not solvable',
      spec: {
        task_id: 'TASK-N',
        tightened_body: 'b',
        acceptance_criteria: [],
        anti_examples: [],
        resolved_paths: [],
        verdict: { solvable: 'no', complete: 'no', redundant_with: ['TASK-OTHER'], blocking_issues: ['x'] },
      },
    });
    saveNormalization(r);
    const got = getNormalizationsForTask('TASK-N');
    assert.equal(got.length, 1);
    assert.equal(got[0]?.task_id, 'TASK-N');
    assert.equal(got[0]?.would_reject, true);
    assert.equal(got[0]?.reject_reason, 'not solvable');
    assert.deepEqual(got[0]?.spec.verdict.redundant_with, ['TASK-OTHER']);
  });

  test('getRecentNormalizations honors the limit and returns newest first', () => {
    saveNormalization(makeResult('TASK-1'));
    saveNormalization(makeResult('TASK-2'));
    saveNormalization(makeResult('TASK-3'));
    const recent = getRecentNormalizations(2);
    assert.equal(recent.length, 2);
    // Newest (highest id) first → TASK-3 then TASK-2.
    assert.equal(recent[0]?.task_id, 'TASK-3');
    assert.equal(recent[1]?.task_id, 'TASK-2');
  });

  test('getRecentNormalizations returns [] when none recorded', () => {
    assert.deepEqual(getRecentNormalizations(10), []);
  });

  test('would_reject + enforced columns mirror the result fields', () => {
    saveNormalization(makeResult('TASK-WR', { would_reject: true, enforced: true }));
    const row = db
      .prepare(`SELECT would_reject, enforced FROM composer_normalizations WHERE task_id = ?`)
      .get('TASK-WR') as { would_reject: number; enforced: number };
    assert.equal(row.would_reject, 1);
    assert.equal(row.enforced, 1);
  });
});
