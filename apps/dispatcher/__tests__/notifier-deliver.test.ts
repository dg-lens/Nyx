import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { config } from '../src/config.js';
import { _setDigestDb } from '../src/notification-digest.js';
import { _setAuditDb } from '../src/audit.js';
import {
  _resetSinksForTest,
  _setNotificationsEnabled,
  _setSinksForTest,
  deliver,
  taskHalted,
  taskFailed,
  pipelineDelivered,
  taskDispatched,
} from '../src/notifier.js';
import type { CategoryPolicy, NotificationCategory } from '../src/settings.js';

interface SlackCall {
  text: string;
}
interface PushoverCall {
  category: NotificationCategory;
  text: string;
}

let slackCalls: SlackCall[];
let pushoverCalls: PushoverCall[];
let auditDb: DatabaseSync;

function undeliveredRows(): Array<{ payload: string }> {
  // The audit table is created lazily on the first audit() write; a deliver()
  // that reached a sink never writes, so the table may not exist yet — that is a
  // legitimate "zero undelivered events", not an error.
  const exists = auditDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_audit'`)
    .get();
  if (!exists) return [];
  return auditDb
    .prepare(`SELECT payload FROM system_audit WHERE event = 'notification.undelivered' ORDER BY id ASC`)
    .all() as Array<{ payload: string }>;
}

function setChannels(slack: boolean, pushover: boolean): void {
  const c = config as unknown as {
    settings: { notifications: { channels: { slack: boolean; pushover: { enabled: boolean } }; categories: Record<NotificationCategory, CategoryPolicy> } };
    pushoverUserKey: string;
    pushoverAppToken: string;
  };
  c.settings.notifications.channels.slack = slack;
  c.settings.notifications.channels.pushover.enabled = pushover;
  // Pushover also requires creds present to be considered enabled.
  c.pushoverUserKey = pushover ? 'u-test' : '';
  c.pushoverAppToken = pushover ? 't-test' : '';
  // These tests assert CHANNEL fan-out, not the Workflow time-gate — force every
  // category to `always` so deliver() always sends live and never batches.
  for (const cat of ['action-required', 'failure', 'delivery', 'status'] as NotificationCategory[]) {
    c.settings.notifications.categories[cat] = 'always';
  }
}

const origSlack = config.settings.notifications.channels.slack;
const origPushover = config.settings.notifications.channels.pushover.enabled;
const origUserKey = config.pushoverUserKey;
const origAppToken = config.pushoverAppToken;
const origCategories = { ...config.settings.notifications.categories };

beforeEach(() => {
  slackCalls = [];
  pushoverCalls = [];
  _setNotificationsEnabled(true);
  // deliver() touches the digest store + audit chain on a suppressed send; pin
  // both to throwaway in-memory DBs so these tests never hit the real nyx.db.
  _setDigestDb(new DatabaseSync(':memory:'));
  auditDb = new DatabaseSync(':memory:');
  _setAuditDb(auditDb);
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
  const c = config as unknown as {
    settings: { notifications: { channels: { slack: boolean; pushover: { enabled: boolean } }; categories: Record<NotificationCategory, CategoryPolicy> } };
    pushoverUserKey: string;
    pushoverAppToken: string;
  };
  c.settings.notifications.channels.slack = origSlack;
  c.settings.notifications.channels.pushover.enabled = origPushover;
  c.pushoverUserKey = origUserKey;
  c.pushoverAppToken = origAppToken;
  Object.assign(c.settings.notifications.categories, origCategories);
});

