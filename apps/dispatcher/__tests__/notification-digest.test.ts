import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { config } from '../src/config.js';
import { _setAuditDb } from '../src/audit.js';
import {
  _setDigestDb,
  batchDigestItem,
  clearDigestBatch,
  formatDigest,
  pendingDigestCount,
  pendingDigestItems,
  readDigestState,
  writeDigestState,
} from '../src/notification-digest.js';
import {
  _resetSinksForTest,
  _setNotificationsEnabled,
  _setSinksForTest,
  deliver,
  flushDigest,
} from '../src/notifier.js';
import type { CategoryPolicy, NotificationCategory, NyxSettings } from '../src/settings.js';

interface SlackCall {
  text: string;
}
interface PushoverCall {
  category: NotificationCategory;
  text: string;
}

let slackCalls: SlackCall[];
let pushoverCalls: PushoverCall[];

type MutableConfig = {
  settings: NyxSettings;
  pushoverUserKey: string;
  pushoverAppToken: string;
};
const c = config as unknown as MutableConfig;

const orig = JSON.parse(JSON.stringify(config.settings.notifications)) as NyxSettings['notifications'];
const origUserKey = config.pushoverUserKey;
const origAppToken = config.pushoverAppToken;

// 2026-06-08 is a Monday. A 09:00–17:00 UTC Mon window: 14:00 is inside, 03:00 is off-hours.
const MON_WINDOW = { start: '09:00', end: '17:00' };
const IN_HOURS = new Date('2026-06-08T14:00:00Z');
const OFF_HOURS = new Date('2026-06-08T03:00:00Z');

/** Configure both channels on + a Mon 09–17 schedule, with per-category policy overrides. */
function configure(categories: Partial<Record<NotificationCategory, CategoryPolicy>>): void {
  c.settings.notifications.channels.slack = true;
  c.settings.notifications.channels.pushover.enabled = true;
  c.pushoverUserKey = 'u-test';
  c.pushoverAppToken = 't-test';
  c.settings.notifications.workflow.schedule.timezone = 'UTC';
  c.settings.notifications.workflow.schedule.mon = { ...MON_WINDOW };
  c.settings.notifications.workflow.manualOverride = { active: false, expiresAt: null };
  Object.assign(c.settings.notifications.categories, categories);
}

beforeEach(() => {
  slackCalls = [];
  pushoverCalls = [];
  _setNotificationsEnabled(true);
  _setDigestDb(new DatabaseSync(':memory:'));
  _setAuditDb(new DatabaseSync(':memory:'));
  _setSinksForTest({
    slack: async (text) => {
      slackCalls.push({ text });
      return true;
    },
    pushover: async (category, text) => {
      pushoverCalls.push({ category, text });
      return true;
    },
  });
});

afterEach(() => {
  _resetSinksForTest();
  _setNotificationsEnabled(true);
  _setDigestDb(null);
  _setAuditDb(null);
  Object.assign(c.settings.notifications, JSON.parse(JSON.stringify(orig)));
  c.pushoverUserKey = origUserKey;
  c.pushoverAppToken = origAppToken;
});

// ─── store primitives ──────────────────────────────────────────────────────────

describe('notification_digest store', () => {
  test('batch then list preserves order + fields; clear empties', () => {
    batchDigestItem('failure', 'first');
    batchDigestItem('status', 'second');
    const items = pendingDigestItems();
    assert.equal(items.length, 2);
    assert.equal(items[0]!.text, 'first');
    assert.equal(items[0]!.category, 'failure');
    assert.equal(items[1]!.text, 'second');
    assert.equal(pendingDigestCount(), 2);
    clearDigestBatch();
    assert.equal(pendingDigestCount(), 0);
  });

  test('state round-trips (rising-edge tracker)', () => {
    assert.deepEqual(readDigestState(), { wasActive: false, lastFlushAt: null });
    writeDigestState({ wasActive: true, lastFlushAt: '2026-06-08T09:00:00.000Z' });
    assert.deepEqual(readDigestState(), { wasActive: true, lastFlushAt: '2026-06-08T09:00:00.000Z' });
  });
});

describe('formatDigest — grouped summary', () => {
  test('groups by category in urgency order with counts', () => {
    const summary = formatDigest(
      [
        { id: 1, at: '', category: 'status', text: 'queue idle' },
        { id: 2, at: '', category: 'failure', text: 'T-1 failed' },
        { id: 3, at: '', category: 'failure', text: 'T-2 failed' },
      ],
      'Nyx',
    );
    assert.match(summary, /what you missed/);
    assert.match(summary, /3 items/);
    // failure group precedes status group (urgency order).
    assert.ok(summary.indexOf('Failures') < summary.indexOf('Status'));
    assert.match(summary, /T-1 failed/);
    assert.match(summary, /queue idle/);
  });
});

// ─── deliver() live gate ─────────────────────────────────────────────────────────

