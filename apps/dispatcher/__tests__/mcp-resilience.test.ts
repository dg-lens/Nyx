import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setAuditDb, audit, verifyChain } from '../src/audit.js';
import {
  _resetProbeCache,
  _setHealthDb,
  applyPolicy,
  authFailedServers,
  canonicalServerId,
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
import { parseMcpToolEvents } from '../src/spawn-usage.js';
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

  test('captures a UUID-prefixed connector server whole (hyphen-tolerant regex)', () => {
    // The live claude.ai connector tool shape — the old regex stopped at the first
    // hyphen and returned a garbage/empty key, so the connector never matched its
    // own breaker row. The fixed regex keeps the UUID intact.
    const out = 'mcp__87a5b867-5c2d-4ac4-9fbf-333d78862c36__slack_send_message failed';
    assert.deepEqual(serversReferencedIn(out), ['mcp__87a5b867-5c2d-4ac4-9fbf-333d78862c36']);
  });
});

describe('canonicalServerId (namespace alignment, defect 2)', () => {
  test('a discovery entry is already canonical (no-op)', () => {
    assert.equal(canonicalServerId('mcp__Slack'), 'mcp__Slack');
  });
  test('a full tool token reduces to its server key', () => {
    assert.equal(canonicalServerId('mcp__Slack__send_message'), 'mcp__Slack');
  });
  test('a UUID-prefixed connector tool keeps the UUID in the server key', () => {
    assert.equal(
      canonicalServerId('mcp__87a5b867-5c2d-4ac4-9fbf-333d78862c36__slack_send_message'),
      'mcp__87a5b867-5c2d-4ac4-9fbf-333d78862c36',
    );
  });
  test('attribution and discovery land on the SAME key for a local server', () => {
    // The withhold path canonicalizes its discovery entry; the attribution path
    // canonicalizes the live tool token. For a local (display-name) server both
    // yield the identical breaker key, so a tripped breaker actually suppresses.
    assert.equal(
      canonicalServerId('mcp__Sanity'),
      canonicalServerId('mcp__Sanity__whoami'),
    );
  });
  test('a non-mcp token is rejected', () => {
    assert.equal(canonicalServerId('Read'), null);
    assert.equal(canonicalServerId('mcp__'), null);
  });
});

// A faithful stream-json fixture: an `assistant` tool_use followed by a `user`
// tool_result, then the final `result` line. Matches the empirical CLI shape.
function streamJson(
  calls: Array<{ id: string; tool: string; isError?: boolean; resultText?: string }>,
): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'system', subtype: 'init' }));
  for (const c of calls) {
    lines.push(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: c.id, name: c.tool, input: {} }] } }),
    );
    lines.push(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: c.id, is_error: c.isError === true, content: c.resultText ?? 'ok' },
          ],
        },
      }),
    );
  }
  lines.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ASSISTANT COMPLETE' }));
  return lines.join('\n');
}

describe('breaker accumulates from REAL stream-json tool events (the dead-wiring fix)', () => {
  test('a per-call MCP failure opens that server\'s breaker after the threshold', () => {
    // The whole point: a live spawn whose Slack call 503s, repeated, opens Slack's
    // breaker — using ONLY the structured tool events, never prose.
    const out = streamJson([{ id: 't1', tool: 'mcp__Slack__send_message', isError: true, resultText: 'HTTP 503 upstream' }]);
    for (let i = 0; i < THRESHOLD; i++) recordSpawnOutcome(out, { exitCode: 0 });
    assert.equal(isOpen('mcp__Slack'), true, 'Slack breaker must open from real tool-event signal');
  });

  test('a UUID-connector call failure opens the breaker on the UUID key', () => {
    const server = 'mcp__87a5b867-5c2d-4ac4-9fbf-333d78862c36';
    const out = streamJson([
      { id: 'u1', tool: `${server}__slack_send_message`, isError: true, resultText: 'socket hang up' },
    ]);
    for (let i = 0; i < THRESHOLD; i++) recordSpawnOutcome(out, { exitCode: 0 });
    assert.equal(isOpen(server), true);
  });

  test('a failed call and a successful call in one spawn only trip the failed server', () => {
    const out = streamJson([
      { id: 'a', tool: 'mcp__Slack__send_message', isError: true, resultText: 'HTTP 503' },
      { id: 'b', tool: 'mcp__Notion__search', isError: false, resultText: 'ok' },
    ]);
    for (let i = 0; i < THRESHOLD; i++) recordSpawnOutcome(out, { exitCode: 0 });
    assert.equal(isOpen('mcp__Slack'), true);
    assert.equal(isOpen('mcp__Notion'), false, 'a successful Notion call must not trip Notion');
  });

  test('a generic (no-signature) tool error counts as a transport failure', () => {
    const out = streamJson([{ id: 'g', tool: 'mcp__Drive__list', isError: true, resultText: 'Error: the tool failed' }]);
    const kind = recordSpawnOutcome(out, { exitCode: 0 });
    assert.equal(kind, 'transport', 'an error result with no auth signature still counts');
    assert.equal(getHealth('mcp__Drive').consecutive_failures, 1);
  });

  test('a tool_use with no paired tool_result (spawn died mid-call) counts as a failure', () => {
    // Only the assistant tool_use line, no user tool_result — the wedged-MCP case.
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__Slack__send_message', input: {} }] } }),
      JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '' }),
    ].join('\n');
    recordSpawnOutcome(out, { exitCode: 124 });
    assert.equal(getHealth('mcp__Slack').consecutive_failures, 1);
  });

  test('a successful stream-json spawn closes a half-open breaker', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < THRESHOLD; i++) recordFailure('mcp__Slack', 'transport', t0);
    const out = streamJson([{ id: 'ok', tool: 'mcp__Slack__read_channel', isError: false }]);
    const kind = recordSpawnOutcome(out, { exitCode: 0, now: t0 + COOLDOWN });
    assert.equal(kind, 'none');
    assert.equal(getHealth('mcp__Slack').state, 'closed');
  });

  test('caller-supplied events are preferred over re-parsing output', () => {
    const events = parseMcpToolEvents(
      streamJson([{ id: 'p', tool: 'mcp__Slack__send_message', isError: true, resultText: 'HTTP 401' }]),
    );
    const kind = recordSpawnOutcome('unrelated stripped result text', { exitCode: 0, events });
    assert.equal(kind, 'auth');
  });
});

