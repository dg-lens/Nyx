import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { config } from '../src/config.js';
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
import type { NotificationCategory } from '../src/settings.js';

interface SlackCall {
  text: string;
}
interface PushoverCall {
  category: NotificationCategory;
  text: string;
}

let slackCalls: SlackCall[];
let pushoverCalls: PushoverCall[];

function setChannels(slack: boolean, pushover: boolean): void {
  const c = config as unknown as {
    settings: { notifications: { channels: { slack: boolean; pushover: { enabled: boolean } } } };
    pushoverUserKey: string;
    pushoverAppToken: string;
  };
  c.settings.notifications.channels.slack = slack;
  c.settings.notifications.channels.pushover.enabled = pushover;
  // Pushover also requires creds present to be considered enabled.
  c.pushoverUserKey = pushover ? 'u-test' : '';
  c.pushoverAppToken = pushover ? 't-test' : '';
}

const origSlack = config.settings.notifications.channels.slack;
const origPushover = config.settings.notifications.channels.pushover.enabled;
const origUserKey = config.pushoverUserKey;
const origAppToken = config.pushoverAppToken;

beforeEach(() => {
  slackCalls = [];
  pushoverCalls = [];
  _setNotificationsEnabled(true);
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
  const c = config as unknown as {
    settings: { notifications: { channels: { slack: boolean; pushover: { enabled: boolean } } } };
    pushoverUserKey: string;
    pushoverAppToken: string;
  };
  c.settings.notifications.channels.slack = origSlack;
  c.settings.notifications.channels.pushover.enabled = origPushover;
  c.pushoverUserKey = origUserKey;
  c.pushoverAppToken = origAppToken;
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
