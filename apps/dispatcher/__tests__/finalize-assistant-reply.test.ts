import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import { config } from '../src/config.js';
import {
  _resetSinksForTest,
  _setNotificationsEnabled,
  _setSinksForTest,
} from '../src/notifier.js';
import { finalizeAssistant } from '../src/cli/finalize.js';
import type { WorkingDir } from '../src/git-ops.js';
import type { ParsedTask } from '../src/types.js';

interface ReplyCall {
  channelId: string;
  threadTs: string;
  text: string;
}

let db: DatabaseSync;
let tmpDir: string;
let cleanedUp: boolean;
let replyCalls: ReplyCall[];
let replyResult: boolean;
let savedSlackChannel: boolean;

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: 'NYX-RESPOND-TEST01',
    description: 'Respond to Slack federation member "james".',
    type: 'assistant',
    model: 'haiku',
    gates: 'none',
    priority: 'normal',
    checked: false,
    rawLines: [],
    startLine: 0,
    endLine: 0,
    invalidTags: [],
    ...overrides,
  };
}

function makeWorkingDir(): WorkingDir {
  return {
    kind: 'output',
    path: tmpDir,
    cleanup: () => {
      cleanedUp = true;
    },
  };
}

function auditEvents(): Array<{ event: string; payload: Record<string, unknown> }> {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_audit'`)
    .get();
  if (!exists) return [];
  const rows = db
    .prepare(`SELECT event, payload FROM system_audit ORDER BY id ASC`)
    .all() as Array<{ event: string; payload: string }>;
  return rows.map((r) => ({ event: r.event, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-finalize-test-'));
  cleanedUp = false;
  replyCalls = [];
  replyResult = true;
  // The operator-DM leg (notify.dm) must not reach real Slack from tests:
  // disable the slack channel; the dm() call degrades to a console log.
  savedSlackChannel = config.settings.notifications.channels.slack;
  config.settings.notifications.channels.slack = false;
  _setNotificationsEnabled(true);
  _setSinksForTest({
    threadReply: async (channelId, threadTs, text) => {
      replyCalls.push({ channelId, threadTs, text });
      return replyResult;
    },
  });
});

afterEach(() => {
  _resetSinksForTest();
  config.settings.notifications.channels.slack = savedSlackChannel;
  rmSync(tmpDir, { recursive: true, force: true });
});

const SLACK_REPLY = { channelId: 'D0AB12CD3', threadTs: '1718000000.000100' };

describe('finalizeAssistant — member reply delivery (contact surface)', () => {
  test('delivers SLACK_REPLY.md in-thread via the notifier bot path and completes', async () => {
    writeFileSync(resolve(tmpDir, 'ASSISTANT_OUTPUT.md'), 'composed a reply for james');
    writeFileSync(resolve(tmpDir, 'SLACK_REPLY.md'), 'Hi james — here is the answer.\n');
    const task = makeTask({ slackReply: SLACK_REPLY });

    const outcome = await finalizeAssistant({ task, workingDir: makeWorkingDir(), durationMs: 1000 });

    assert.equal(outcome.status, 'completed');
    assert.equal(replyCalls.length, 1);
    assert.equal(replyCalls[0]?.channelId, 'D0AB12CD3');
    assert.equal(replyCalls[0]?.threadTs, '1718000000.000100');
    assert.equal(replyCalls[0]?.text, 'Hi james — here is the answer.');
    assert.ok(cleanedUp, 'working dir cleaned up on success');
    const sent = auditEvents().find((e) => e.event === 'slack.reply.sent');
    assert.ok(sent, 'slack.reply.sent audited');
    assert.equal(sent?.payload['channelId'], 'D0AB12CD3');
    assert.equal(sent?.payload['threadTs'], '1718000000.000100');
  });

  test('a failed Slack post fails the task — delivery failure is never silent', async () => {
    writeFileSync(resolve(tmpDir, 'ASSISTANT_OUTPUT.md'), 'composed a reply');
    writeFileSync(resolve(tmpDir, 'SLACK_REPLY.md'), 'Hello.');
    replyResult = false;
    const task = makeTask({ slackReply: SLACK_REPLY });

    const outcome = await finalizeAssistant({ task, workingDir: makeWorkingDir(), durationMs: 1000 });

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.failureLog ?? '', /Slack delivery failed/);
    assert.equal(cleanedUp, false, 'working dir preserved for audit');
    assert.ok(auditEvents().some((e) => e.event === 'slack.reply.failed'));
  });

  test('missing SLACK_REPLY.md fails the task without attempting delivery', async () => {
    writeFileSync(resolve(tmpDir, 'ASSISTANT_OUTPUT.md'), 'forgot the reply file');
    const task = makeTask({ slackReply: SLACK_REPLY });

    const outcome = await finalizeAssistant({ task, workingDir: makeWorkingDir(), durationMs: 1000 });

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.failureLog ?? '', /SLACK_REPLY\.md/);
    assert.equal(replyCalls.length, 0);
    assert.equal(cleanedUp, false);
  });

  test('an empty SLACK_REPLY.md fails the task without attempting delivery', async () => {
    writeFileSync(resolve(tmpDir, 'ASSISTANT_OUTPUT.md'), 'wrote a blank reply');
    writeFileSync(resolve(tmpDir, 'SLACK_REPLY.md'), '   \n');
    const task = makeTask({ slackReply: SLACK_REPLY });

    const outcome = await finalizeAssistant({ task, workingDir: makeWorkingDir(), durationMs: 1000 });

    assert.equal(outcome.status, 'failed');
    assert.equal(replyCalls.length, 0);
  });

  test('a task without slackReply never touches the reply sink (plain assistant path unchanged)', async () => {
    writeFileSync(resolve(tmpDir, 'ASSISTANT_OUTPUT.md'), 'a normal assistant answer');
    const task = makeTask();

    const outcome = await finalizeAssistant({ task, workingDir: makeWorkingDir(), durationMs: 1000 });

    assert.equal(outcome.status, 'completed');
    assert.equal(replyCalls.length, 0);
    assert.ok(cleanedUp);
    assert.ok(!auditEvents().some((e) => e.event.startsWith('slack.reply.')));
  });
});