describe('authFailedServers (reactive auth-healer routing, defect 3)', () => {
  test('returns only the servers whose calls 401\'d, from stream events', () => {
    const events = parseMcpToolEvents(
      streamJson([
        { id: 'a', tool: 'mcp__Calendar__list', isError: true, resultText: 'HTTP 401 Unauthorized' },
        { id: 'b', tool: 'mcp__Slack__send', isError: true, resultText: 'HTTP 503' },
        { id: 'c', tool: 'mcp__Notion__search', isError: false },
      ]),
    );
    assert.deepEqual(authFailedServers(events, ''), ['mcp__Calendar']);
  });

  test('falls back to the regex path when no events are present', () => {
    assert.deepEqual(
      authFailedServers([], 'mcp__Calendar__list_events → HTTP 401'),
      ['mcp__Calendar'],
    );
  });

  test('returns empty when there is no auth failure', () => {
    const events = parseMcpToolEvents(streamJson([{ id: 'a', tool: 'mcp__Slack__send', isError: true, resultText: 'HTTP 503' }]));
    assert.deepEqual(authFailedServers(events, ''), []);
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
    assert.equal(byId.get('mcp__claude_ai_Slack')?.withhold, false);
    assert.equal(byId.get('mcp__claude_ai_Google_Calendar')?.connected, false);
    assert.equal(byId.get('mcp__claude_ai_Google_Calendar')?.needsAuth, true);
    // Defect 4: a needs-auth server is NOT withheld by default — the spawn tries
    // and the reactive classifier catches a true 401.
    assert.equal(byId.get('mcp__claude_ai_Google_Calendar')?.withhold, false);
    assert.equal(byId.get('mcp__Sanity')?.connected, false);
    // A hard `✗ Failed to connect` IS withheld.
    assert.equal(byId.get('mcp__Sanity')?.withhold, true);
  });

  test('withholds a needs-auth server when withholdNeedsAuth is enabled', () => {
    const prior = config.settings.mcp.probe.withholdNeedsAuth;
    config.settings.mcp.probe.withholdNeedsAuth = true;
    try {
      const sample = `claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication\n`;
      const out = parseMcpHealth(sample);
      assert.equal(out[0]?.withhold, true);
    } finally {
      config.settings.mcp.probe.withholdNeedsAuth = prior;
    }
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

  test('withholds a probe-disconnected (hard-failed) server', () => {
    const probe = [
      { serverId: 'mcp__Slack', connected: true, needsAuth: false, withhold: false },
      { serverId: 'mcp__Notion', connected: false, needsAuth: false, withhold: true },
    ];
    const r = resolveWithheld(['mcp__Slack', 'mcp__Notion'], { probe });
    assert.deepEqual(r.allowed, ['mcp__Slack']);
    assert.equal(r.withheld[0]?.reason, 'probe-disconnected');
  });

  test('does NOT withhold a needs-auth server by default (let the spawn try)', () => {
    // Defect 4: the prior design reversed collect-everything by withholding any
    // needs-auth server. The reactive 401 classifier now handles a true failure, so
    // a needs-auth server (withhold=false from parseMcpHealth's default) stays in.
    const probe = [{ serverId: 'mcp__Calendar', connected: false, needsAuth: true, withhold: false }];
    const r = resolveWithheld(['mcp__Calendar'], { probe });
    assert.deepEqual(r.allowed, ['mcp__Calendar']);
    assert.equal(r.withheld.length, 0);
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
