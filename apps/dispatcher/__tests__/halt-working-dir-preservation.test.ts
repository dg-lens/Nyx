/**
 * Regression test for the halt-working-dir-preservation invariant.
 *
 * Bug: run-once.ts called git.inFlight() BEFORE isTaskHalted(). When a task
 * halts, the dispatcher process exits (launchd fires a new process each tick).
 * On the next tick, inFlight() sees the preserved working dir but its sentinel
 * PID is dead (the halting process is gone). inFlight() treats this as a ghost
 * and wipes the dir ("stale_cleared") BEFORE the halt-chain guard ever runs —
 * the operator's salvage window is destroyed.
 *
 * Fix: isTaskHalted is checked first. A halted task skips immediately without
 * calling inFlight at all, leaving the preserved dir intact.
 *
 * These tests enforce the invariant at unit level:
 *   1. inFlight with a dead-PID dir → 'stale_cleared', dir wiped
 *   2. isTaskHalted for a halted task → true, dir untouched
 *   3. Correct sequence (halt-check first) leaves the preserved dir intact
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, isTaskHalted } from '../src/audit.js';
import { _setWorktreesDir, inFlight } from '../src/git-ops.js';

let tmpDir: string;
let memDb: DatabaseSync;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-halt-dir-'));
  _setWorktreesDir(tmpDir);

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
  _setWorktreesDir(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeTaskId(): string {
  return `TEST-HALT-DIR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Create a working dir with a dead-PID sentinel — simulates a halted task's preserved dir. */
function makeDeadPidWorktree(taskId: string): string {
  const dir = resolve(tmpDir, taskId);
  mkdirSync(dir, { recursive: true });
  // PID 2_000_000 is above the macOS max pid (99999) — guaranteed never alive.
  writeFileSync(
    resolve(dir, '.nyx-task.pid'),
    JSON.stringify({ pid: 2_000_000, taskId, startedAt: new Date().toISOString() }),
    'utf8',
  );
  return dir;
}

// ── 1. inFlight wipes dead-PID dirs (confirming the danger) ─────────────────

describe('inFlight — dead-PID dir is wiped', () => {
  test('returns stale_cleared and removes the dir when sentinel PID is dead', () => {
    const taskId = makeTaskId();
    const dir = makeDeadPidWorktree(taskId);

    assert.ok(existsSync(dir), 'pre-condition: dir exists before inFlight call');
    const status = inFlight(taskId);
    assert.equal(status, 'stale_cleared');
    assert.ok(!existsSync(dir), 'dir must be gone after inFlight stale-clear');
  });
});

// ── 2. isTaskHalted returns true without touching the working dir ─────────────

describe('isTaskHalted — reports halted status without touching working dir', () => {
  test('returns true for a task whose last lifecycle event is task.halted_for_review', () => {
    const taskId = makeTaskId();
    audit('task.halted_for_review', 'dispatcher', {
      taskId,
      pattern: 'test-pattern',
      operator_report: 'test halt',
      working_dir: '/tmp/test',
    });

    assert.ok(isTaskHalted(taskId));
  });

  test('returns false after task.resumed clears the halt', () => {
    const taskId = makeTaskId();
    audit('task.halted_for_review', 'dispatcher', { taskId, pattern: 'x', operator_report: 'x', working_dir: '/tmp/x' });
    audit('task.resumed', 'dispatcher', { taskId });
    assert.ok(!isTaskHalted(taskId));
  });

  test('does NOT touch the working dir — dir survives isTaskHalted call', () => {
    const taskId = makeTaskId();
    audit('task.halted_for_review', 'dispatcher', { taskId, pattern: 'x', operator_report: 'x', working_dir: '/tmp/x' });
    const dir = makeDeadPidWorktree(taskId);

    assert.ok(isTaskHalted(taskId), 'isTaskHalted must return true');
    assert.ok(existsSync(dir), 'working dir must still exist after isTaskHalted — it must not call inFlight');
  });
});

// ── 3. Correct ordering preserves the dir; wrong ordering destroys it ─────────

describe('halt-check ordering invariant', () => {
  test('wrong order (inFlight first): dir is wiped before halt check can protect it', () => {
    const taskId = makeTaskId();
    audit('task.halted_for_review', 'dispatcher', { taskId, pattern: 'x', operator_report: 'x', working_dir: '/tmp/x' });
    const dir = makeDeadPidWorktree(taskId);

    // Simulate WRONG order: inFlight runs first
    const flightStatus = inFlight(taskId);
    assert.equal(flightStatus, 'stale_cleared');
    // Even though the task is halted, the dir is already gone
    assert.ok(!existsSync(dir), 'dir destroyed — this is the bug');
    assert.ok(isTaskHalted(taskId), 'task is halted but its working dir was wiped');
  });

  test('correct order (isTaskHalted first): halted task is skipped, dir survives', () => {
    const taskId = makeTaskId();
    audit('task.halted_for_review', 'dispatcher', { taskId, pattern: 'x', operator_report: 'x', working_dir: '/tmp/x' });
    const dir = makeDeadPidWorktree(taskId);

    // Simulate CORRECT order: halt check runs first, short-circuits before inFlight
    if (isTaskHalted(taskId)) {
      // skip — do NOT call inFlight
    } else {
      inFlight(taskId); // would wipe dir, but we never reach this
    }

    assert.ok(existsSync(dir), 'dir preserved — operator can salvage the halted task');
  });
});
