import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { loadRegistry, deliver, registerSinks } from '../index.js';

let work;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'route-to-test-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

const noop = () => {};
function collect() {
  const lines = [];
  return { log: (m) => lines.push(m), lines };
}

describe('loadRegistry', () => {
  test('parses valid surfaces of every kind', () => {
    const p = join(work, 'surfaces.json');
    writeFileSync(p, JSON.stringify({
      surfaces: {
        local: { kind: 'ssh-local', inbox: '~/Reading' },
        remote: { kind: 'ssh', address: 'mba', inbox: '~/Reading' },
        phone: { kind: 'icloud', inbox: '~/iCloud/Reading' },
        tg: { kind: 'telegram', address: '123' },
      },
    }));
    const reg = loadRegistry(p, noop);
    assert.deepEqual(Object.keys(reg).sort(), ['local', 'phone', 'remote', 'tg']);
  });

  test('missing file returns {} and never throws', () => {
    const reg = loadRegistry(join(work, 'nope.json'), noop);
    assert.deepEqual(reg, {});
  });

  test('malformed JSON returns {} and never throws', () => {
    const p = join(work, 'bad.json');
    writeFileSync(p, '{ this is not json ');
    const c = collect();
    const reg = loadRegistry(p, c.log);
    assert.deepEqual(reg, {});
    assert.ok(c.lines.some((l) => /malformed/.test(l)));
  });

  test('surfaces with unknown/absent kind are skipped, valid ones kept', () => {
    const p = join(work, 'surfaces.json');
    writeFileSync(p, JSON.stringify({
      surfaces: {
        good: { kind: 'ssh', address: 'mba' },
        bogus: { kind: 'carrier-pigeon' },
        empty: null,
        noKind: { address: 'x' },
      },
    }));
    const reg = loadRegistry(p, noop);
    assert.deepEqual(Object.keys(reg), ['good']);
  });
});

describe('deliver — routing decision per kind (transports mocked)', () => {
  function artifact() {
    const f = join(work, 'doc.md');
    writeFileSync(f, '# hello');
    return f;
  }

  test('ssh-local routes to /usr/bin/open via run, no scp/fetch', async () => {
    const calls = [];
    const transports = { run: (cmd, args) => { calls.push([cmd, args]); return { code: 0, stderr: '' }; } };
    const inbox = join(work, 'Reading');
    await deliver({ kind: 'ssh-local', inbox }, artifact(), noop, transports);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/usr/bin/open');
    assert.ok(calls[0][1].some((a) => a.endsWith('doc.md')));
  });

  test('ssh routes mkdir -> scp -> open over the run transport', async () => {
    const cmds = [];
    const transports = { run: (cmd) => { cmds.push(cmd); return { code: 0, stderr: '' }; } };
    await deliver({ kind: 'ssh', address: 'mba', inbox: '~/Reading' }, artifact(), noop, transports);
    assert.deepEqual(cmds, ['ssh', 'scp', 'ssh']);
  });

  test('ssh with unresolved ${} address never invokes scp', async () => {
    const cmds = [];
    const transports = { run: (cmd) => { cmds.push(cmd); return { code: 0, stderr: '' }; } };
    const c = collect();
    await deliver({ kind: 'ssh', address: '${MISSING}', inbox: '~/Reading' }, artifact(), c.log, transports);
    assert.deepEqual(cmds, []);
    assert.ok(c.lines.some((l) => /no resolvable address/.test(l)));
  });

  test('icloud copies into the inbox dir, no run/fetch', async () => {
    const calls = [];
    const inbox = join(work, 'iCloud', 'Reading');
    mkdirSync(join(work, 'iCloud'), { recursive: true });
    const transports = { run: () => { calls.push('run'); return { code: 0 }; }, fetch: () => { calls.push('fetch'); } };
    await deliver({ kind: 'icloud', inbox }, artifact(), noop, transports);
    assert.deepEqual(calls, []);
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(inbox, 'doc.md')));
  });

  test('telegram routes to sendDocument via fetch with bot token', async () => {
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'TESTTOKEN';
    process.env.TELEGRAM_CHAT_ID = '999';
    let calledUrl = '';
    const transports = { fetch: async (url) => { calledUrl = url; return { ok: true, status: 200 }; } };
    try {
      await deliver({ kind: 'telegram', address: '${TELEGRAM_CHAT_ID}' }, artifact(), noop, transports);
    } finally {
      if (prevTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevTok;
      if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
    }
    assert.match(calledUrl, /\/sendDocument$/);
    assert.match(calledUrl, /bot/);
  });

  test('telegram with no creds skips delivery (never throws)', async () => {
    const prevTok = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    let fetched = false;
    const transports = { fetch: async () => { fetched = true; return { ok: true, status: 200 }; } };
    const c = collect();
    try {
      await deliver({ kind: 'telegram', address: '${TELEGRAM_CHAT_ID}' }, artifact(), c.log, transports);
    } finally {
      if (prevTok !== undefined) process.env.TELEGRAM_BOT_TOKEN = prevTok;
    }
    assert.equal(fetched, false);
    assert.ok(c.lines.some((l) => /missing bot token or chat id/.test(l)));
  });

  test('a failing transport logs but never throws (isolation)', async () => {
    const transports = { run: () => { throw new Error('ssh exploded'); } };
    const c = collect();
    await assert.doesNotReject(
      deliver({ kind: 'ssh', address: 'mba', inbox: '~/Reading' }, artifact(), c.log, transports),
    );
  });
});

describe('registerSinks — one sink per surface, dead surface isolated', () => {
  function fakeCtx() {
    const registered = new Map();
    const logs = [];
    return {
      sinks: registered,
      logs,
      ctx: { io: { sink: (n, h) => registered.set(n, h) }, log: (m) => logs.push(m) },
    };
  }

  test('registers exactly one sink per surface name', () => {
    const f = fakeCtx();
    registerSinks(f.ctx, { mba: { kind: 'ssh', address: 'mba' }, tg: { kind: 'telegram', address: '1' } });
    assert.deepEqual([...f.sinks.keys()].sort(), ['mba', 'tg']);
  });

  test('a thrown delivery in one sink does not reject the sink handler', async () => {
    const f = fakeCtx();
    const artifactFile = join(work, 'a.md');
    writeFileSync(artifactFile, 'x');
    const transports = { run: () => { throw new Error('dead surface'); } };
    registerSinks(f.ctx, { mba: { kind: 'ssh', address: 'mba', inbox: '~/Reading' } }, transports);
    const handler = f.sinks.get('mba');
    await assert.doesNotReject(handler({ source: 't', kind: 'route', payload: { path: artifactFile } }));
  });

  test('sink with a missing artifact path is a logged no-op', async () => {
    const f = fakeCtx();
    registerSinks(f.ctx, { mba: { kind: 'ssh', address: 'mba' } });
    const handler = f.sinks.get('mba');
    await handler({ source: 't', kind: 'route', payload: {} });
    assert.ok(f.logs.some((l) => /no payload\.path/.test(l)));
  });
});
