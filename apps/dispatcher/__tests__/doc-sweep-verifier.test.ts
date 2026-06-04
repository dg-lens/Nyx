import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  checkDocUpdatesSpecMalformed,
  verifyDocUpdates,
} from '../src/doc-sweep-verifier.js';

// ─── verifyDocUpdates ──────────────────────────────────────────────────────────

describe('verifyDocUpdates — no ## Doc updates section', () => {
  test('passes when spec has no ## Doc updates heading', () => {
    const spec = '- [ ] FOO — do something\n      Some description.\n      [type: code]';
    const result = verifyDocUpdates(spec, []);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, []);
  });

  test('passes when spec has unrelated ## heading but no Doc updates', () => {
    const spec = '## Active Tasks\n- [ ] FOO — work\n      [type: code]';
    const result = verifyDocUpdates(spec, []);
    assert.ok(result.ok);
  });
});

describe('verifyDocUpdates — T3 concrete path', () => {
  test('fails when T3 path not in diffFiles', () => {
    const spec = [
      '- [ ] EMP-001 — add route',
      '      ## Doc updates',
      '      - T3 (apps/outreach-api/CLAUDE.md): add route X',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['apps/outreach-api/routes.py']);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.deepEqual(result.missing, ['apps/outreach-api/CLAUDE.md']);
    assert.deepEqual(result.verifiedPaths, []);
  });

  test('passes when T3 path is in diffFiles', () => {
    const spec = [
      '- [ ] EMP-001 — add route',
      '      ## Doc updates',
      '      - T3 (apps/outreach-api/CLAUDE.md): add route X',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, [
      'apps/outreach-api/routes.py',
      'apps/outreach-api/CLAUDE.md',
    ]);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, ['apps/outreach-api/CLAUDE.md']);
  });

  test('fails when one of two declared paths is missing', () => {
    const spec = [
      '- [ ] FOO — multi-doc update',
      '      ## Doc updates',
      '      - T3 (apps/marketing-api/CLAUDE.md): add env var',
      '      - T3 (apps/outreach-api/CLAUDE.md): add route',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['apps/marketing-api/CLAUDE.md']);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.deepEqual(result.missing, ['apps/outreach-api/CLAUDE.md']);
    assert.deepEqual(result.verifiedPaths, ['apps/marketing-api/CLAUDE.md']);
  });
});

describe('verifyDocUpdates — T2 Nyx path normalization', () => {
  test('normalizes ~/Nyx/ prefix for working-tree comparison', () => {
    const spec = [
      '- [ ] NYX-001 — dispatcher change',
      '      ## Doc updates',
      '      - T2 (~/Nyx/CLAUDE.md): document new events.',
      '      [type: code]',
    ].join('\n');
    // Claude would modify CLAUDE.md in the worktree, which shows as "CLAUDE.md"
    const result = verifyDocUpdates(spec, ['CLAUDE.md', 'apps/dispatcher/src/foo.ts']);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, ['CLAUDE.md']);
  });

  test('fails when ~/Nyx/ path not in diffFiles', () => {
    const spec = [
      '- [ ] NYX-001 — dispatcher change',
      '      ## Doc updates',
      '      - T2 (~/Nyx/CLAUDE.md): document new events.',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['apps/dispatcher/src/foo.ts']);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.deepEqual(result.missing, ['CLAUDE.md']);
  });
});

describe('verifyDocUpdates — T1 references are skipped', () => {
  test('T1 reference is never counted as missing', () => {
    const spec = [
      '- [ ] NYX-002 — global doc update',
      '      ## Doc updates',
      '      - T1 §5: note that verifier runs at finalize.',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, []);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, []);
  });

  test('T1 + T3: T1 skipped, T3 checked', () => {
    const spec = [
      '- [ ] MIXED — doc updates',
      '      ## Doc updates',
      '      - T1 §5: update global.',
      '      - T3 (apps/foo/CLAUDE.md): update route list.',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, []);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.deepEqual(result.missing, ['apps/foo/CLAUDE.md']);
  });
});

describe('verifyDocUpdates — T4 advisory lines are skipped', () => {
  test('advisory T4 line is not treated as a verifiable path', () => {
    const spec = [
      '- [ ] FOO — bug fix',
      '      ## Doc updates',
      '      - If your fix surfaces a debugging lesson, write a T4 entry per the protocol in `~/.claude/CLAUDE.md` §4',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, []);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, []);
  });
});

