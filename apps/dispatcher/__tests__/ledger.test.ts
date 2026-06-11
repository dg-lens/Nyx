import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, type AuditEvent, type AuditRow } from '../src/audit.js';
import {
  _resetLedgerRenderMemo,
  _setLedgerDb,
  addNote,
  getNotesSince,
  maybeRenderLedgerAtTickEnd,
  projectLedger,
  renderLedger,
  sentenceForRun,
  writeLedgerFile,
  type LedgerNote,
} from '../src/ledger.js';
import { projectRunTrees } from '../src/eval/run-tree.js';

let scratch: string;

beforeEach(() => {
  _setAuditDb(new DatabaseSync(':memory:'));
  _setLedgerDb(new DatabaseSync(':memory:'));
  _resetLedgerRenderMemo();
  scratch = mkdtempSync(join(tmpdir(), 'ledger-test-'));
});

afterEach(() => {
  _setAuditDb(null);
  _setLedgerDb(null);
  _resetLedgerRenderMemo();
  rmSync(scratch, { recursive: true, force: true });
});

function row(at: string, event: AuditEvent, actor: string, payload: Record<string, unknown>): AuditRow {
  return {
    id: ID_SEQ++,
    at,
    event,
    actor,
    payload: JSON.stringify(payload),
    row_hash: 'x',
    prev_hash: 'x',
  };
}
let ID_SEQ = 1;
beforeEach(() => {
  ID_SEQ = 1;
});

const GEN = { generatedAt: new Date('2026-06-10T12:00:00Z'), systemName: 'Nyx', instanceName: 'nyx@hub' };

describe('sentenceForRun — one human sentence per run via run-tree outcome', () => {
  test('a completed code task names id, type, PR url, duration, cost', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-1', type: 'code' }),
      row('2026-06-09T10:05:00.000Z', 'task.usage.metered', 'dispatcher', { taskId: 'T-1', estimated_cost_usd: 0.12 }),
      row('2026-06-09T10:05:00.000Z', 'task.pr.created', 'dispatcher', { taskId: 'T-1', prUrl: 'https://gh/pr/9' }),
      row('2026-06-09T10:05:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', durationMs: 300_000 }),
    ]);
    const s = sentenceForRun(trees[0]!);
    assert.match(s, /^T-1 \(code\) delivered/);
    assert.match(s, /https:\/\/gh\/pr\/9/);
    assert.match(s, /in 5\.0m/);
    assert.match(s, /\$0\.1200/);
  });

  test('a failed run names the failure stage', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-2', type: 'code' }),
      row('2026-06-09T10:01:00.000Z', 'task.failed', 'dispatcher', { taskId: 'T-2', stage: 'gate' }),
    ]);
    assert.match(sentenceForRun(trees[0]!), /T-2 \(code\) failed at gate/);
  });

  test('a halted run carries the halt pattern (production payload shape)', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-3', type: 'code' }),
      row('2026-06-09T10:01:00.000Z', 'task.halted_for_review', 'dispatcher', { taskId: 'T-3', pattern: 'aesthetic-ambiguity', operator_report: 'needs a call' }),
    ]);
    assert.match(sentenceForRun(trees[0]!), /T-3 \(code\) halted — aesthetic-ambiguity/);
  });

  test('halt pattern is read from the halt event itself, not shadowed by another event’s reason', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-3b', type: 'code' }),
      row('2026-06-09T10:04:00.000Z', 'task.wisdom.skipped', 'dispatcher', { taskId: 'T-3b', reason: 'no file or malformed' }),
      row('2026-06-09T10:05:00.000Z', 'task.halted_for_review', 'dispatcher', { taskId: 'T-3b', pattern: 'audit-cap', operator_report: 'cap reached' }),
    ]);
    const s = sentenceForRun(trees[0]!);
    assert.match(s, /T-3b \(code\) halted — audit-cap/);
    assert.doesNotMatch(s, /no file or malformed/);
  });

  test('halted → resumed → halted again renders the latest halt’s pattern', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-3c', type: 'code' }),
      row('2026-06-09T10:01:00.000Z', 'task.halted_for_review', 'dispatcher', { taskId: 'T-3c', pattern: 'expects-prevalidate' }),
      row('2026-06-09T10:02:00.000Z', 'task.resumed', 'dispatcher', { taskId: 'T-3c', note: 'paths fixed' }),
      row('2026-06-09T10:03:00.000Z', 'task.halted_for_review', 'dispatcher', { taskId: 'T-3c', pattern: 'audit-cap' }),
    ]);
    assert.match(sentenceForRun(trees[0]!), /T-3c \(code\) halted — audit-cap/);
  });

  test('an in-progress run reads as in flight', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-4', type: 'analysis' }),
    ]);
    assert.match(sentenceForRun(trees[0]!), /T-4 \(analysis\) in flight/);
  });

  test('a pipeline run is labelled pipeline and reads delivered', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'pipeline.run.started', 'pipeline', { runId: 'P-1' }),
      row('2026-06-09T10:10:00.000Z', 'pipeline.delivered', 'pipeline', { runId: 'P-1' }),
    ]);
    const s = sentenceForRun(trees[0]!);
    assert.match(s, /P-1 \(pipeline\) delivered/);
  });

  test('a code task folds the content-judge score when present', () => {
    const trees = projectRunTrees([
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'J-1', type: 'code' }),
      row('2026-06-09T10:04:00.000Z', 'task.judge.captured', 'judge', { taskId: 'J-1', verdict: 'PASS', confidence: 88 }),
      row('2026-06-09T10:05:00.000Z', 'task.completed', 'dispatcher', { taskId: 'J-1' }),
    ]);
    assert.match(sentenceForRun(trees[0]!), /judge PASS 88/);
  });
});

