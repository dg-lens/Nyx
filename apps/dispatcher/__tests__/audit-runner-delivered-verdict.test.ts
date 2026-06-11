import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { parseDiagnosticVerdict } from '../src/audit-runner.js';

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

  test('recognizes VERDICT: delivered without a URL (e.g. local-merge task)', () => {
    const stdout = 'VERDICT: delivered — merged the worktree branch into main locally';
    const verdict = parseDiagnosticVerdict(stdout);
    assert.equal(verdict.kind, 'delivered');
    if (verdict.kind === 'delivered') {
      assert.equal(verdict.prUrl, undefined);
    }
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
