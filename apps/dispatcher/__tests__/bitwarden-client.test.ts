import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';

import {
  _resetOrgTokenCache,
  fetchMachineAccountToken,
  getOrgAccessToken,
  loadOrgCreds,
} from '../src/secrets/bitwarden-client.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'bw-test-'));
  _resetOrgTokenCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('fetchMachineAccountToken', () => {
  test('reads a 0600 token file', () => {
    const p = resolve(tmp, 'token');
    writeFileSync(p, 'abc-token\n');
    chmodSync(p, 0o600);
    assert.equal(fetchMachineAccountToken(p), 'abc-token');
  });

  test('throws on missing file', () => {
    assert.throws(() => fetchMachineAccountToken(resolve(tmp, 'nope')));
  });

  test('throws on world-readable file (0644)', () => {
    const p = resolve(tmp, 'lax');
    writeFileSync(p, 'leaky');
    chmodSync(p, 0o644);
    assert.throws(() => fetchMachineAccountToken(p), /insecure perms/);
  });
});

describe('loadOrgCreds', () => {
  test('parses well-formed creds file', () => {
    const p = resolve(tmp, 'creds.json');
    writeFileSync(p, JSON.stringify({ client_id: 'cid', client_secret: 'csec' }));
    chmodSync(p, 0o600);
    const c = loadOrgCreds(p);
    assert.equal(c.client_id, 'cid');
    assert.equal(c.client_secret, 'csec');
  });

  test('throws if missing fields', () => {
    const p = resolve(tmp, 'creds.json');
    writeFileSync(p, JSON.stringify({ client_id: 'cid' }));
    chmodSync(p, 0o600);
    assert.throws(() => loadOrgCreds(p), /client_id and client_secret/);
  });

  test('throws on lax perms', () => {
    const p = resolve(tmp, 'creds.json');
    writeFileSync(p, JSON.stringify({ client_id: 'a', client_secret: 'b' }));
    chmodSync(p, 0o644);
    assert.throws(() => loadOrgCreds(p), /insecure perms/);
  });
});

describe('getOrgAccessToken caching', () => {
  test('caches the token within the TTL', async (t) => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = origFetch; });

    const creds = { client_id: 'a', client_secret: 'b' };
    const t1 = await getOrgAccessToken(creds);
    const t2 = await getOrgAccessToken(creds);
    assert.equal(t1, 'tok-1');
    assert.equal(t2, 'tok-1');
    assert.equal(calls, 1);
  });

  test('refetches once the cached token expires', async (t) => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: `tok-${calls}`, expires_in: 60 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = origFetch; });

    const creds = { client_id: 'a', client_secret: 'b' };
    const fakeNow = 1_000_000;
    const t1 = await getOrgAccessToken(creds, fakeNow);
    // Jump past the 60s TTL minus 10min headroom — effectively immediate expiry
    const t2 = await getOrgAccessToken(creds, fakeNow + 60 * 60_000);
    assert.equal(t1, 'tok-1');
    assert.equal(t2, 'tok-2');
    assert.equal(calls, 2);
  });

  test('throws if OAuth call fails', async (t) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('invalid_client', { status: 400, statusText: 'Bad Request' })) as typeof fetch;
    t.after(() => { globalThis.fetch = origFetch; });

    await assert.rejects(getOrgAccessToken({ client_id: 'a', client_secret: 'b' }), /OAuth failed/);
  });
});
