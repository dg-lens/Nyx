/**
 * Repeat-demotion of the heuristic audit classifier.
 *
 * Bug class: a heuristic autofix (e.g. rewrite-pnpm-workspace) patches the tree,
 * the dispatcher re-runs, the SAME stage fails again with the SAME signature —
 * so the classifier re-classifies it `auto-fixable`, re-applies the identical
 * patch, and loops until the audit cap halts the task. The cap eventually saves
 * us, but it burns both audit passes on a patch already proven futile instead of
 * routing to the Opus diagnostic that could actually fix it.
 *
 * Fix: before returning an `auto-fixable` classification, `runAudit` consults
 * the audit chain (NOT the log text) for THIS task. If a
 * `task.audit.autofix.succeeded` with the same pattern already exists AND a
 * later `task.failed` at the same stage followed it, the heuristic is demoted to
 * `unknown` (carrying `repeatDemoted`) so the flow falls through to the
 * diagnostic agent.
 *
 * These cases exercise the two units that compose the feature:
 *   - autofixRepeatIneffective(taskId, pattern, stage) — the EVENT-based detector
 *   - demoteRepeatedAutofix(classification, ineffective) — the demotion effect
 *
 * Cases (per the task spec):
 *   1. first occurrence                                  → auto-fixable
 *   2. same pattern + prior succeeded + later same-stage → demoted (repeatDemoted)
 *   3. prior autofix was a DIFFERENT task                → not demoted
 *   4. prior autofix then task PASSED that stage, fails elsewhere → not demoted
 */

import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, autofixRepeatIneffective } from '../src/audit.js';
import { classifyFailure, demoteRepeatedAutofix } from '../src/audit-classifier.js';

let memDb: DatabaseSync;