describe('projectLedger — categorises runs + observations + notes into sections', () => {
  test('runs land in Delivered / In flight / Blocked-needs-operator / Incidents by outcome', () => {
    const rows: AuditRow[] = [
      row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'D-1', type: 'code' }),
      row('2026-06-09T10:01:00.000Z', 'task.started', 'dispatcher', { taskId: 'F-1', type: 'analysis' }),
      row('2026-06-09T10:02:00.000Z', 'task.failed', 'dispatcher', { taskId: 'X-1', type: 'code', stage: 'gate' }),
      row('2026-06-09T10:03:00.000Z', 'task.halted_for_review', 'dispatcher', { taskId: 'H-1', type: 'code', pattern: 'needs-decision' }),
    ];
    const { entries } = projectLedger(rows, [], 'nyx@hub');
    const sectionOf = (id: string) => entries.find((e) => e.sentence.startsWith(id))?.section;
    assert.equal(sectionOf('D-1'), 'Delivered');
    assert.equal(sectionOf('F-1'), 'In flight');
    assert.equal(sectionOf('X-1'), 'Incidents');
    assert.equal(sectionOf('H-1'), 'Blocked-needs-operator');
  });

  test('system-level events land in Observations', () => {
    const rows: AuditRow[] = [
      row('2026-06-09T10:00:00.000Z', 'dispatch.rate_limited', 'dispatcher', { cooldownMs: 300_000 }),
      row('2026-06-09T10:01:00.000Z', 'task.mcp.breaker_opened', 'mcp', { server: 'supabase' }),
    ];
    const { entries } = projectLedger(rows, [], 'nyx@hub');
    const obs = entries.filter((e) => e.section === 'Observations');
    assert.equal(obs.length, 2);
    assert.match(obs.map((e) => e.sentence).join('\n'), /rate limited/);
    assert.match(obs.map((e) => e.sentence).join('\n'), /MCP breaker opened \(supabase\)/);
  });

  test('manual notes land ONLY in Notes — no dual-write of dispatcher activity', () => {
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'D-1', type: 'code' })];
    const notes: LedgerNote[] = [
      { id: 1, at: '2026-06-09T11:00:00.000Z', actor: 'operator', category: 'decision', text: 'switched base branch to dev', ref: 'D-1' },
    ];
    const { entries } = projectLedger(rows, notes, 'nyx@hub');
    const noteEntries = entries.filter((e) => e.section === 'Notes');
    assert.equal(noteEntries.length, 1);
    assert.match(noteEntries[0]!.sentence, /\[decision\] switched base branch to dev \(D-1\)/);
    // The completed task is NOT duplicated into Notes.
    assert.equal(entries.filter((e) => e.section === 'Notes' && e.sentence.includes('D-1 ')).length, 0);
  });

  test('every run entry is prefixed with the instance actor, not the raw chain actor', () => {
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'mcp-resilience', { taskId: 'D-1', type: 'code' })];
    const { entries } = projectLedger(rows, [], 'nyx@hub');
    assert.equal(entries[0]!.actor, 'nyx@hub');
  });
});

