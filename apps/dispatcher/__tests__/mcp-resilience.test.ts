import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, verifyChain } from '../src/audit.js';
import {
  _resetProbeCache,
  _setHealthDb,
  applyPolicy,
  classifyMcpFailure,
  effectiveState,
  getHealth,
  isOpen,
  parseMcpHealth,
  recordFailure,
  recordSpawnOutcome,
  recordSuccess,
  resolvePolicy,
  resolveWithheld,
  serversReferencedIn,
} from '../src/mcp-resilience.js';
import { config } from '../src/config.js';

let healthDb: DatabaseSync;
let auditDb: DatabaseSync;

beforeEach(() => {
  healthDb = new DatabaseSync(':memory:');
  auditDb = new DatabaseSync(':memory:');
  _setHealthDb(healthDb);
  _setAuditDb(auditDb);
  _resetProbeCache();
  // Materialize the audit schema so count-queries against an event that was never
  // emitted this test (legitimately 0 rows) don't hit "no such table".
  audit('dispatch.idle', 'test', {});
});

afterEach(() => {
  _setHealthDb(null);
  _setAuditDb(null);
});

const THRESHOLD = config.settings.mcp.breaker.failureThreshold;
const COOLDOWN = config.settings.mcp.breaker.cooldownMs;

describe('circuit breaker state machine', () => {
  test('a fresh server is closed with zero failures', () => {
    const h = getHealth('mcp__Slack');
    assert.equal(h.state, 'closed');
    assert.equal(h.consecutive_failures, 0);
    assert.equal(isOpen('mcp__Slack'), false);
  });

  test('opens only after the threshold consecutive failures', () => {
    for (let i = 1; i < THRESHOLD; i++) {
      recordFailure('mcp__Slack', 'transport');
      assert.equal(isOpen('mcp__Slack'), false, `should still be closed after ${i} failures`);
    }
    recordFailure('mcp__Slack', 'transport');
    assert.equal(isOpen('mcp__Slack'), true, 'should open at the threshold');
    assert.equal(getHealth('mcp__Slack').state, 'open');
  });

  test('a success resets the counter and keeps the breaker closed', () => {
    recordFailure('mcp__Slack', 'transport');
    recordSuccess('mcp__Slack');
    assert.equal(getHealth('mcp__Slack').consecutive_failures, 0);
    // A subsequent single failure must not re-open (counter was reset).
    recordFailure('mcp__Slack', 'transport');
    assert.equal(isOpen('mcp__Slack'), false);
  });

  test('an open breaker transitions to half-open after the cooldown on read', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    assert.equal(effectiveState('mcp__Slack', t0), 'open');
    // Still open just before the cooldown elapses.
    assert.equal(effectiveState('mcp__Slack', t0 + COOLDOWN - 1), 'open');
    // Half-open once the cooldown has elapsed.
    assert.equal(effectiveState('mcp__Slack', t0 + COOLDOWN), 'half-open');
    // isOpen() reports false for half-open (one probe allowed through).
    assert.equal(isOpen('mcp__Slack', t0 + COOLDOWN), false);
  });

  test('a half-open success closes the breaker', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    recordSuccess('mcp__Slack', t0 + COOLDOWN);
    assert.equal(getHealth('mcp__Slack').state, 'closed');
    assert.equal(effectiveState('mcp__Slack', t0 + COOLDOWN), 'closed');
  });

  test('a half-open failure re-opens immediately and restarts the cooldown', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    const tHalf = t0 + COOLDOWN;
    assert.equal(effectiveState('mcp__Slack', tHalf), 'half-open');
    recordFailure('mcp__Slack', 'transport', tHalf);
    // Re-opened, and the new opened_at restarts the cooldown.
    assert.equal(effectiveState('mcp__Slack', tHalf), 'open');
    assert.equal(effectiveState('mcp__Slack', tHalf + COOLDOWN - 1), 'open');
  });

  test('breaker open/close emit audit events that keep the chain linear', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    recordSuccess('mcp__Slack', t0 + COOLDOWN);
    const chain = verifyChain();
    assert.equal(chain.ok, true);
    const rows = auditDb.prepare(`SELECT event FROM system_audit ORDER BY id`).all() as Array<{ event: string }>;
    const events = rows.map((r) => r.event);
    assert.ok(events.includes('task.mcp.breaker_opened'));
    assert.ok(events.includes('task.mcp.breaker_closed'));
  });

  test('repeated failures past the threshold emit breaker_opened only once', () => {
    for (let i = 0; i < THRESHOLD + 3; i++) recordFailure('mcp__Slack', 'transport');
    const n = (
      auditDb
        .prepare(`SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.mcp.breaker_opened'`)
        .get() as { n: number }
    ).n;
    assert.equal(n, 1);
  });

  test('a success on an already-closed breaker emits no breaker_closed', () => {
    recordSuccess('mcp__Slack');
    const n = (
      auditDb
        .prepare(`SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.mcp.breaker_closed'`)
        .get() as { n: number }
    ).n;
    assert.equal(n, 0);
  });
});