beforeEach(() => {
  memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
    CREATE INDEX idx_system_audit_event ON system_audit(event);
    CREATE INDEX idx_system_audit_at    ON system_audit(at);
  `);
  _setAuditDb(memDb);
});

afterEach(() => {
  _setAuditDb(null);
});

const PNPM_FAIL = ' ERROR  packages field missing or empty\n';

function autofixSucceeded(taskId: string, pattern: string): void {
  audit('task.audit.autofix.succeeded', 'dispatcher', { taskId, pattern });
}

function taskFailed(taskId: string, stage: string): void {
  audit('task.failed', 'dispatcher', { taskId, stage, failure_log: PNPM_FAIL });
}

// ── 1. first occurrence → auto-fixable ──────────────────────────────────────

describe('first occurrence', () => {
  test('no prior autofix.succeeded → not repeat-ineffective; classification stays auto-fixable', () => {
    const taskId = 'PIPE-1';
    // A single fresh failure, no prior autofix history.
    taskFailed(taskId, 'gate');

    const raw = classifyFailure(PNPM_FAIL);
    assert.equal(raw.kind, 'auto-fixable');
    assert.equal(raw.pattern, 'pnpm-workspace-missing-packages');

    const ineffective = autofixRepeatIneffective(taskId, raw.pattern!, 'gate');
    assert.equal(ineffective, false, 'first occurrence must not be flagged');

    const out = demoteRepeatedAutofix(raw, ineffective);
    assert.equal(out.kind, 'auto-fixable', 'first occurrence is not demoted');
    assert.equal(out.repeatDemoted, undefined);
    assert.equal(out.autofix?.kind, 'rewrite-pnpm-workspace', 'autofix hint preserved');
  });
});

// ── 2. same pattern + prior succeeded + later same-stage failure → demoted ───

describe('proven-ineffective repeat', () => {
  test('autofix.succeeded then later same-stage failure → demoted with repeatDemoted', () => {
    const taskId = 'PIPE-2';
    // pass 1: heuristic patched the tree...
    autofixSucceeded(taskId, 'pnpm-workspace-missing-packages');
    // ...re-ran, and the SAME stage failed again.
    taskFailed(taskId, 'gate');

    const raw = classifyFailure(PNPM_FAIL);
    assert.equal(raw.kind, 'auto-fixable');

    const ineffective = autofixRepeatIneffective(taskId, raw.pattern!, 'gate');
    assert.equal(ineffective, true, 'same pattern + later same-stage failure is proven futile');

    const out = demoteRepeatedAutofix(raw, ineffective);
    assert.equal(out.kind, 'unknown', 'demoted to unknown so flow routes to Opus diagnostic');
    assert.equal(out.repeatDemoted, true);
    assert.equal(out.pattern, 'pnpm-workspace-missing-packages', 'original pattern attributable');
    assert.equal(out.autofix, undefined, 'unknown must not carry an autofix hint');
  });

  test('a different stage failing after the autofix does NOT demote (stage must match)', () => {
    const taskId = 'PIPE-2b';
    autofixSucceeded(taskId, 'pnpm-workspace-missing-packages');
    taskFailed(taskId, 'lint'); // different stage

    const ineffective = autofixRepeatIneffective(taskId, 'pnpm-workspace-missing-packages', 'gate');
    assert.equal(ineffective, false, 'a failure at a DIFFERENT stage is not the same loop');
  });

  test('failure BEFORE the autofix.succeeded does not count (must be later)', () => {
    const taskId = 'PIPE-2c';
    taskFailed(taskId, 'gate'); // earlier failure
    autofixSucceeded(taskId, 'pnpm-workspace-missing-packages');
    // no failure AFTER the succeeded row

    const ineffective = autofixRepeatIneffective(taskId, 'pnpm-workspace-missing-packages', 'gate');
    assert.equal(ineffective, false, 'only a failure AFTER the autofix proves it ineffective');
  });
});

// ── 3. prior autofix was a DIFFERENT task → not demoted ──────────────────────

describe('cross-task isolation', () => {
  test('prior autofix.succeeded + same-stage failure on ANOTHER task → not demoted', () => {
    const otherTask = 'PIPE-OTHER';
    const taskId = 'PIPE-3';
    // The futile loop happened on a different task entirely.
    autofixSucceeded(otherTask, 'pnpm-workspace-missing-packages');
    taskFailed(otherTask, 'gate');
    // This task is on its FIRST encounter with the pattern.
    taskFailed(taskId, 'gate');

    const ineffective = autofixRepeatIneffective(taskId, 'pnpm-workspace-missing-packages', 'gate');
    assert.equal(ineffective, false, 'another task’s history must not bleed into this task');

    const raw = classifyFailure(PNPM_FAIL);
    const out = demoteRepeatedAutofix(raw, ineffective);
    assert.equal(out.kind, 'auto-fixable');
    assert.equal(out.repeatDemoted, undefined);
  });

  test('also keyed on pattern — a DIFFERENT pattern’s prior autofix does not demote', () => {
    const taskId = 'PIPE-3b';
    autofixSucceeded(taskId, 'git-merge-conflict'); // a different heuristic succeeded
    taskFailed(taskId, 'gate');

    const ineffective = autofixRepeatIneffective(taskId, 'pnpm-workspace-missing-packages', 'gate');
    assert.equal(ineffective, false, 'the repeat check is keyed on the SAME pattern');
  });
});

// ── 4. prior autofix then task PASSED that stage before failing elsewhere ────

describe('intervening success at the stage', () => {
  test('autofix.succeeded, stage PASSED (task.gate.completed), later fails at finalize → not demoted', () => {
    const taskId = 'PIPE-4';
    // pass 1: a GATE-stage failure with the pnpm pattern; the heuristic patched
    // the tree and the autofix succeeded...
    taskFailed(taskId, 'gate');
    autofixSucceeded(taskId, 'pnpm-workspace-missing-packages');
    // ...the re-run PASSED the gate this time (the autofix WORKED)...
    audit('task.gate.completed', 'dispatcher', { taskId, stage: 'gate' });
    // ...and only later failed at a DIFFERENT stage (finalize, e.g. a transient
    // gh-create glitch — which would never classify as the pnpm pattern).
    taskFailed(taskId, 'finalize');

    // The gate autofix is the one under scrutiny: no task.failed at the GATE
    // stage followed it (only a later finalize failure), so it is NOT proven
    // ineffective. The gate heuristic must keep its auto-fixable status.
    const gateIneffective = autofixRepeatIneffective(
      taskId,
      'pnpm-workspace-missing-packages',
      'gate',
    );
    assert.equal(
      gateIneffective,
      false,
      'the autofix worked (gate passed); a later failure at a DIFFERENT stage must not demote it',
    );

    // Belt-and-suspenders: a fresh gate-stage failure with the pnpm signature on
    // THIS task therefore still classifies auto-fixable, not demoted.
    const raw = classifyFailure(PNPM_FAIL);
    const out = demoteRepeatedAutofix(raw, gateIneffective);
    assert.equal(out.kind, 'auto-fixable');
    assert.equal(out.repeatDemoted, undefined);
  });
});

// ── demote helper is a strict no-op outside the demotion case ────────────────

describe('demoteRepeatedAutofix — guard rails', () => {
  test('non-auto-fixable input is returned untouched even when flagged ineffective', () => {
    const operatorRequired = classifyFailure('remote: Repository not found.');
    assert.equal(operatorRequired.kind, 'operator-required');
    const out = demoteRepeatedAutofix(operatorRequired, true);
    assert.deepEqual(out, operatorRequired, 'only auto-fixable classifications are demotable');
  });

  test('auto-fixable input with ineffective=false is returned untouched', () => {
    const raw = classifyFailure(PNPM_FAIL);
    const out = demoteRepeatedAutofix(raw, false);
    assert.equal(out.kind, 'auto-fixable');
    assert.equal(out.repeatDemoted, undefined);
  });
});