describe('deliver — channel fan-out', () => {
  test('both channels enabled → message hits Slack AND Pushover', async () => {
    setChannels(true, true);
    await deliver('action-required', 'hello');
    assert.equal(slackCalls.length, 1);
    assert.equal(pushoverCalls.length, 1);
    assert.equal(slackCalls[0]!.text, 'hello');
    assert.equal(pushoverCalls[0]!.text, 'hello');
    assert.equal(pushoverCalls[0]!.category, 'action-required');
  });

  test('Slack-only (Pushover disabled) → Slack only — backward compatible', async () => {
    setChannels(true, false);
    await deliver('failure', 'oops');
    assert.equal(slackCalls.length, 1);
    assert.equal(pushoverCalls.length, 0);
  });

  test('Pushover-only (Slack disabled) → Pushover only', async () => {
    setChannels(false, true);
    await deliver('delivery', 'shipped');
    assert.equal(slackCalls.length, 0);
    assert.equal(pushoverCalls.length, 1);
  });

  test('Pushover enabled but creds missing → channel skipped', async () => {
    setChannels(true, true);
    const c = config as unknown as { pushoverUserKey: string; pushoverAppToken: string };
    c.pushoverUserKey = '';
    c.pushoverAppToken = '';
    await deliver('failure', 'no-creds');
    assert.equal(slackCalls.length, 1);
    assert.equal(pushoverCalls.length, 0);
  });

  test('both channels disabled → neither sink fires (console fallback)', async () => {
    setChannels(false, false);
    await deliver('status', 'nowhere');
    assert.equal(slackCalls.length, 0);
    assert.equal(pushoverCalls.length, 0);
  });

  test('notifications globally disabled → no sink fires', async () => {
    setChannels(true, true);
    _setNotificationsEnabled(false);
    await deliver('action-required', 'muted');
    assert.equal(slackCalls.length, 0);
    assert.equal(pushoverCalls.length, 0);
  });
});

describe('typed notifier fns route to the right category', () => {
  beforeEach(() => setChannels(true, true));

  test('taskHalted → action-required', async () => {
    await taskHalted('T-1', 'pat', 'report body');
    assert.equal(pushoverCalls[0]!.category, 'action-required');
  });

  test('taskFailed → failure', async () => {
    await taskFailed('T-2', 'gate', 'log snippet');
    assert.equal(pushoverCalls[0]!.category, 'failure');
  });

  test('pipelineDelivered → delivery', async () => {
    await pipelineDelivered('R-1', 'T-3', 'https://x/pr/1', []);
    assert.equal(pushoverCalls[0]!.category, 'delivery');
  });

  test('taskDispatched → status', async () => {
    await taskDispatched('T-4', 'code', 'sonnet', 'typecheck');
    assert.equal(pushoverCalls[0]!.category, 'status');
  });
});

describe('deliver — undelivered audit event', () => {
  test('all sinks absent → one notification.undelivered with redacted excerpt', async () => {
    setChannels(false, false);
    const secret = 'sk-ant-undelivered-secret-value-123456';
    process.env['ANTHROPIC_API_KEY'] = secret;
    try {
      await deliver('action-required', `boom ${secret} tail`);
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
    const rows = undeliveredRows();
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0]!.payload) as { category: string; text_excerpt: string };
    assert.equal(payload.category, 'action-required');
    assert.equal(payload.text_excerpt.includes(secret), false);
    assert.equal(payload.text_excerpt.includes('[REDACTED]'), true);
  });

  test('excerpt truncated to 200 chars', async () => {
    setChannels(false, false);
    await deliver('status', 'x'.repeat(500));
    const rows = undeliveredRows();
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0]!.payload) as { text_excerpt: string };
    assert.equal(payload.text_excerpt.length, 200);
  });

  test('a working sink → no undelivered event', async () => {
    setChannels(true, false);
    await deliver('failure', 'reached');
    assert.equal(slackCalls.length, 1);
    assert.equal(undeliveredRows().length, 0);
  });

  test('emitted once per deliver(), not per absent sink', async () => {
    setChannels(false, false);
    await deliver('delivery', 'single');
    assert.equal(undeliveredRows().length, 1);
  });

  test('audit-write throw is swallowed — deliver() resolves', async () => {
    setChannels(false, false);
    auditDb.close();
    await assert.doesNotReject(deliver('status', 'after-close'));
  });
});