describe('classifyMcpFailure', () => {
  test('detects 401/403 as auth', () => {
    assert.equal(classifyMcpFailure('tool error: HTTP 401 Unauthorized'), 'auth');
    assert.equal(classifyMcpFailure('HTTP/1.1 403 Forbidden'), 'auth');
  });

  test('detects OAuth error codes as auth even without an HTTP status', () => {
    assert.equal(classifyMcpFailure('{"error":"invalid_grant"}'), 'auth');
    assert.equal(classifyMcpFailure('insufficient_scope: need calendar.write'), 'auth');
    assert.equal(classifyMcpFailure('token_expired'), 'auth');
    assert.equal(classifyMcpFailure('WWW-Authenticate: Bearer'), 'auth');
  });

  test('detects 5xx / network errors as transport', () => {
    assert.equal(classifyMcpFailure('HTTP 503 Service Unavailable'), 'transport');
    assert.equal(classifyMcpFailure('connect ECONNREFUSED 127.0.0.1:8080'), 'transport');
    assert.equal(classifyMcpFailure('socket hang up'), 'transport');
    assert.equal(classifyMcpFailure('mcp server disconnected unexpectedly'), 'transport');
  });

  test('clean output classifies as none', () => {
    assert.equal(classifyMcpFailure('ASSISTANT COMPLETE\nSummary: read 3 channels.'), 'none');
  });

  test('does NOT misclassify a task that mentions 429/auth in prose', () => {
    // A task implementing auth should not trip the classifier on its own VERDICT.
    assert.equal(classifyMcpFailure('VERDICT: fixed — added 401 handling to the login route'), 'none');
  });
});

describe('serversReferencedIn', () => {
  test('extracts deduped mcp__<server> tokens from tool-call shapes', () => {
    const out = 'calling mcp__Slack__send_message then mcp__Slack__read_channel and mcp__Notion__search';
    assert.deepEqual(serversReferencedIn(out).sort(), ['mcp__Notion', 'mcp__Slack']);
  });

  test('returns empty when no mcp tool tokens are present', () => {
    assert.deepEqual(serversReferencedIn('plain output, no tools'), []);
  });
});

describe('recordSpawnOutcome', () => {
  test('a transport failure increments the breaker for the referenced server only', () => {
    const out = 'mcp__Slack__send_message failed: HTTP 503';
    for (let i = 0; i < THRESHOLD; i++) recordSpawnOutcome(out, { exitCode: 1 });
    assert.equal(isOpen('mcp__Slack'), true);
    assert.equal(isOpen('mcp__Notion'), false, 'an unrelated server must not be tripped');
  });

  test('a clean exit records success and closes a half-open breaker', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    // Simulate a later clean spawn that used Slack successfully.
    const kind = recordSpawnOutcome('mcp__Slack__read_channel ok\nASSISTANT COMPLETE', { exitCode: 0 });
    assert.equal(kind, 'none');
    assert.equal(getHealth('mcp__Slack').state, 'closed');
  });

  test('an auth failure returns kind=auth for operator routing', () => {
    const kind = recordSpawnOutcome('mcp__Calendar__list_events → HTTP 401', { exitCode: 1 });
    assert.equal(kind, 'auth');
  });

  test('a non-zero exit with no MCP failure does NOT record success', () => {
    // e.g. the agent crashed for a non-MCP reason; we must not wrongly "heal" a
    // breaker on a failed run.
    recordFailure('mcp__Slack', 'transport');
    recordSpawnOutcome('mcp__Slack__read_channel\nsome unrelated crash', { exitCode: 1 });
    assert.equal(getHealth('mcp__Slack').consecutive_failures, 1, 'counter must not reset on a non-clean exit');
  });
});