describe('verifyDocUpdates — backtick paths', () => {
  test('extracts backtick-quoted path with slash', () => {
    const spec = [
      '- [ ] EMP-002 — marketing change',
      '      ## Doc updates',
      '      - Add env var to T3 (`apps/marketing-api/CLAUDE.md` — Required env vars section).',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['apps/marketing-api/CLAUDE.md']);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, ['apps/marketing-api/CLAUDE.md']);
  });

  test('backtick path fails when not in diffFiles', () => {
    const spec = [
      '- [ ] EMP-002 — marketing change',
      '      ## Doc updates',
      '      - Add env var to T3 (`apps/marketing-api/CLAUDE.md` — Required env vars section).',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, []);
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.deepEqual(result.missing, ['apps/marketing-api/CLAUDE.md']);
  });
});

describe('verifyDocUpdates — empty ## Doc updates section', () => {
  test('passes when section exists but has no bullets', () => {
    const spec = [
      '- [ ] FOO — test-only change',
      '      ## Doc updates',
      '      N/A — internal refactor, no future agent context affected.',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, []);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, []);
  });

  test('passes when section has only T1 and advisory T4 bullets', () => {
    const spec = [
      '- [ ] FOO — test-only change',
      '      ## Doc updates',
      '      - T1 §3: note something in global docs.',
      '      - If applicable, write a T4 entry per the protocol.',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, []);
    assert.ok(result.ok);
  });
});

describe('verifyDocUpdates — indented heading (queue format)', () => {
  test('finds ## Doc updates even with leading whitespace (queue indentation)', () => {
    const spec = [
      '- [ ] NYX-DOC-SWEEP-VERIFIER — Hard-enforce the doc contract',
      '',
      '      Some long description here.',
      '',
      '      ## Doc updates',
      '        - T2 (~/Nyx/CLAUDE.md): document new events.',
      '',
      '      [type: code] [model: sonnet] [gate: typecheck,tests]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['CLAUDE.md']);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, ['CLAUDE.md']);
  });
});

describe('verifyDocUpdates — T3 path without parens', () => {
  test('extracts bare T3 path: T3 apps/foo/CLAUDE.md', () => {
    const spec = [
      '- [ ] FOO — bare path',
      '      ## Doc updates',
      '      - T3 apps/foo/CLAUDE.md: update deploy section',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['apps/foo/CLAUDE.md']);
    assert.ok(result.ok);
    assert.deepEqual(result.verifiedPaths, ['apps/foo/CLAUDE.md']);
  });
});

describe('verifyDocUpdates — suffix match for longer diffFile paths', () => {
  test('matches when diffFile has a longer prefix than the declared path', () => {
    const spec = [
      '- [ ] FOO — change',
      '      ## Doc updates',
      '      - T3 (apps/foo/CLAUDE.md): update section',
      '      [type: code]',
    ].join('\n');
    const result = verifyDocUpdates(spec, ['repo-root/apps/foo/CLAUDE.md']);
    assert.ok(result.ok);
  });
});

// ─── checkDocUpdatesSpecMalformed ─────────────────────────────────────────────

describe('checkDocUpdatesSpecMalformed', () => {
  test('returns null when no ## Doc updates section', () => {
    const spec = '- [ ] FOO — work\n      [type: code]';
    assert.equal(checkDocUpdatesSpecMalformed(spec), null);
  });

  test('returns null when section has concrete paths', () => {
    const spec = [
      '- [ ] FOO — work',
      '      ## Doc updates',
      '      - T3 (apps/foo/CLAUDE.md): update',
      '      [type: code]',
    ].join('\n');
    assert.equal(checkDocUpdatesSpecMalformed(spec), null);
  });

  test('returns error for "T3 of the affected repo" fuzzy reference', () => {
    const spec = [
      '- [ ] FOO — work',
      '      ## Doc updates',
      '      - T3 of the affected repo: update the relevant section',
      '      [type: code]',
    ].join('\n');
    const result = checkDocUpdatesSpecMalformed(spec);
    assert.ok(result !== null);
    assert.match(result, /fuzzy tier reference/);
  });

  test('returns error for "T2 in the relevant sub-app" fuzzy reference', () => {
    const spec = [
      '- [ ] FOO — work',
      '      ## Doc updates',
      '      - T2 in the relevant sub-app',
      '      [type: code]',
    ].join('\n');
    const result = checkDocUpdatesSpecMalformed(spec);
    assert.ok(result !== null);
    assert.match(result, /fuzzy tier reference/);
  });

  test('returns null for T1 references (T1 is always allowed)', () => {
    const spec = [
      '- [ ] FOO — work',
      '      ## Doc updates',
      '      - T1 §5: update note',
      '      [type: code]',
    ].join('\n');
    assert.equal(checkDocUpdatesSpecMalformed(spec), null);
  });

  test('returns null when section has only advisory T4 lines', () => {
    const spec = [
      '- [ ] FOO — work',
      '      ## Doc updates',
      '      - If applicable, write a T4 entry per the protocol.',
      '      [type: code]',
    ].join('\n');
    assert.equal(checkDocUpdatesSpecMalformed(spec), null);
  });
});