describe('deliver — live Workflow gate (N4)', () => {
  test('in-hours: a workflow-category event sends live, batches nothing', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'oops', IN_HOURS);
    assert.equal(slackCalls.length, 1);
    assert.equal(pushoverCalls.length, 1);
    assert.equal(pendingDigestCount(), 0);
  });

  test('off-hours: a workflow-category event batches, sends nothing live', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'oops-late', OFF_HOURS);
    assert.equal(slackCalls.length, 0);
    assert.equal(pushoverCalls.length, 0);
    assert.equal(pendingDigestCount(), 1);
    assert.equal(pendingDigestItems()[0]!.text, 'oops-late');
  });

  test('digest-category event batches even in-hours (never interrupts)', async () => {
    configure({ status: 'digest' });
    await deliverAt('status', 'queue idle', IN_HOURS);
    assert.equal(slackCalls.length, 0);
    assert.equal(pendingDigestCount(), 1);
  });

  test('always-category event sends live regardless of hours, never batches', async () => {
    configure({ 'action-required': 'always' });
    await deliverAt('action-required', 'urgent', OFF_HOURS);
    assert.equal(slackCalls.length, 1);
    assert.equal(pendingDigestCount(), 0);
  });

  test('off-category event is dropped, not batched (real opt-out)', async () => {
    configure({ delivery: 'off' });
    await deliverAt('delivery', 'shipped', IN_HOURS);
    assert.equal(slackCalls.length, 0);
    assert.equal(pendingDigestCount(), 0);
  });

  test('off-hours override armed: workflow event sends live, no batch', async () => {
    configure({ failure: 'workflow' });
    c.settings.notifications.workflow.manualOverride = { active: true, expiresAt: null };
    await deliverAt('failure', 'late-night', OFF_HOURS);
    assert.equal(slackCalls.length, 1);
    assert.equal(pendingDigestCount(), 0);
  });
});

// ─── flushDigest() ───────────────────────────────────────────────────────────────

describe('flushDigest — next-window catch-up', () => {
  test('sends one summary covering all batched items, then clears', async () => {
    configure({ failure: 'workflow', status: 'digest' });
    await deliverAt('failure', 'T-1 failed', OFF_HOURS);
    await deliverAt('status', 'queue idle', OFF_HOURS);
    assert.equal(pendingDigestCount(), 2);

    const n = await flushDigest();
    assert.equal(n, 2);
    // ONE summary message, not two — the whole point of the digest.
    assert.equal(slackCalls.length, 1);
    assert.equal(pushoverCalls.length, 1);
    assert.match(slackCalls[0]!.text, /T-1 failed/);
    assert.match(slackCalls[0]!.text, /queue idle/);
    // Batch cleared after a successful flush.
    assert.equal(pendingDigestCount(), 0);
  });

  test('empty batch → no-op (no message)', async () => {
    configure({});
    const n = await flushDigest();
    assert.equal(n, 0);
    assert.equal(slackCalls.length, 0);
  });

  test('failed send leaves the batch intact for the next retry', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'keep-me', OFF_HOURS);
    // Both sinks fail → not reached → batch must NOT be cleared.
    _setSinksForTest({
      slack: async () => false,
      pushover: async () => false,
    });
    const n = await flushDigest();
    assert.equal(n, 0);
    assert.equal(pendingDigestCount(), 1);
  });

  test('end-to-end: off-hours batch, then in-window flush delivers + clears', async () => {
    configure({ failure: 'workflow', delivery: 'workflow', status: 'digest' });
    // While away: three suppressed events of mixed category.
    await deliverAt('failure', 'build broke', OFF_HOURS);
    await deliverAt('delivery', 'PR opened', OFF_HOURS);
    await deliverAt('status', 'tick idle', OFF_HOURS);
    assert.equal(slackCalls.length, 0, 'nothing sent live off-hours');
    assert.equal(pendingDigestCount(), 3);

    // Working window opens → operator gets a single catch-up.
    const n = await flushDigest();
    assert.equal(n, 3);
    assert.equal(slackCalls.length, 1);
    assert.equal(pendingDigestCount(), 0);

    // A live event in-hours now goes straight through, no batching.
    await deliverAt('failure', 'fresh failure', IN_HOURS);
    assert.equal(slackCalls.length, 2);
    assert.equal(pendingDigestCount(), 0);
  });
});

/**
 * deliver() reads `new Date()` internally for the time-gate. To pin a deterministic
 * `now`, swap the global Date constructor for the duration of the call. node:test
 * runs serially within a file, so this is safe and self-restoring.
 */
async function deliverAt(category: NotificationCategory, text: string, now: Date): Promise<void> {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof RealDate>) {
      if (args.length === 0) super(now.getTime());
      else super(...args);
    }
    static override now(): number {
      return now.getTime();
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    await deliver(category, text);
  } finally {
    globalThis.Date = RealDate;
  }
}
