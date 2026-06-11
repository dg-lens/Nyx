import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, readAuditRowsSince, type AuditEvent, type AuditRow } from '../src/audit.js';
import {
  narrativeFor,
  projectRows,
  renderMarkdown,
  writeLedger,
  type LedgerEntry,
} from '../src/ledger.js';

let scratch: string;

beforeEach(() => {
  _setAuditDb(new DatabaseSync(':memory:'));
  scratch = mkdtempSync(join(tmpdir(), 'ledger-test-'));
});

afterEach(() => {
  _setAuditDb(null);
  rmSync(scratch, { recursive: true, force: true });
});

function row(at: string, event: AuditEvent, actor: string, payload: Record<string, unknown>): AuditRow {
  return {
    id: Number.parseInt(at.replace(/[^0-9]/g, '').slice(8, 14), 10) || 1,
    at,
    event,
    actor,
    payload: JSON.stringify(payload),
    row_hash: 'x',
    prev_hash: 'x',
  };
}

describe('narrativeFor — projects audit events to readable lines', () => {
  test('task lifecycle events name the task and meaningful payload fields', () => {
    assert.match(
      narrativeFor('task.started', { taskId: 'T-1', type: 'code', model: 'sonnet' }),
      /started T-1 \(code, sonnet\)/,
    );
    assert.match(
      narrativeFor('task.completed', { taskId: 'T-1', durationMs: 90_000, prUrl: 'https://gh/pr/9' }),
      /completed T-1 in 1\.5m → https:\/\/gh\/pr\/9/,
    );
    assert.match(
      narrativeFor('task.failed', { taskId: 'T-1', stage: 'preflight', failure_log: 'missing env var FOO' }),
      /failed T-1 at preflight — missing env var FOO/,
    );
    assert.match(narrativeFor('task.merged', { taskId: 'T-1', branch: 'nyx/T-1' }), /merged T-1 \(branch nyx\/T-1\)/);
    assert.match(
      narrativeFor('task.pr.created', { taskId: 'T-1', prUrl: 'https://gh/pr/9' }),
      /opened PR T-1 → https:\/\/gh\/pr\/9/,
    );
    assert.match(
      narrativeFor('task.pushed', { taskId: 'T-1', mode: 'direct', repo: 'dg-lens/Nyx', branchUrl: 'https://gh/x' }),
      /pushed T-1 \(direct → dg-lens\/Nyx\) → https:\/\/gh\/x/,
    );
  });

  test('skip variants carry the kind in the parenthetical', () => {
    assert.match(narrativeFor('task.skipped.git_busy', { taskId: 'T-1' }), /skipped T-1 \(git_busy\)/);
    assert.match(narrativeFor('task.skipped.rate_limited', { taskId: 'T-1' }), /skipped T-1 \(rate_limited\)/);
  });

  test('pipeline events keep the pipeline taskId and stage tag', () => {
    assert.match(narrativeFor('pipeline.run.started', { taskId: 'P-1' }), /pipeline run started P-1/);
    assert.match(
      narrativeFor('pipeline.stage.advanced', { taskId: 'P-1', to: 'executing' }),
      /pipeline stage advanced P-1 → executing/,
    );
    assert.match(narrativeFor('pipeline.delivered', { taskId: 'P-1' }), /pipeline delivered P-1/);
  });

  test('rollup events still get a label so the per-day summary stays informative', () => {
    assert.equal(narrativeFor('dispatch.tick', {}), 'dispatch.tick');
    assert.equal(narrativeFor('dispatch.idle', {}), 'dispatch.idle');
  });

  test('unknown event types fall back to "<event> <taskId?>" — no row vanishes', () => {
    assert.equal(
      narrativeFor('not.a.real.event' as AuditEvent, { taskId: 'T-1' }),
      'not.a.real.event T-1',
    );
    assert.equal(narrativeFor('not.a.real.event' as AuditEvent, {}), 'not.a.real.event');
  });
});

describe('projectRows — preserves chain order and tags rollup events', () => {
  test('one entry per row, day/time split off the ISO timestamp', () => {
    const rows: AuditRow[] = [
      row('2026-06-09T13:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-1', type: 'code', model: 'sonnet' }),
      row('2026-06-09T13:05:30.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', durationMs: 30_000 }),
    ];
    const entries = projectRows(rows);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.day, '2026-06-09');
    assert.equal(entries[0]!.time, '13:00:00');
    assert.equal(entries[0]!.actor, 'dispatcher');
    assert.equal(entries[0]!.rollup, false);
    assert.match(entries[1]!.narrative, /completed T-1/);
  });

  test('housekeeping events are flagged for rollup, meaningful ones are not', () => {
    const rows: AuditRow[] = [
      row('2026-06-09T01:00:00.000Z', 'dispatch.tick', 'dispatcher', {}),
      row('2026-06-09T01:05:00.000Z', 'dispatch.idle', 'dispatcher', {}),
      row('2026-06-09T01:10:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1' }),
    ];
    const entries = projectRows(rows);
    assert.deepEqual(
      entries.map((e) => [e.event, e.rollup]),
      [
        ['dispatch.tick', true],
        ['dispatch.idle', true],
        ['task.completed', false],
      ],
    );
  });

  test('malformed payload JSON does not crash the projector', () => {
    const bad: AuditRow = {
      id: 1,
      at: '2026-06-09T12:00:00.000Z',
      event: 'task.completed',
      actor: 'dispatcher',
      payload: '{not json',
      row_hash: 'x',
      prev_hash: 'x',
    };
    const entries = projectRows([bad]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.narrative, 'completed');
  });
});

