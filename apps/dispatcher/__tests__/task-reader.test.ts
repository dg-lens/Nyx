import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  markTaskCompleted,
  parseEveryStep,
  pickNextTask,
  readQueue,
  slotOf,
  slotWindow,
  tasksWithInvalidTags,
} from '../src/task-reader.js';

let tmpDir: string;
let queuePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-test-'));
  queuePath = resolve(tmpDir, 'nyx.md');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(content: string): void {
  writeFileSync(queuePath, content, 'utf8');
}

function read(): string {
  return readFileSync(queuePath, 'utf8');
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

// ─── markTaskCompleted (standing-task path) ─────────────────────────────────

describe('markTaskCompleted', () => {
  test('moves a single task to Completed exactly once', () => {
    write(
      `# Queue\n\n## Active Tasks\n\n- [ ] FOO-BAR — Do the thing\n      [type: code] [gate: none] [model: sonnet]\n\n## Completed\n\n`,
    );
    markTaskCompleted(queuePath, 'FOO-BAR', { durationMs: 60_000 });
    const after = read();
    assert.equal(countOccurrences(after, 'FOO-BAR — Do the thing'), 1);
    assert.ok(after.includes('- [x] FOO-BAR'));
    assert.ok(after.indexOf('## Completed') < after.indexOf('FOO-BAR'));
  });

  test('creates Completed section when missing', () => {
    write(`# Queue\n\n## Active Tasks\n\n- [ ] LONE-TASK — Solo work\n      [type: code] [gate: none]\n`);
    markTaskCompleted(queuePath, 'LONE-TASK', { durationMs: 30_000 });
    const after = read();
    assert.ok(after.includes('## Completed'));
    assert.equal(countOccurrences(after, 'LONE-TASK — Solo work'), 1);
    assert.ok(after.includes('- [x] LONE-TASK'));
  });

  test('handles task block at end of file (no trailing newline)', () => {
    write(`## Active Tasks\n\n- [ ] EOF-TASK — Last thing\n      [type: assistant] [gate: none]`);
    markTaskCompleted(queuePath, 'EOF-TASK', { durationMs: 5_000 });
    const after = read();
    assert.equal(countOccurrences(after, 'EOF-TASK'), 1);
    assert.ok(after.includes('- [x] EOF-TASK'));
    assert.ok(after.includes('## Completed'));
  });

  test('abandoned task gets [FAILED] prefix and is checked', () => {
    write(`## Active Tasks\n\n- [ ] BAD-TASK — Will never work\n      [type: code] [gate: none]\n\n## Completed\n`);
    markTaskCompleted(queuePath, 'BAD-TASK', { durationMs: 0, failed: true });
    const after = read();
    assert.ok(after.includes('- [x] BAD-TASK'));
    assert.ok(after.includes('[FAILED] Will never work'));
    assert.equal(countOccurrences(after, 'BAD-TASK'), 1);
  });

  test('abandoned task line is re-parseable and not picked', () => {
    write(`## Active Tasks\n\n- [ ] DOOMED — Bound to fail\n      [type: code] [gate: none]\n\n## Completed\n`);
    markTaskCompleted(queuePath, 'DOOMED', { durationMs: 0, failed: true });
    const q = readQueue(queuePath);
    const allIds = [...q.active, ...q.completed].map(t => t.id);
    assert.ok(allIds.includes('DOOMED'));
    assert.equal(pickNextTask(q), null);
  });

  test('idempotent: second call against missing-from-Active task is a no-op', () => {
    write(`## Active Tasks\n\n- [ ] ONCE — once only\n      [type: assistant] [gate: none]\n\n## Completed\n`);
    markTaskCompleted(queuePath, 'ONCE', { durationMs: 1_000 });
    markTaskCompleted(queuePath, 'ONCE', { durationMs: 1_000 });
    const after = read();
    assert.equal(countOccurrences(after, 'ONCE — once only'), 1);
  });

  test('respects Completed section that comes before Active', () => {
    write(
      `# Queue\n\n## Completed\n\n- [x] OLD-TASK — historical\n\n## Active Tasks\n\n- [ ] NEW-TASK — fresh work\n      [type: code] [gate: none]\n`,
    );
    markTaskCompleted(queuePath, 'NEW-TASK', { durationMs: 12_000 });
    const after = read();
    assert.equal(countOccurrences(after, 'NEW-TASK — fresh work'), 1);
    assert.equal(countOccurrences(after, 'OLD-TASK — historical'), 1);
    const newIdx = after.indexOf('NEW-TASK');
    const completedIdx = after.indexOf('## Completed');
    const activeIdx = after.indexOf('## Active Tasks');
    assert.ok(newIdx > completedIdx);
    assert.ok(newIdx < activeIdx);
  });
});

// ─── Slot math ──────────────────────────────────────────────────────────────

describe('slotOf', () => {
  test('00:00 → 0, 00:05 → 1, 23:55 → 287', () => {
    const make = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return d;
    };
    assert.equal(slotOf(make(0, 0)), 0);
    assert.equal(slotOf(make(0, 4)), 0);
    assert.equal(slotOf(make(0, 5)), 1);
    assert.equal(slotOf(make(0, 15)), 3);
    assert.equal(slotOf(make(6, 0)), 72);
    assert.equal(slotOf(make(12, 0)), 144);
    assert.equal(slotOf(make(23, 55)), 287);
    assert.equal(slotOf(make(23, 59)), 287);
  });
});