describe('parseMcpHealth', () => {
  test('parses connection status per server', () => {
    const sample = `Checking MCP server health…

claude.ai Slack: https://mcp.slack.com/mcp - ✓ Connected
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
Sanity: https://mcp.sanity.io (HTTP) - ✗ Failed to connect
`;
    const out = parseMcpHealth(sample);
    const byId = new Map(out.map((s) => [s.serverId, s]));
    assert.equal(byId.get('mcp__claude_ai_Slack')?.connected, true);
    assert.equal(byId.get('mcp__claude_ai_Google_Calendar')?.connected, false);
    assert.equal(byId.get('mcp__claude_ai_Google_Calendar')?.needsAuth, true);
    assert.equal(byId.get('mcp__Sanity')?.connected, false);
  });
});

describe('resolveWithheld', () => {
  test('withholds a server whose breaker is open', () => {
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport');
    const r = resolveWithheld(['mcp__Slack', 'mcp__Notion']);
    assert.deepEqual(r.allowed, ['mcp__Notion']);
    assert.equal(r.withheld[0]?.server, 'mcp__Slack');
    assert.equal(r.withheld[0]?.reason, 'breaker-open');
  });

  test('withholds a probe-disconnected server', () => {
    const probe = [
      { serverId: 'mcp__Slack', connected: true, needsAuth: false },
      { serverId: 'mcp__Notion', connected: false, needsAuth: false },
    ];
    const r = resolveWithheld(['mcp__Slack', 'mcp__Notion'], { probe });
    assert.deepEqual(r.allowed, ['mcp__Slack']);
    assert.equal(r.withheld[0]?.reason, 'probe-disconnected');
  });

  test('a half-open server is NOT withheld (the spawn is its probe)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    const r = resolveWithheld(['mcp__Slack'], { now: t0 + COOLDOWN });
    assert.deepEqual(r.allowed, ['mcp__Slack']);
    assert.equal(r.withheld.length, 0);
  });

  test('a server the probe did not observe is left in (breaker is authoritative)', () => {
    const probe = [{ serverId: 'mcp__Other', connected: false, needsAuth: false }];
    const r = resolveWithheld(['mcp__Slack'], { probe });
    assert.deepEqual(r.allowed, ['mcp__Slack']);
  });
});

describe('policy resolution', () => {
  test('default policy auto keeps everything', () => {
    // With the default empty tools map + defaultPolicy auto.
    const r = applyPolicy(['mcp__Slack', 'mcp__Notion']);
    assert.deepEqual(r.allowed.sort(), ['mcp__Notion', 'mcp__Slack']);
    assert.deepEqual(r.denied, []);
    assert.deepEqual(r.ask, []);
  });

  test('resolvePolicy falls back to defaultPolicy for unlisted servers', () => {
    assert.equal(resolvePolicy('mcp__Anything'), config.settings.mcp.policy.defaultPolicy);
  });

  test('a server prefix policy applies to its tools', () => {
    config.settings.mcp.policy.tools['mcp__Slack'] = 'deny';
    try {
      assert.equal(resolvePolicy('mcp__Slack'), 'deny');
      assert.equal(resolvePolicy('mcp__Slack__send_message'), 'deny');
      const r = applyPolicy(['mcp__Slack', 'mcp__Notion']);
      assert.deepEqual(r.denied, ['mcp__Slack']);
      assert.deepEqual(r.allowed, ['mcp__Notion']);
    } finally {
      delete config.settings.mcp.policy.tools['mcp__Slack'];
    }
  });

  test('the most specific (longest) matching key wins', () => {
    config.settings.mcp.policy.tools['mcp__Slack'] = 'deny';
    config.settings.mcp.policy.tools['mcp__Slack__read_channel'] = 'auto';
    try {
      assert.equal(resolvePolicy('mcp__Slack__read_channel'), 'auto');
      assert.equal(resolvePolicy('mcp__Slack__send_message'), 'deny');
    } finally {
      delete config.settings.mcp.policy.tools['mcp__Slack'];
      delete config.settings.mcp.policy.tools['mcp__Slack__read_channel'];
    }
  });
});
