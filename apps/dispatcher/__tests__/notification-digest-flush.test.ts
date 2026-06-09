import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { config } from '../src/config.js';
import { _setAuditDb } from '../src/audit.js';
import {
  _setDigestDb,
  pendingDigestCount,
  readDigestState,
  writeDigestState,
} from '../src/notification-digest.js';
import {
  _resetSinksForTest,
  _setNotificationsEnabled,
  _setSinksForTest,
  deliver,
} from '../src/notifier.js';
import { maybeFlushDigest } from '../src/notification-digest-flush.js';
import type { CategoryPolicy, NotificationCategory, NyxSettings } from '../src/settings.js';

interface SlackCall {
  text: string;
}

let slackCalls: SlackCall[];
let slackShouldSucceed: boolean;

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

/** A configured schedule (Mon 09–17 UTC) + chosen per-category policies, Slack only. */
function configure(categories: Partial<Record<NotificationCategory, CategoryPolicy>>): void {
  c.settings.notifications.channels.slack = true;
  c.settings.notifications.channels.pushover.enabled = false;
  c.pushoverUserKey = '';
  c.pushoverAppToken = '';
  c.settings.notifications.workflow.schedule.timezone = 'UTC';
  // Reset every day to empty, then set Monday — so the schedule is deterministically configured.
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const) {
    c.settings.notifications.workflow.schedule[day] = { start: '', end: '' };
  }
  c.settings.notifications.workflow.schedule.mon = { ...MON_WINDOW };
  c.settings.notifications.workflow.manualOverride = { active: false, expiresAt: null };
  Object.assign(c.settings.notifications.categories, categories);
}

