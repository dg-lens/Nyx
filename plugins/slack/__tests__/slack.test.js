import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { loadMembers, routeMessage, connectSocketMode } from '../index.js';

let work;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'slack-plugin-test-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const noop = () => {};
function collect() {
  const lines = [];
  return { log: (m) => lines.push(m), lines };
}

function imEvent(overrides = {}) {
  return {
    type: 'message',
    channel_type: 'im',
    user: 'U_JAMES',
    channel: 'D0AB12CD3',
    ts: '1718000000.000100',
    text: 'hello nyx',
    ...overrides,
  };
}

const MEMBERS = {
  U_JAMES: { member: 'james', handling: 'respond' },
  U_VESSA: { member: 'vessa', handling: 'observe' },
};

describe('loadMembers', () => {
  test('parses a valid registry', () => {
    const p = join(work, 'members.json');
    writeFileSync(p, JSON.stringify({
      U_JAMES: { member: 'james', handling: 'respond' },
      U_VESSA: { member: 'vessa', handling: 'observe' },
    }));
    const reg = loadMembers(p, noop);
    assert.deepEqual(Object.keys(reg).sort(), ['U_JAMES', 'U_VESSA']);
    assert.equal(reg.U_JAMES.member, 'james');
    assert.equal(reg.U_JAMES.handling, 'respond');
  });

  test('missing file returns {} and never throws', () => {
    const c = collect();
    const reg = loadMembers(join(work, 'nope.json'), c.log);
    assert.deepEqual(reg, {});
    assert.ok(c.lines.some((l) => /not found/.test(l)));
  });

  test('malformed JSON returns {} and never throws', () => {
    const p = join(work, 'bad.json');
    writeFileSync(p, '{ this is not json ');
    const c = collect();
    const reg = loadMembers(p, c.log);
    assert.deepEqual(reg, {});
    assert.ok(c.lines.some((l) => /malformed/.test(l)));
  });

  test('non-object root returns {} and never throws', () => {
    const p = join(work, 'array.json');
    writeFileSync(p, '["U_JAMES"]');
    const reg = loadMembers(p, noop);
    assert.deepEqual(reg, {});
  });

  test('invalid entries are skipped, valid ones kept', () => {
    const p = join(work, 'members.json');
    writeFileSync(p, JSON.stringify({
      U_GOOD: { member: 'james', handling: 'respond' },
      U_NO_MEMBER: { handling: 'respond' },
      U_EMPTY_MEMBER: { member: '   ', handling: 'respond' },
      U_NO_HANDLING: { member: 'x' },
      U_NULL: null,
      U_STRING: 'james',
    }));
    const c = collect();
    const reg = loadMembers(p, c.log);
    assert.deepEqual(Object.keys(reg), ['U_GOOD']);
    assert.equal(c.lines.length, 5);
  });
});

describe('routeMessage', () => {
  test('known respond member produces the respond_message signal', () => {
    const signal = routeMessage(imEvent(), MEMBERS);
    assert.deepEqual(signal, {
      source: 'slack',
      kind: 'action',
      payload: {
        action: 'respond_message',
        params: {
          member: 'james',
          channelId: 'D0AB12CD3',
          threadTs: '1718000000.000100',
          text: 'hello nyx',
        },
      },
    });
  });

  test('thread_ts wins over ts when the message is already threaded', () => {
    const signal = routeMessage(imEvent({ thread_ts: '1717990000.000200' }), MEMBERS);
    assert.equal(signal.payload.params.threadTs, '1717990000.000200');
  });

  test('unknown sender produces an audit-only signal — no member, no text', () => {
    const signal = routeMessage(imEvent({ user: 'U_STRANGER' }), MEMBERS);
    assert.equal(signal.payload.action, 'respond_message');
    assert.deepEqual(signal.payload.params, {
      slackUserId: 'U_STRANGER',
      channelId: 'D0AB12CD3',
      threadTs: '1718000000.000100',
    });
    assert.ok(!('member' in signal.payload.params));
    assert.ok(!('text' in signal.payload.params));
  });

  test('known member with non-respond handling is ignored', () => {
    assert.equal(routeMessage(imEvent({ user: 'U_VESSA' }), MEMBERS), null);
  });

  test('bot messages, subtyped messages, and non-im channels are ignored', () => {
    assert.equal(routeMessage(imEvent({ bot_id: 'B123' }), MEMBERS), null);
    assert.equal(routeMessage(imEvent({ subtype: 'message_changed' }), MEMBERS), null);
    assert.equal(routeMessage(imEvent({ channel_type: 'channel' }), MEMBERS), null);
    assert.equal(routeMessage(null, MEMBERS), null);
  });

  test('known member with empty text is ignored', () => {
    assert.equal(routeMessage(imEvent({ text: '   ' }), MEMBERS), null);
    assert.equal(routeMessage(imEvent({ text: undefined }), MEMBERS), null);
  });
});