describe('slotWindow', () => {
  test('returns 5-minute window for the current slot', () => {
    const d = new Date();
    d.setHours(7, 23, 0, 0); // slot 88 = 07:20
    const w = slotWindow(d);
    assert.equal(w.slot, 88);
    assert.equal(w.start.getHours(), 7);
    assert.equal(w.start.getMinutes(), 20);
    assert.equal(w.end.getHours(), 7);
    assert.equal(w.end.getMinutes(), 25);
  });
});

// ─── every: parsing ─────────────────────────────────────────────────────────

describe('parseEveryStep', () => {
  test('accepts valid forms', () => {
    assert.equal(parseEveryStep('5m'), 1);
    assert.equal(parseEveryStep('15m'), 3);
    assert.equal(parseEveryStep('30m'), 6);
    assert.equal(parseEveryStep('1h'), 12);
    assert.equal(parseEveryStep('3h'), 36);
    assert.equal(parseEveryStep('12h'), 144);
    assert.equal(parseEveryStep('1d'), 288);
    assert.equal(parseEveryStep('2d'), 576);
  });

  test('rejects sub-5m and non-multiples-of-5', () => {
    assert.equal(parseEveryStep('3m'), null);
    assert.equal(parseEveryStep('7m'), null);
    assert.equal(parseEveryStep('0h'), null);
    assert.equal(parseEveryStep('foo'), null);
    assert.equal(parseEveryStep(''), null);
  });
});

// ─── Picker: slot/every/standing ────────────────────────────────────────────

function atSlot(slot: number): Date {
  const d = new Date();
  d.setHours(Math.floor(slot / 12), (slot % 12) * 5, 0, 0);
  return d;
}