beforeEach(() => {
  slackCalls = [];
  slackShouldSucceed = true;
  _setNotificationsEnabled(true);
  _setDigestDb(new DatabaseSync(':memory:'));
  _setAuditDb(new DatabaseSync(':memory:'));
  _setSinksForTest({
    slack: async (text) => {
      if (!slackShouldSucceed) return false;
      slackCalls.push({ text });
      return true;
    },
    pushover: async () => false,
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

/**
 * deliver() reads `new Date()` internally for its time-gate. Pin a deterministic
 * `now` by swapping the global Date constructor for the duration of the call.
 * node:test runs serially within a file, so this is safe and self-restoring.
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

describe('maybeFlushDigest — rising-edge state machine', () => {
  test('in-hours: a workflow event sends live; the flush is a no-op, edge marks active', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'live one', IN_HOURS);
    // Sent immediately, nothing batched.
    assert.equal(slackCalls.length, 1);
    assert.equal(pendingDigestCount(), 0);

    // Tick during the working window: active=true, wasActive=false → edge consumed,
    // but there's nothing to flush.
    await maybeFlushDigest(IN_HOURS);
    assert.equal(slackCalls.length, 1, 'no extra send: nothing was batched');
    assert.equal(readDigestState().wasActive, true);
  });

  test('off-hours: a workflow event batches; an off-hours tick does NOT flush', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'late failure', OFF_HOURS);
    assert.equal(slackCalls.length, 0);
    assert.equal(pendingDigestCount(), 1);

    // Tick while still off-hours: not active → no flush, no edge.
    await maybeFlushDigest(OFF_HOURS);
    assert.equal(slackCalls.length, 0);
    assert.equal(pendingDigestCount(), 1);
    assert.equal(readDigestState().wasActive, false);
  });

  test('next-window tick flushes the batch, delivers one summary, and clears + consumes the edge', async () => {
    configure({ failure: 'workflow', status: 'digest' });
    await deliverAt('failure', 'broke overnight', OFF_HOURS);
    await deliverAt('status', 'queue idle', OFF_HOURS);
    assert.equal(pendingDigestCount(), 2);
    assert.equal(slackCalls.length, 0);

    // Working window opens → rising edge → one catch-up summary, batch cleared.
    await maybeFlushDigest(IN_HOURS);
    assert.equal(slackCalls.length, 1, 'exactly one summary message');
    assert.match(slackCalls[0]!.text, /broke overnight/);
    assert.match(slackCalls[0]!.text, /queue idle/);
    assert.equal(pendingDigestCount(), 0);
    assert.equal(readDigestState().wasActive, true);
  });

  test('failed flush does NOT consume the edge: batch + edge survive for next-tick retry', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'must-not-vanish', OFF_HOURS);
    assert.equal(pendingDigestCount(), 1);

    // Rising edge, but the send fails (sink returns false).
    slackShouldSucceed = false;
    await maybeFlushDigest(IN_HOURS);
    // Nothing reached Slack; the batch is intact AND the edge is NOT consumed.
    assert.equal(slackCalls.length, 0);
    assert.equal(pendingDigestCount(), 1, 'failed flush keeps the batch');
    assert.equal(readDigestState().wasActive, false, 'failed flush does NOT consume the rising edge');

    // Next tick (still a rising edge because wasActive is still false): send now
    // succeeds → flush delivers + clears + consumes the edge.
    slackShouldSucceed = true;
    await maybeFlushDigest(IN_HOURS);
    assert.equal(slackCalls.length, 1);
    assert.match(slackCalls[0]!.text, /must-not-vanish/);
    assert.equal(pendingDigestCount(), 0);
    assert.equal(readDigestState().wasActive, true);
  });

  test('falling edge (active → inactive) is recorded without any flush', async () => {
    configure({ failure: 'workflow' });
    writeDigestState({ wasActive: true, lastFlushAt: '2026-06-08T09:00:00.000Z' });

    await maybeFlushDigest(OFF_HOURS);
    assert.equal(slackCalls.length, 0);
    const state = readDigestState();
    assert.equal(state.wasActive, false, 'edge tracker follows the falling edge');
    assert.equal(state.lastFlushAt, '2026-06-08T09:00:00.000Z', 'lastFlushAt preserved on a falling edge');
  });

  test('a long working window does not re-flush every tick (edge already consumed)', async () => {
    configure({ failure: 'workflow' });
    await deliverAt('failure', 'overnight', OFF_HOURS);

    // First in-window tick flushes.
    await maybeFlushDigest(IN_HOURS);
    assert.equal(slackCalls.length, 1);
    assert.equal(readDigestState().wasActive, true);

    // A later in-window tick: active && wasActive → neither branch fires, no send.
    await maybeFlushDigest(new Date('2026-06-08T15:00:00Z'));
    assert.equal(slackCalls.length, 1, 'no re-flush mid-window');
  });

  test('REGRESSION: in the DEFAULT config (empty schedule) action-required is NEVER suppressed', async () => {
    // Use the SHIPPED defaults verbatim — the deployed settings.json has no
    // notifications block and inherits exactly this. action-required is `workflow`
    // and the schedule is empty/unconfigured, so the unsafe behavior would batch
    // urgent halt/gate alerts. The safe behavior delivers them live 24/7.
    Object.assign(c.settings.notifications, JSON.parse(JSON.stringify(orig)));
    c.settings.notifications.channels.slack = true;
    c.settings.notifications.channels.pushover.enabled = false;
    assert.equal(c.settings.notifications.categories['action-required'], 'workflow');

    // Off-hours by wall-clock, but unconfigured schedule ⇒ always reachable.
    await deliverAt('action-required', 'TASK-9 halted — needs you', OFF_HOURS);
    assert.equal(slackCalls.length, 1, 'urgent alert sent live, not batched');
    assert.match(slackCalls[0]!.text, /TASK-9 halted/);
    assert.equal(pendingDigestCount(), 0, 'urgent alert was NEVER batched in the default config');

    // And a flush tick has nothing to do — the batch was never populated.
    await maybeFlushDigest(OFF_HOURS);
    assert.equal(slackCalls.length, 1);
  });
});