describe('renderMarkdown — narrative doc structure', () => {
  test('empty input still produces a valid header doc with placeholder', () => {
    const md = renderMarkdown([], { systemName: 'Nyx', generatedAt: new Date('2026-06-10T12:00:00Z') });
    assert.match(md, /^# Nyx — Activity Ledger\n/);
    assert.match(md, /Generated 2026-06-10T12:00:00\.000Z/);
    assert.match(md, /No activity in window/);
  });

  test('groups by day, newest day first, with actor + time on each line', () => {
    const entries: LedgerEntry[] = projectRows([
      row('2026-06-08T09:00:00.000Z', 'task.started', 'dispatcher', { taskId: 'T-1', type: 'code', model: 'sonnet' }),
      row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', durationMs: 60_000 }),
      row('2026-06-09T11:00:00.000Z', 'task.pr.created', 'dispatcher', { taskId: 'T-1', prUrl: 'https://gh/pr/9' }),
    ]);
    const md = renderMarkdown(entries, { systemName: 'Nyx', generatedAt: new Date('2026-06-10T12:00:00Z') });
    const jun9 = md.indexOf('## 2026-06-09');
    const jun8 = md.indexOf('## 2026-06-08');
    assert.ok(jun9 > 0 && jun8 > 0, 'both day sections present');
    assert.ok(jun9 < jun8, 'newest day appears first');
    assert.match(md, /- `10:00:00` \*\*\[dispatcher\]\*\* completed T-1/);
    assert.match(md, /3 rows/);
  });

  test('per-day rollup summarises housekeeping events as one line', () => {
    const entries = projectRows([
      row('2026-06-09T00:00:00.000Z', 'dispatch.tick', 'dispatcher', {}),
      row('2026-06-09T00:05:00.000Z', 'dispatch.tick', 'dispatcher', {}),
      row('2026-06-09T00:10:00.000Z', 'dispatch.idle', 'dispatcher', {}),
      row('2026-06-09T00:15:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1' }),
    ]);
    const md = renderMarkdown(entries, { systemName: 'Nyx', generatedAt: new Date('2026-06-10T12:00:00Z') });
    assert.match(md, /completed T-1/);
    assert.match(md, /_rollup:_ 2 tick, 1 idle/);
  });

  test('actor tag is preserved verbatim — federation hook for hub-side rollup', () => {
    const entries = projectRows([
      row('2026-06-09T10:00:00.000Z', 'task.completed', 'mcp-resilience', { taskId: 'T-1' }),
      row('2026-06-09T10:01:00.000Z', 'composer.run.completed', 'composer.runner', { taskId: 'T-1' }),
    ]);
    const md = renderMarkdown(entries, { systemName: 'Nyx', generatedAt: new Date('2026-06-10T12:00:00Z') });
    assert.match(md, /\*\*\[mcp-resilience\]\*\*/);
    assert.match(md, /\*\*\[composer\.runner\]\*\*/);
  });
});

describe('writeLedger — atomic write + reads pre-fetched rows', () => {
  test('writes to the requested outPath and returns byte count', () => {
    const out = join(scratch, 'LEDGER.md');
    const rows: AuditRow[] = [
      row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1', durationMs: 30_000 }),
    ];
    const res = writeLedger({
      rows,
      outPath: out,
      systemName: 'Nyx',
      generatedAt: new Date('2026-06-10T12:00:00Z'),
    });
    assert.equal(res.path, out);
    assert.equal(res.entries, 1);
    const body = readFileSync(out, 'utf8');
    assert.equal(Buffer.byteLength(body, 'utf8'), res.bytes);
    assert.match(body, /completed T-1/);
  });

  test('creates parent directories if missing', () => {
    const out = join(scratch, 'nested', 'dir', 'LEDGER.md');
    writeLedger({
      rows: [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1' })],
      outPath: out,
      systemName: 'Nyx',
      generatedAt: new Date('2026-06-10T12:00:00Z'),
    });
    assert.match(readFileSync(out, 'utf8'), /completed T-1/);
  });

  test('overwrites existing file in place — re-render is idempotent', () => {
    const out = join(scratch, 'LEDGER.md');
    writeFileSync(out, 'stale\n', 'utf8');
    writeLedger({
      rows: [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-2' })],
      outPath: out,
      systemName: 'Nyx',
      generatedAt: new Date('2026-06-10T12:00:00Z'),
    });
    const body = readFileSync(out, 'utf8');
    assert.doesNotMatch(body, /stale/);
    assert.match(body, /completed T-2/);
  });

  test('reads from the audit chain when rows are not supplied', () => {
    audit('task.started', 'dispatcher', { taskId: 'T-7', type: 'code', model: 'sonnet' });
    audit('task.completed', 'dispatcher', { taskId: 'T-7', durationMs: 1_000 });
    const all = readAuditRowsSince('1970-01-01T00:00:00Z');
    assert.equal(all.length, 2);
    const out = join(scratch, 'LEDGER.md');
    const res = writeLedger({
      outPath: out,
      sinceIso: '1970-01-01T00:00:00Z',
      systemName: 'Nyx',
      generatedAt: new Date('2026-06-10T12:00:00Z'),
    });
    assert.equal(res.entries, 2);
    const body = readFileSync(out, 'utf8');
    assert.match(body, /started T-7/);
    assert.match(body, /completed T-7/);
  });

  test('no .tmp files are left behind on a successful write', () => {
    const out = join(scratch, 'LEDGER.md');
    mkdirSync(scratch, { recursive: true });
    writeLedger({
      rows: [row('2026-06-09T10:00:00.000Z', 'task.completed', 'dispatcher', { taskId: 'T-1' })],
      outPath: out,
      systemName: 'Nyx',
      generatedAt: new Date('2026-06-10T12:00:00Z'),
    });
    const leftovers = readdirSync(scratch).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });
});