describe('pickNextTask (slot model)', () => {
  test('picks a task bound to the current slot', () => {
    write(
      `## Active Tasks\n\n- [ ] DAILY-A — slot 24\n      [type: assistant] [gate: none] [slot: 24]\n- [ ] DAILY-B — slot 28\n      [type: assistant] [gate: none] [slot: 28]\n`,
    );
    const q = readQueue(queuePath);
    assert.equal(pickNextTask(q, { now: atSlot(24) })?.id, 'DAILY-A');
    assert.equal(pickNextTask(q, { now: atSlot(28) })?.id, 'DAILY-B');
    assert.equal(pickNextTask(q, { now: atSlot(25) }), null, 'no slotted task bound to slot 25');
  });

  test('picks every:3h tasks at slots 0, 36, 72, …', () => {
    write(
      `## Active Tasks\n\n- [ ] CADENCE — every 3h\n      [type: assistant] [gate: none] [every: 3h]\n`,
    );
    const q = readQueue(queuePath);
    for (const slot of [0, 36, 72, 108, 144, 180, 216, 252]) {
      assert.equal(pickNextTask(q, { now: atSlot(slot) })?.id, 'CADENCE', `expected fire at slot ${slot}`);
    }
    for (const slot of [1, 18, 35, 37, 100, 287]) {
      assert.equal(pickNextTask(q, { now: atSlot(slot) }), null, `must not fire at slot ${slot}`);
    }
  });

  test('falls back to standing list when no slotted task matches', () => {
    write(
      `## Active Tasks\n\n- [ ] STANDING-1 — write task no schedule\n      [type: code] [gate: none]\n- [ ] DAILY-X — slot 24\n      [type: assistant] [gate: none] [slot: 24]\n`,
    );
    const q = readQueue(queuePath);
    // At slot 24 the slotted one wins.
    assert.equal(pickNextTask(q, { now: atSlot(24) })?.id, 'DAILY-X');
    // At any other slot the standing one is pulled.
    assert.equal(pickNextTask(q, { now: atSlot(1) })?.id, 'STANDING-1');
    assert.equal(pickNextTask(q, { now: atSlot(50) })?.id, 'STANDING-1');
  });

  test('skips slotted task already fired in this window (via firedInSlot set)', () => {
    write(
      `## Active Tasks\n\n- [ ] DAILY-A — slot 24\n      [type: assistant] [gate: none] [slot: 24]\n- [ ] STANDING-1 — fallback\n      [type: code] [gate: none]\n`,
    );
    const q = readQueue(queuePath);
    const fired = new Set(['DAILY-A']);
    // Slot 24 task already ran this window → fall back to standing.
    assert.equal(pickNextTask(q, { now: atSlot(24), firedInSlot: fired })?.id, 'STANDING-1');
  });

  test('rejects mutually-exclusive slot+every combination', () => {
    write(
      `## Active Tasks\n\n- [ ] BOTH — conflict\n      [type: assistant] [gate: none] [slot: 24] [every: 3h]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'BOTH');
    assert.ok(t);
    assert.ok(t.invalidTags.some(x => x.tag === 'slot+every'));
    assert.equal(pickNextTask(q, { now: atSlot(24) }), null);
  });

  test('legacy [recurring:] or [at:] tags get flagged as invalid', () => {
    write(
      `## Active Tasks\n\n- [ ] OLD-STYLE — legacy\n      [type: assistant] [gate: none] [recurring: daily 07:00]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'OLD-STYLE');
    assert.ok(t?.invalidTags.some(x => x.tag === 'recurring'));
    assert.equal(pickNextTask(q, { now: atSlot(28) }), null);
  });

  test('respects depends — standing task waits for dependency', () => {
    write(
      `## Active Tasks\n\n- [ ] STEP-A — first\n      [type: code] [gate: none]\n- [ ] STEP-B — second\n      [type: code] [gate: none] [depends: STEP-A]\n`,
    );
    let q = readQueue(queuePath);
    assert.equal(pickNextTask(q, { now: atSlot(50) })?.id, 'STEP-A');
    markTaskCompleted(queuePath, 'STEP-A', { durationMs: 1_000 });
    q = readQueue(queuePath);
    assert.equal(pickNextTask(q, { now: atSlot(50) })?.id, 'STEP-B');
  });

  test('high priority jumps within standing list', () => {
    write(
      `## Active Tasks\n\n- [ ] FIRST-IN-FILE — normal\n      [type: code] [gate: none]\n- [ ] URGENT — high priority\n      [type: code] [gate: none] [priority: high]\n`,
    );
    const q = readQueue(queuePath);
    assert.equal(pickNextTask(q, { now: atSlot(50) })?.id, 'URGENT');
  });

  test('skipThisTick keeps the same task from being re-picked', () => {
    write(
      `## Active Tasks\n\n- [ ] ONE — task one\n      [type: code] [gate: none]\n- [ ] TWO — task two\n      [type: code] [gate: none]\n`,
    );
    const q = readQueue(queuePath);
    assert.equal(pickNextTask(q, { now: atSlot(50), skipThisTick: new Set(['ONE']) })?.id, 'TWO');
  });

  test('v0.7: parses [env:] tag into envVars[]', () => {
    write(
      `## Active Tasks\n\n- [ ] TEST-T — task\n      [type: code] [gate: none] [env: SUPABASE_DB_URL, NEXT_PUBLIC_SUPABASE_URL]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'TEST-T');
    assert.deepEqual(t?.envVars, ['SUPABASE_DB_URL', 'NEXT_PUBLIC_SUPABASE_URL']);
  });

  test('v0.7: parses [expects:] tag into expects[]', () => {
    write(
      `## Active Tasks\n\n- [ ] TEST-T — task\n      [type: code] [gate: none] [expects: migrations/0003_x.sql, src/admin/page.tsx]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'TEST-T');
    assert.deepEqual(t?.expects, ['migrations/0003_x.sql', 'src/admin/page.tsx']);
  });

  test('v0.7: missing [env:] / [expects:] tags leave fields undefined', () => {
    write(
      `## Active Tasks\n\n- [ ] TEST-T — task\n      [type: code] [gate: none]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'TEST-T');
    assert.equal(t?.envVars, undefined);
    assert.equal(t?.expects, undefined);
  });

  test('v0.12: parses [reading:] tag into reading[]', () => {
    write(
      `## Active Tasks\n\n- [ ] TEST-T — task\n      [type: code] [gate: none] [reading: T1 §3.1, T4 some-slug]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'TEST-T');
    assert.deepEqual(t?.reading, ['T1 §3.1', 'T4 some-slug']);
  });

  test('v0.12: absent [reading:] tag leaves reading undefined', () => {
    write(
      `## Active Tasks\n\n- [ ] TEST-T — task\n      [type: code] [gate: none]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'TEST-T');
    assert.equal(t?.reading, undefined);
  });
});

describe('[repo:] validation (C2 command-injection guard)', () => {
  test('a repo with shell metacharacters is flagged invalid and never picked', () => {
    const evil = 'a";echo INJECTED > /tmp/marker;"b';
    write(
      `## Active Tasks\n\n- [ ] EVIL-1 — clone a repo\n      [type: code] [repo: ${evil}]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'EVIL-1');
    assert.ok(t, 'task parsed');
    assert.ok(
      t!.invalidTags.some(it => it.tag === 'repo'),
      'repo flagged as invalidTag',
    );
    // The decisive guarantee: a task carrying an injection payload is never
    // returned by the picker, so it never reaches git clone.
    assert.equal(pickNextTask(q), null);
    assert.ok(tasksWithInvalidTags(q).some(x => x.id === 'EVIL-1'));
  });

  test('a valid owner/name repo is accepted and picked', () => {
    write(
      `## Active Tasks\n\n- [ ] GOOD-1 — fix a bug\n      [type: code] [repo: lens-cx/employee-portal] [gate: none]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'GOOD-1');
    assert.equal(t?.repo, 'lens-cx/employee-portal');
    assert.equal(t!.invalidTags.length, 0);
    assert.equal(pickNextTask(q)?.id, 'GOOD-1');
  });

  test('a greenfield keyword repo is accepted', () => {
    write(
      `## Active Tasks\n\n- [ ] GREEN-1 — build a snake game\n      [type: pipeline] [repo: local]\n`,
    );
    const q = readQueue(queuePath);
    const t = q.active.find(x => x.id === 'GREEN-1');
    assert.equal(t?.repo, 'local');
    assert.equal(t!.invalidTags.length, 0);
  });
});
