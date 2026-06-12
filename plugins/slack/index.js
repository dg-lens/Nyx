import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL ?? '';
const DATA = process.env.NYX_DATA_DIR || join(homedir(), 'Nyx', 'Data');

async function postGateBrief(gate, runId, summary) {
  const text = `${gate === 'preview' ? '◧ Preview' : '◨ Review'} gate — run ${runId}\n${summary}`;
  if (!BOT_TOKEN || !CHANNEL) {
    console.log(`[slack] (mock post) ${text}`);
    return;
  }
  const buttons =
    gate === 'preview'
      ? [['Approve', 'go'], ['Revise', 'revise']]
      : [['Proceed', 'proceed'], ['Fix', 'fix']];
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: CHANNEL,
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          {
            type: 'actions',
            elements: buttons.map(([label, decision]) => ({
              type: 'button',
              text: { type: 'plain_text', text: label },
              action_id: `nyx_${decision}`,
              value: JSON.stringify({ runId, decision }),
            })),
          },
        ],
      }),
    });
  } catch (err) {
    console.error('[slack] post failed:', err.message);
  }
}

export function loadMembers(path, log) {
  if (!existsSync(path)) {
    log(`member registry not found at ${path} — inbound DMs are audit-only`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`member registry malformed at ${path}: ${err.message} — inbound DMs are audit-only`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log(`member registry at ${path} is not an object map — inbound DMs are audit-only`);
    return {};
  }
  const valid = {};
  for (const [userId, entry] of Object.entries(parsed)) {
    if (
      !entry || typeof entry !== 'object' ||
      typeof entry.member !== 'string' || !entry.member.trim() ||
      typeof entry.handling !== 'string'
    ) {
      log(`skipping member entry '${userId}' — needs { "member": string, "handling": string }`);
      continue;
    }
    valid[userId] = { member: entry.member.trim(), handling: entry.handling };
  }
  return valid;
}

export function routeMessage(event, members) {
  if (!event || event.bot_id || event.subtype) return null;
  if (event.channel_type !== 'im') return null;
  if (!event.user || !event.channel) return null;
  const threadTs = event.thread_ts || event.ts;
  const entry = members[event.user];
  if (!entry) {
    return {
      source: 'slack',
      kind: 'action',
      payload: {
        action: 'respond_message',
        params: { slackUserId: event.user, channelId: event.channel, threadTs },
      },
    };
  }
  if (entry.handling !== 'respond') return null;
  const text = typeof event.text === 'string' ? event.text.trim() : '';
  if (!text) return null;
  return {
    source: 'slack',
    kind: 'action',
    payload: {
      action: 'respond_message',
      params: { member: entry.member, channelId: event.channel, threadTs, text },
    },
  };
}

async function defaultClient(appToken) {
  const { SocketModeClient } = await import('@slack/socket-mode');
  return new SocketModeClient({ appToken });
}

export function connectSocketMode({ appToken, members, emit, log, makeClient }) {
  const factory = makeClient || defaultClient;
  let stopped = false;
  let live = null;
  const started = (async () => {
    let client;
    try {
      client = await factory(appToken);
    } catch (err) {
      log(`Socket Mode client unavailable: ${err.message}`);
      return null;
    }
    client.on('message', async (args) => {
      try {
        if (args.ack) await args.ack();
        const signal = routeMessage(args.event, members);
        if (signal) emit(signal);
      } catch (err) {
        log(`inbound message handling failed (isolated): ${err.message}`);
      }
    });
    try {
      await client.start();
    } catch (err) {
      log(`Socket Mode connect failed: ${err.message}`);
      return null;
    }
    if (stopped) {
      try { await client.disconnect(); } catch { /* already down */ }
      return null;
    }
    live = client;
    log(`Socket Mode connected — routing member DMs (${Object.keys(members).length} member(s) registered)`);
    return client;
  })();
  return {
    started,
    stop: () => {
      stopped = true;
      if (live) {
        const c = live;
        live = null;
        Promise.resolve(c.disconnect()).catch(() => {});
      }
    },
  };
}

export default {
  setup(ctx) {
    if (ctx.runtime === 'tick') {
      ctx.hooks.on('pipeline.gateReached', async (e) => {
        await postGateBrief(e.gate, e.runId, e.summary);
      });
      ctx.log('outbound gate posts armed');
    }
    if (ctx.runtime === 'host') {
      ctx.io.source('slack', (emit) => {
        if (!APP_TOKEN) {
          ctx.log('Socket Mode idle (no SLACK_APP_TOKEN) — inbound is mocked');
          return;
        }
        const members = loadMembers(join(DATA, 'federation', 'members.json'), ctx.log);
        const conn = connectSocketMode({ appToken: APP_TOKEN, members, emit, log: ctx.log });
        return conn.stop;
      });
    }
  },
};