describe('connectSocketMode (mocked client — no live network)', () => {
  function mockClient() {
    const handlers = {};
    return {
      started: false,
      disconnected: false,
      handlers,
      on(name, fn) { handlers[name] = fn; },
      async start() { this.started = true; },
      async disconnect() { this.disconnected = true; },
    };
  }

  test('connects, acks, and emits the routed signal for a member DM', async () => {
    const client = mockClient();
    const emitted = [];
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: MEMBERS,
      emit: (s) => emitted.push(s),
      log: noop,
      makeClient: async () => client,
    });
    assert.equal(await conn.started, client);
    assert.equal(client.started, true);
    assert.ok(client.handlers.message, 'message handler registered');

    let acked = false;
    await client.handlers.message({ event: imEvent(), ack: async () => { acked = true; } });
    assert.equal(acked, true);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].payload.params.member, 'james');
  });

  test('unknown-sender DM is acked and emits the audit-only signal', async () => {
    const client = mockClient();
    const emitted = [];
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: MEMBERS,
      emit: (s) => emitted.push(s),
      log: noop,
      makeClient: async () => client,
    });
    await conn.started;
    await client.handlers.message({ event: imEvent({ user: 'U_STRANGER' }), ack: async () => {} });
    assert.equal(emitted.length, 1);
    assert.ok(!('member' in emitted[0].payload.params));
  });

  test('ignored events emit nothing', async () => {
    const client = mockClient();
    const emitted = [];
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: MEMBERS,
      emit: (s) => emitted.push(s),
      log: noop,
      makeClient: async () => client,
    });
    await conn.started;
    await client.handlers.message({ event: imEvent({ bot_id: 'B1' }), ack: async () => {} });
    assert.equal(emitted.length, 0);
  });

  test('a throwing handler path is isolated — logged, never propagated', async () => {
    const client = mockClient();
    const c = collect();
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: MEMBERS,
      emit: () => { throw new Error('route exploded'); },
      log: c.log,
      makeClient: async () => client,
    });
    await conn.started;
    await client.handlers.message({ event: imEvent(), ack: async () => {} });
    assert.ok(c.lines.some((l) => /isolated.*route exploded/.test(l)));
  });

  test('connect failure logs and resolves null — never throws', async () => {
    const client = mockClient();
    client.start = async () => { throw new Error('socket refused'); };
    const c = collect();
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: {},
      emit: noop,
      log: c.log,
      makeClient: async () => client,
    });
    assert.equal(await conn.started, null);
    assert.ok(c.lines.some((l) => /connect failed.*socket refused/.test(l)));
  });

  test('client factory failure logs and resolves null — never throws', async () => {
    const c = collect();
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: {},
      emit: noop,
      log: c.log,
      makeClient: async () => { throw new Error('module missing'); },
    });
    assert.equal(await conn.started, null);
    assert.ok(c.lines.some((l) => /unavailable.*module missing/.test(l)));
  });

  test('stop disconnects a live client', async () => {
    const client = mockClient();
    const conn = connectSocketMode({
      appToken: 'xapp-test',
      members: MEMBERS,
      emit: noop,
      log: noop,
      makeClient: async () => client,
    });
    await conn.started;
    conn.stop();
    await Promise.resolve();
    assert.equal(client.disconnected, true);
  });
});
