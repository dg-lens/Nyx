import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  routeAuditOutcome,
  type AuditOutcome,
  type AttemptStage,
} from '../src/audit-runner.js';

// FIX 3 — routing integration coverage for the `delivered` safety holes.
//
// The attempt loop in cli/run-once.ts cannot be imported in a unit test (the
// module calls main() at import time). The complete/re-run/halt decision the
// loop acts on was therefore extracted into the pure `routeAuditOutcome(stage,
// outcome)` function, and run-once is wired THROUGH it: the loop calls it and
// switches on `decision` to (a) clean up + return completed, (b) `continue`
// (re-run Claude + gate), or (c) haltTask. Exhaustively exercising the function
// here is exactly the end-to-end routing proof the spec demands.

const STAGES: AttemptStage[] = ['preflight', 'claude', 'gate', 'lint', 'expects', 'finalize'];

const deliveredWithUrl: AuditOutcome = {
  kind: 'delivered',
  pattern: 'claude-diagnostic',
  note: 'opened PR https://github.com/dg-lens/Nyx/pull/57',
  prUrl: 'https://github.com/dg-lens/Nyx/pull/57',
};

const deliveredWithSha: AuditOutcome = {
  kind: 'delivered',
  pattern: 'claude-diagnostic',
  note: 'pushed 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b to the integration branch',
  commitSha: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
};

const deliveredNoEvidence: AuditOutcome = {
  kind: 'delivered',
  pattern: 'claude-diagnostic',
  note: 'merged the worktree branch into main locally',
};

describe('routeAuditOutcome — end-to-end attempt-loop routing', () => {
  test('(a) finalize-stage failure + delivered-with-URL → complete', () => {
    // The single happy path: the gate already passed (finalize is the only stage
    // reached AFTER a green gate), and the ship is verifiable via the PR URL.
    // The loop then cleans up the working dir and returns status: completed — it
    // does NOT invoke attemptTask a second time and does NOT re-run the gate.
    assert.deepEqual(routeAuditOutcome('finalize', deliveredWithUrl), { decision: 'complete' });
  });

  test('(a′) finalize-stage failure + delivered-with-SHA → complete', () => {
    // A commit/branch SHA is equally valid evidence (local-merge / direct-push
    // tasks that never open a PR).
    assert.deepEqual(routeAuditOutcome('finalize', deliveredWithSha), { decision: 'complete' });
  });

  test('(b) gate-stage failure + delivered → demoted to re-run (the auto-complete-failed-work hole)', () => {
    // The gate FAILED, so the tree was never validated. A `delivered` verdict
    // here would, pre-fix, auto-complete a task whose gate never passed. The fix
    // demotes it: the loop `continue`s and a SECOND attemptTask runs (re-run
    // Claude + gate), revalidating the tree.
    assert.deepEqual(routeAuditOutcome('gate', deliveredWithUrl), {
      decision: 'rerun',
      demoted: 'wrong_stage',
    });
  });

  test('(c) finalize-stage + delivered with NO evidence → halt (operator decides)', () => {
    assert.deepEqual(routeAuditOutcome('finalize', deliveredNoEvidence), {
      decision: 'halt',
      demoted: 'no_evidence',
    });
  });

  test('every non-finalize stage demotes a delivered verdict to re-run — even WITH evidence', () => {
    // Evidence does not rescue a wrong-stage delivered: the gate still never ran
    // on this tree, so it must be revalidated regardless of the cited artifact.
    for (const stage of STAGES.filter(s => s !== 'finalize')) {
      assert.deepEqual(
        routeAuditOutcome(stage, deliveredWithUrl),
        { decision: 'rerun', demoted: 'wrong_stage' },
        `stage ${stage} with evidence must still demote to re-run`,
      );
      assert.deepEqual(
        routeAuditOutcome(stage, deliveredNoEvidence),
        { decision: 'rerun', demoted: 'wrong_stage' },
        `stage ${stage} without evidence must demote to re-run (wrong_stage wins over no_evidence)`,
      );
    }
  });

  test('autofix_applied always routes to re-run regardless of stage', () => {
    const autofix: AuditOutcome = {
      kind: 'autofix_applied',
      pattern: 'pnpm-config-drift',
      classification: 'auto-fixable',
    };
    for (const stage of STAGES) {
      assert.deepEqual(routeAuditOutcome(stage, autofix), { decision: 'rerun' });
    }
  });

  test('escalated_to_halt always routes to halt', () => {
    const halt: AuditOutcome = {
      kind: 'escalated_to_halt',
      pattern: 'claude-diagnostic',
      operatorReport: 'operator must rotate the token',
    };
    for (const stage of STAGES) {
      assert.deepEqual(routeAuditOutcome(stage, halt), { decision: 'halt' });
    }
  });

  test('audit_failed always routes to halt', () => {
    const failed: AuditOutcome = { kind: 'audit_failed', reason: 'spawn timed out' };
    for (const stage of STAGES) {
      assert.deepEqual(routeAuditOutcome(stage, failed), { decision: 'halt' });
    }
  });
});
