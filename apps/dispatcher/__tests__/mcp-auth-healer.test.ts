import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit } from '../src/audit.js';
import {
  _setAuthDb,
  classifyAuth,
  getCredential,
  healAuth,
  recordCredential,
} from '../src/mcp-auth-healer.js';
import { config } from '../src/config.js';

let authDb: DatabaseSync;
let auditDb: DatabaseSync;

beforeEach(() => {
  authDb = new DatabaseSync(':memory:');
  auditDb = new DatabaseSync(':memory:');
  _setAuthDb(authDb);
  _setAuditDb(auditDb);
  audit('dispatch.idle', 'test', {});
});

afterEach(() => {
  _setAuthDb(null);
  _setAuditDb(null);
});

const TTL = config.settings.mcp.auth.defaultTtlMs;
const FRAC = config.settings.mcp.auth.refreshAtFraction;

describe('classifyAuth', () => {
  test('a server with no recorded credential is unknown (never claimed stale)', () => {
    assert.equal(classifyAuth('mcp__Slack'), 'unknown');
  });

  test('a credential well within its TTL is fresh', () => {
    const now = 1_000_000;
    recordCredential('mcp__Slack', { ttlMs: TTL, now });
    assert.equal(classifyAuth('mcp__Slack', now + 1000), 'fresh');
  });

  test('a credential past the refresh fraction is stale', () => {
    const now = 1_000_000;
    recordCredential('mcp__Slack', { ttlMs: TTL, now });
    // Just past the refreshAtFraction point of the [now, now+TTL] window.
    const stalePoint = now + Math.ceil(TTL * FRAC) + 1;
    assert.equal(classifyAuth('mcp__Slack', stalePoint), 'stale');
  });

  test('a credential past its expiry is expired', () => {
    const now = 1_000_000;
    recordCredential('mcp__Slack', { ttlMs: TTL, now });
    assert.equal(classifyAuth('mcp__Slack', now + TTL + 1), 'expired');
  });

  test('recordCredential with an absolute expiresAt is honored', () => {
    recordCredential('mcp__Slack', { expiresAt: 5_000_000 });
    const c = getCredential('mcp__Slack');
    assert.equal(c?.expires_at, 5_000_000);
  });
});

describe('healAuth', () => {
  test('returns stale + expired servers and emits task.mcp.auth_stale for each', () => {
    const now = 1_000_000;
    const stalePoint = now + Math.ceil(TTL * FRAC) + 1;
    recordCredential('mcp__Stale', { ttlMs: TTL, now });
    recordCredential('mcp__Expired', { expiresAt: now - 1 });
    // A long TTL so this one is still well within its refresh window at stalePoint.
    recordCredential('mcp__Fresh', { ttlMs: TTL * 100, now });

    const r = healAuth(['mcp__Stale', 'mcp__Expired', 'mcp__Fresh', 'mcp__Unknown'], {
      taskId: 'T1',
      now: stalePoint,
    });

    const byId = new Map(r.needsAuth.map((n) => [n.server, n.health]));
    assert.equal(byId.get('mcp__Stale'), 'stale');
    assert.equal(byId.get('mcp__Expired'), 'expired');
    assert.equal(byId.has('mcp__Fresh'), false, 'a fresh server must not need auth');
    assert.equal(byId.has('mcp__Unknown'), false, 'an unknown-TTL server must not be flagged');

    const events = (
      auditDb
        .prepare(`SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.mcp.auth_stale'`)
        .get() as { n: number }
    ).n;
    assert.equal(events, 2, 'one auth_stale row per stale/expired server');
  });

  test('all-fresh servers produce no needsAuth and no audit rows', () => {
    const now = 1_000_000;
    recordCredential('mcp__Fresh', { ttlMs: TTL, now });
    const r = healAuth(['mcp__Fresh'], { now: now + 1000 });
    assert.equal(r.needsAuth.length, 0);
    const events = (
      auditDb
        .prepare(`SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.mcp.auth_stale'`)
        .get() as { n: number }
    ).n;
    assert.equal(events, 0);
  });
});
