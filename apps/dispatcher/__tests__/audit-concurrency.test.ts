/**
 * Regression guard for the concurrency redesign (Track 3, Phase 0).
 *
 * The two-class scheduler runs multiple ISO tasks concurrently, each of which
 * emits audit events. The hash chain stays linear ONLY because `audit()` is
 * synchronous start-to-finish (no `await` between the prev-hash read and the
 * insert), so Node's single event loop can never interleave two `audit()` calls.
 * This test fires `audit()` from N concurrently-resolved promises and asserts
 * `verifyChain()` still passes — locking in that invariant against a future
 * change that makes `audit()` async.
 */
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, verifyChain } from '../src/audit.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
});

describe('audit chain under concurrent emitters', () => {
  test('N concurrent audit() calls keep the hash chain linear', async () => {
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          audit('task.completed', 'dispatcher', { taskId: `ISO-${i}`, durationMs: i }),
        ),
      ),
    );
    const chain = verifyChain();
    assert.equal(chain.ok, true, `chain broke: ${chain.reason} at row ${chain.firstBadRowId}`);
    assert.equal(chain.totalRows, N);
  });

  test('interleaved different event types still verify', async () => {
    await Promise.all([
      Promise.resolve().then(() => audit('dispatch.iso_pool.drained', 'dispatcher', { count: 3 })),
      Promise.resolve().then(() => audit('task.skipped.rate_limited', 'dispatcher', { taskId: 'A' })),
      Promise.resolve().then(() => audit('dispatch.rate_limited', 'dispatcher', { taskId: 'A', until: Date.now() + 1000 })),
      Promise.resolve().then(() => audit('task.skipped.git_busy', 'dispatcher', { taskId: 'CODE-1' })),
      Promise.resolve().then(() => audit('task.skipped.iso_cap', 'dispatcher', { taskId: 'BRIEF-1' })),
    ]);
    const chain = verifyChain();
    assert.equal(chain.ok, true);
    assert.equal(chain.totalRows, 5);
  });
});