describe('renderLedger — day-grouped, sectioned markdown', () => {
  test('header marks a generated view + window; empty input still valid', () => {
    const md = renderLedger({ entries: [], rowCount: 0 }, { ...GEN, windowDays: 7 });
    assert.match(md, /^# Nyx — Activity Ledger\n/);
    assert.match(md, /Generated view — do not edit/);
    assert.match(md, /7-day window/);
    assert.match(md, /No activity in window/);
  });

  test('newest day first; sections render in canonical order with actor + time', () => {
    const rows: AuditRow[] = [
      row('2026-06-08T09:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'OLD-1', type: 'code' }),
      row('2026-06-09T10:00:00.000Z', 'task.failed', 'dispatcher', { taskId: 'NEW-1', type: 'code', stage: 'gate' }),
      row('2026-06-09T10:01:00.000Z', 'task.completed', 'dispatcher', { taskId: 'NEW-2', type: 'code' }),
    ];
    const md = renderLedger(projectLedger(rows, [], 'nyx@hub'), GEN);
    const jun9 = md.indexOf('## 2026-06-09');
    const jun8 = md.indexOf('## 2026-06-08');
    assert.ok(jun9 > 0 && jun8 > 0, 'both days present');
    assert.ok(jun9 < jun8, 'newest day first');
    // Within 2026-06-09, Delivered (NEW-2) renders before Incidents (NEW-1).
    const delivered = md.indexOf('### Delivered');
    const incidents = md.indexOf('### Incidents');
    assert.ok(delivered > 0 && incidents > delivered, 'Delivered before Incidents');
    assert.match(md, /- `10:01:00` \*\*\[nyx@hub\]\*\* NEW-2 \(code\) delivered/);
  });

  test('an empty section is omitted', () => {
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'D-1', type: 'code' })];
    const md = renderLedger(projectLedger(rows, [], 'nyx@hub'), GEN);
    assert.match(md, /### Delivered/);
    assert.doesNotMatch(md, /### Incidents/);
    assert.doesNotMatch(md, /### Notes/);
  });
});

describe('redaction — secrets never reach the on-disk doc', () => {
  test('a token echoed in a failure_log is redacted before write', () => {
    const out = join(scratch, 'LEDGER.md');
    const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const rows: AuditRow[] = [
      row('2026-06-09T10:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-1', type: 'code' }),
      row('2026-06-09T10:01:00.000Z', 'task.halted_for_review', 'dispatcher', { taskId: 'T-1', reason: `leaked ${secret} oops` }),
    ];
    writeLedgerFile({ rows, notes: [], outPath: out, ...GEN });
    const body = readFileSync(out, 'utf8');
    assert.doesNotMatch(body, /ghp_a{36}/);
    assert.match(body, /\[REDACTED\]/);
  });
});

describe('ledger_notes — addNote / getNotesSince via _setLedgerDb', () => {
  test('addNote persists and getNotesSince reads it back newest-first', () => {
    addNote('first note', { at: '2026-06-09T10:00:00.000Z', actor: 'op', category: 'decision' });
    addNote('second note', { at: '2026-06-09T11:00:00.000Z', actor: 'op', ref: 'T-9' });
    const notes = getNotesSince('2026-06-09T00:00:00.000Z');
    assert.equal(notes.length, 2);
    assert.equal(notes[0]!.text, 'second note');
    assert.equal(notes[0]!.ref, 'T-9');
    assert.equal(notes[1]!.category, 'decision');
  });

  test('getNotesSince respects the lower bound', () => {
    addNote('old', { at: '2026-06-01T10:00:00.000Z', actor: 'op' });
    addNote('recent', { at: '2026-06-09T10:00:00.000Z', actor: 'op' });
    const notes = getNotesSince('2026-06-05T00:00:00.000Z');
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.text, 'recent');
  });

  test('addNote rejects empty text', () => {
    assert.throws(() => addNote('   '), /empty/);
  });

  test('a written ledger surfaces the note under Notes', () => {
    const out = join(scratch, 'LEDGER.md');
    addNote('remember to rotate the token', { at: '2026-06-09T10:00:00.000Z', actor: 'op', category: 'reminder' });
    writeLedgerFile({ rows: [], outPath: out, sinceIso: '2026-06-01T00:00:00.000Z', ...GEN });
    const body = readFileSync(out, 'utf8');
    assert.match(body, /### Notes/);
    assert.match(body, /\[reminder\] remember to rotate the token/);
  });
});

describe('writeLedgerFile — atomic write', () => {
  test('writes to outPath, returns byte count, creates parent dirs', () => {
    const out = join(scratch, 'nested', 'dir', 'LEDGER.md');
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', type: 'code' })];
    const res = writeLedgerFile({ rows, notes: [], outPath: out, ...GEN });
    assert.equal(res.path, out);
    assert.equal(res.entries, 1);
    const body = readFileSync(out, 'utf8');
    assert.equal(Buffer.byteLength(body, 'utf8'), res.bytes);
    assert.match(body, /T-1 \(code\) delivered/);
  });

  test('overwrites existing file — re-render is idempotent', () => {
    const out = join(scratch, 'LEDGER.md');
    writeFileSync(out, 'stale\n', 'utf8');
    writeLedgerFile({
      rows: [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-2', type: 'code' })],
      notes: [],
      outPath: out,
      ...GEN,
    });
    const body = readFileSync(out, 'utf8');
    assert.doesNotMatch(body, /stale/);
    assert.match(body, /T-2/);
  });

  test('no .tmp files left behind on success', () => {
    const out = join(scratch, 'LEDGER.md');
    mkdirSync(scratch, { recursive: true });
    writeLedgerFile({
      rows: [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', type: 'code' })],
      notes: [],
      outPath: out,
      ...GEN,
    });
    const leftovers = readdirSync(scratch).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  test('reads from the audit chain + notes table when rows/notes are not supplied', () => {
    audit('task.started', 'dispatcher', { taskId: 'T-7', type: 'code' });
    audit('task.completed', 'dispatcher', { taskId: 'T-7' });
    addNote('a live note', { actor: 'op' });
    const out = join(scratch, 'LEDGER.md');
    const res = writeLedgerFile({ outPath: out, sinceIso: '1970-01-01T00:00:00.000Z', ...GEN });
    assert.ok(res.entries >= 2);
    const body = readFileSync(out, 'utf8');
    assert.match(body, /T-7 \(code\) delivered/);
    assert.match(body, /a live note/);
  });
});

describe('maybeRenderLedgerAtTickEnd — best-effort, skip-on-no-new-rows, never throws', () => {
  test('renders on first call with new rows, then skips when no new rows arrive', () => {
    const out = join(scratch, 'LEDGER.md');
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', type: 'code' })];
    const first = maybeRenderLedgerAtTickEnd({ rows, notes: [], outPath: out, ...GEN });
    assert.equal(first, true);
    assert.match(readFileSync(out, 'utf8'), /T-1/);
    // Same rows (no new max id) → skip.
    const second = maybeRenderLedgerAtTickEnd({ rows, notes: [], outPath: out, ...GEN });
    assert.equal(second, false);
  });

  test('re-renders once a new row (higher id) appears', () => {
    const out = join(scratch, 'LEDGER.md');
    const r1 = row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', type: 'code' });
    assert.equal(maybeRenderLedgerAtTickEnd({ rows: [r1], notes: [], outPath: out, ...GEN }), true);
    const r2 = row('2026-06-09T10:05:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-2', type: 'code' });
    assert.equal(maybeRenderLedgerAtTickEnd({ rows: [r1, r2], notes: [], outPath: out, ...GEN }), true);
    assert.match(readFileSync(out, 'utf8'), /T-2/);
  });

  test('swallows a render failure (unwritable path) — returns false, never throws', () => {
    // A directory where the file should be makes rename/write fail; the hook
    // must swallow it and return false rather than propagate.
    const badPath = join(scratch, 'as-a-dir');
    mkdirSync(badPath, { recursive: true });
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', type: 'code' })];
    let threw = false;
    let result = true;
    try {
      result = maybeRenderLedgerAtTickEnd({ rows, notes: [], outPath: badPath, ...GEN });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'hook must never throw');
    assert.equal(result, false);
  });
});

describe('graceful degradation — absent optional tables do not crash a render', () => {
  test('getNotesSince returns [] when the notes table is absent', () => {
    // Point the notes DB at a fresh in-memory connection with no table created
    // by short-circuiting through getNotesSince on an empty DB; it must lazily
    // create + return [] rather than throw.
    _setLedgerDb(new DatabaseSync(':memory:'));
    assert.deepEqual(getNotesSince('2026-01-01T00:00:00.000Z'), []);
  });

  test('a render with only task_outcomes-style payloads (no pipeline/composer tables) works', () => {
    const out = join(scratch, 'LEDGER.md');
    const rows: AuditRow[] = [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', type: 'code' })];
    assert.doesNotThrow(() => writeLedgerFile({ rows, notes: [], outPath: out, ...GEN }));
  });
});
