import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  parseDiagnosticVerdict,
  extractDeliveredEvidence,
  routeAuditOutcome,
  type AuditOutcome,
} from '../src/audit-runner.js';

describe('parseDiagnosticVerdict — delivered verdict (stops the full-rerun loop)', () => {
  test('recognizes VERDICT: delivered and extracts the GitHub PR URL from the note', () => {
    const stdout = [
      'Inspected the working dir; gh pr create had hit a transient 502.',
      'Re-ran it manually; the PR opened cleanly.',
      'VERDICT: delivered — opened PR https://github.com/dg-lens/Nyx/pull/57 by re-running gh pr create',
    ].join('\n');
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
    if (verdict.kind === 'delivered') {
      assert.equal(verdict.prUrl, 'https://github.com/dg-lens/Nyx/pull/57');
      assert.match(verdict.note, /opened PR/);
    }
  });

  test('extracts a commit SHA (full 40-char) as evidence when there is no PR URL', () => {
    const stdout =
      'VERDICT: delivered — pushed the integration branch at 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
    if (verdict.kind === 'delivered') {
      assert.equal(verdict.prUrl, undefined);
      assert.equal(verdict.commitSha, '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b');
    }
  });

  test('extracts a short 7-char commit SHA as evidence', () => {
    const stdout = 'VERDICT: delivered — pushed 3b57dbc to the release branch';
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
    if (verdict.kind === 'delivered') {
      assert.equal(verdict.commitSha, '3b57dbc');
    }
  });

  test('does NOT treat an all-letter hex word (e.g. "defaced") as a short SHA — no digit', () => {
    const stdout = 'VERDICT: delivered — defaced the readme but did not actually push';
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
    if (verdict.kind === 'delivered') {
      assert.equal(verdict.commitSha, undefined);
      assert.equal(verdict.prUrl, undefined);
    }
  });

  test('a bare prose claim with NO URL and NO SHA carries no evidence, and routing DEMOTES it to halt', () => {
    // Rewritten from the original test that asserted a no-evidence delivered was
    // accepted at face value (prUrl === undefined and nothing more). The safety
    // hole was exactly that: an evidence-free "delivered" auto-completed the task
    // on the agent's word. The parser still recognizes the verdict, but it must
    // surface ZERO evidence, and the routing layer must demote it.
    const stdout = 'VERDICT: delivered — merged the worktree branch into main locally';
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
    if (verdict.kind === 'delivered') {
      assert.equal(verdict.prUrl, undefined);
      assert.equal(verdict.commitSha, undefined);
    }

    // Even at the finalize stage (the only stage that can auto-complete), a
    // delivered verdict with no artifact evidence must route to halt — operator
    // decides — NOT to completion.
    const outcome: AuditOutcome = {
      kind: 'delivered',
      pattern: 'claude-diagnostic',
      note: 'merged the worktree branch into main locally',
    };
    const route = routeAuditOutcome('finalize', outcome);
    assert.deepEqual(route, { decision: 'halt', demoted: 'no_evidence' });
  });

  test('delivered takes precedence over fixed when both substrings could plausibly match', () => {
    // Defensive: ensure the parser walks lines back-to-front and the dedicated
    // delivered branch fires before the fixed branch on the same line.
    const stdout = 'VERDICT: delivered — also fixed a stale lockfile along the way';
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
  });

  test('still recognizes the original fixed and halt verdicts (regression guard)', () => {
    assert.equal(parseDiagnosticVerdict('VERDICT: fixed — patched the import').kind, 'fixed');
    assert.equal(parseDiagnosticVerdict('VERDICT: halt: operator must rotate the BWS token').kind, 'halt');
    assert.equal(parseDiagnosticVerdict('no verdict line at all').kind, 'unparseable');
  });
});

describe('extractDeliveredEvidence', () => {
  test('returns the PR URL when present', () => {
    const { prUrl, commitSha } = extractDeliveredEvidence(
      'opened https://github.com/dg-lens/Nyx/pull/57 cleanly',
    );
    assert.equal(prUrl, 'https://github.com/dg-lens/Nyx/pull/57');
    assert.equal(commitSha, undefined);
  });

  test('returns a 40-char SHA when present and no URL', () => {
    const { prUrl, commitSha } = extractDeliveredEvidence(
      'pushed 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    );
    assert.equal(prUrl, undefined);
    assert.equal(commitSha, '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b');
  });

  test('returns a 7-char SHA when present (contains a digit)', () => {
    assert.equal(extractDeliveredEvidence('pushed 3b57dbc').commitSha, '3b57dbc');
  });

  test('returns nothing for a bare prose claim', () => {
    assert.deepEqual(extractDeliveredEvidence('merged it locally, all good'), {});
  });

  test('does NOT mistake a short ordinary English word as a SHA (non-hex letters)', () => {
    // "merged" contains non-hex letters (g, r), so it is not a hex token.
    assert.deepEqual(extractDeliveredEvidence('merged the branch'), {});
  });

  test('does NOT mistake an all-letter hex word as a SHA (no digit)', () => {
    // "defaced" / "facade" are valid hex but have no digit; real abbreviated git
    // SHAs effectively always carry one, so requiring a digit rejects these.
    assert.deepEqual(extractDeliveredEvidence('defaced the page'), {});
    assert.deepEqual(extractDeliveredEvidence('a facade of progress'), {});
  });
});
