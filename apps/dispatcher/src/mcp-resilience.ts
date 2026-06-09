import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { audit } from './audit.js';
import { config } from './config.js';
import { openDb } from './db.js';

/**
 * MCP-plane operational resilience (G-D / wave-stack-2 theme B).
 *
 * The structural problem this solves: Nyx spawns a fresh `claude -p` per tick, so
 * the MCP tool plane is COLD on every spawn. Every standard resilience primitive —
 * circuit breaker, health-check rolling window, reconnect/backoff — assumes a
 * long-lived client that accumulates state across calls. A breaker that tripped in
 * a sibling spawn five minutes ago is gone the next tick. The fix the field
 * converged on (Octopus, Google Cloud "MCP Reliability Playbook", IBM
 * mcp-context-forge): keep the resilience state OUTSIDE the spawned process —
 * here, in nyx.db, the one substrate every tick shares.
 *
 * This module owns four out-of-process concerns, all best-effort / non-fatal (a
 * throw here must never crash the dispatch tick):
 *   1. a SQLite-backed circuit breaker per MCP server (generalizes the documented
 *      SUPABASE_URL "3 consecutive 404s → breaker opens" rule to the MCP plane),
 *   2. a pre-spawn readiness probe so a task isn't spawned against a dead MCP,
 *   3. a proactive auth-healer that flags credentials at/over their TTL,
 *   4. per-tool policy resolution (auto | ask | deny) from settings.mcp.policy.
 *
 * The breaker table is MUTABLE state, NOT hash-chained — but every state TRANSITION
 * (open/close) emits an audit event so the immutable chain still records the
 * decision that suppressed an MCP. Mirrors secrets/db-schema.ts.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface ServerHealthRow {
  server_id: string;
  state: BreakerState;
  consecutive_failures: number;
  opened_at: number | null;
  last_probe_at: number | null;
  last_failure_kind: string | null;
}

/**
 * Classification of an MCP failure observed in a spawn's output. `auth` (401/403,
 * including the dominant "auth error returned as an HTTP-200 tool result" shape)
 * routes to the auth-healer + an operator halt because the generic Opus diagnostic
 * cannot drive a browser re-auth flow; `transport` (timeout, connection refused,
 * 5xx) is what the breaker counts toward opening; `none` means no MCP failure was
 * detected.
 */
export type McpFailureKind = 'auth' | 'transport' | 'none';

/** Per-tool permission disposition, mirrors the Agent SDK's allow/ask/deny engine. */
export type McpPolicy = 'auto' | 'ask' | 'deny';

let db: DatabaseSync | null = null;

/** For tests — swap in an in-memory or alternate-path DB (mirrors _setAuditDb). */
export function _setHealthDb(newDb: DatabaseSync | null): void {
  db = newDb;
}

function open(): DatabaseSync {
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  // Idempotent CREATE TABLE IF NOT EXISTS on every open so a test-injected
  // in-memory DB (via _setHealthDb) gets the schema without manual setup —
  // mirrors audit.ts's open().
  ensureSchema(db);
  return db;
}

function ensureSchema(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS mcp_server_health (
      server_id            TEXT    PRIMARY KEY,
      state                TEXT    NOT NULL DEFAULT 'closed',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      opened_at            INTEGER,
      last_probe_at        INTEGER,
      last_failure_kind    TEXT
    );
  `);
}

/**
 * Read a server's breaker row, materializing a default closed row for a server
 * never seen before. Pure read — does NOT advance the half-open transition (that
 * is `effectiveState`'s job, so reads stay side-effect-free for tests).
 */
export function getHealth(serverId: string): ServerHealthRow {
  const d = open();
  const row = d
    .prepare(`SELECT * FROM mcp_server_health WHERE server_id = ?`)
    .get(serverId) as ServerHealthRow | undefined;
  return (
    row ?? {
      server_id: serverId,
      state: 'closed',
      consecutive_failures: 0,
      opened_at: null,
      last_probe_at: null,
      last_failure_kind: null,
    }
  );
}

/**
 * The breaker's CURRENT effective state, applying the cooldown transition
 * open → half-open lazily on read. We don't run a timer to flip an open breaker;
 * instead, the first read after `cooldownMs` has elapsed since `opened_at`
 * reports half-open (one probe is allowed; success closes, failure re-opens).
 * Aligning the read-time transition to a tick boundary is exactly the IBM
 * mcp-context-forge "reset to a tick" guidance — there is no out-of-band timer.
 */
export function effectiveState(serverId: string, now: number = Date.now()): BreakerState {
  const h = getHealth(serverId);
  if (h.state === 'open' && h.opened_at != null) {
    const cooldownMs = config.settings.mcp.breaker.cooldownMs;
    if (now - h.opened_at >= cooldownMs) return 'half-open';
  }
  return h.state;
}

/** True when a required server's breaker is OPEN (not half-open) right now. */
export function isOpen(serverId: string, now: number = Date.now()): boolean {
  return effectiveState(serverId, now) === 'open';
}

function upsert(row: ServerHealthRow): void {
  const d = open();
  d.prepare(
    `INSERT INTO mcp_server_health
       (server_id, state, consecutive_failures, opened_at, last_probe_at, last_failure_kind)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       state = excluded.state,
       consecutive_failures = excluded.consecutive_failures,
       opened_at = excluded.opened_at,
       last_probe_at = excluded.last_probe_at,
       last_failure_kind = excluded.last_failure_kind`,
  ).run(
    row.server_id,
    row.state,
    row.consecutive_failures,
    row.opened_at,
    row.last_probe_at,
    row.last_failure_kind,
  );
}

/**
 * Record a successful interaction with a server: clears the failure count and,
 * if the breaker was open/half-open, CLOSES it and emits `task.mcp.breaker_closed`.
 * Idempotent — a success on an already-closed breaker just resets the counter.
 */
export function recordSuccess(serverId: string, now: number = Date.now()): void {
  const h = getHealth(serverId);
  const wasOpen = h.state !== 'closed';
  upsert({
    server_id: serverId,
    state: 'closed',
    consecutive_failures: 0,
    opened_at: null,
    last_probe_at: now,
    last_failure_kind: null,
  });
  if (wasOpen) {
    audit('task.mcp.breaker_closed', 'mcp-resilience', { server: serverId, prior_state: h.state });
  }
}

/**
 * Record a failed interaction. Increments the consecutive-failure counter and
 * OPENS the breaker (emitting `task.mcp.breaker_opened`) once it crosses the
 * configured threshold. A failure observed while half-open re-opens immediately —
 * the probe that was allowed through failed, so the cooldown restarts.
 *
 * `kind` is stored so the readiness/heal path can distinguish an auth failure
 * (needs operator re-auth) from a transport failure (will likely self-heal).
 */
export function recordFailure(
  serverId: string,
  kind: Exclude<McpFailureKind, 'none'> = 'transport',
  now: number = Date.now(),
): void {
  const h = getHealth(serverId);
  const eff = effectiveState(serverId, now);
  const threshold = config.settings.mcp.breaker.failureThreshold;
  const failures = eff === 'half-open' ? threshold : h.consecutive_failures + 1;
  const shouldOpen = failures >= threshold;
  const wasOpen = h.state === 'open';
  upsert({
    server_id: serverId,
    state: shouldOpen ? 'open' : 'closed',
    consecutive_failures: failures,
    opened_at: shouldOpen ? now : null,
    last_probe_at: now,
    last_failure_kind: kind,
  });
  if (shouldOpen && !wasOpen) {
    audit('task.mcp.breaker_opened', 'mcp-resilience', {
      server: serverId,
      consecutive_failures: failures,
      failure_kind: kind,
    });
  }
}

/**
 * Classify an MCP failure from spawn output, keyed on MACHINE signatures (never
 * free-text prose — mirrors detectRateLimit's discipline so a task whose job is to
 * implement auth/401 handling doesn't misclassify its OWN output).
 *
 * Auth: a `WWW-Authenticate` header, `invalid_grant`/`insufficient_scope`/
 * `token_expired` OAuth error codes, or an `HTTP 401`/`HTTP 403` status token —
 * INCLUDING the dominant real-world shape where the auth error is returned as a
 * tool result body, not an HTTP status (we match the OAuth error codes regardless
 * of the surrounding HTTP framing). Transport: `HTTP 5xx`, `ECONNREFUSED`,
 * `ETIMEDOUT`, `socket hang up`, or an MCP `connection closed`/`server disconnected`.
 */
export function classifyMcpFailure(output: string): McpFailureKind {
  const authSignature =
    /\bwww-authenticate\b/i.test(output) ||
    /\b(invalid_grant|insufficient_scope|token[_-]?expired|invalid_token)\b/i.test(output) ||
    /\bhttp\b[^\n]{0,6}\b(401|403)\b/i.test(output);
  if (authSignature) return 'auth';
  const transportSignature =
    /\bhttp\b[^\n]{0,6}\b5\d{2}\b/i.test(output) ||
    /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/.test(output) ||
    /socket hang up/i.test(output) ||
    /\bmcp\b[^\n]{0,40}\b(connection closed|server disconnected|not connected|failed to connect)\b/i.test(output);
  if (transportSignature) return 'transport';
  return 'none';
}

/**
 * Connection status of one MCP server as reported by `claude mcp list`. Lines:
 *   "claude.ai Slack: https://mcp.slack.com/mcp - ✓ Connected"
 *   "claude.ai Google Calendar: https://... - ! Needs authentication"
 *   "Sanity: https://mcp.sanity.io (HTTP) - ✗ Failed to connect"
 */
export interface McpProbeStatus {
  /** The `mcp__<sanitized-name>` allowlist token (matches mcp-discovery's shape). */
  serverId: string;
  connected: boolean;
  needsAuth: boolean;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Parse `claude mcp list` output into per-server connection status. Pure — the
 * IO (running the CLI) is in `probeReadiness` so this stays unit-testable.
 */
export function parseMcpHealth(out: string): McpProbeStatus[] {
  const statuses: McpProbeStatus[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('Checking MCP')) continue;
    const m = line.match(/^(.+?):\s+https?:\/\/(.*)$/);
    if (!m || !m[1]) continue;
    const tail = (m[2] ?? '').toLowerCase();
    const connected = /✓|\bconnected\b/.test(tail) && !/✗|✘|failed|disconnect/.test(tail);
    const needsAuth = /needs authentication|not authenticated|! auth/i.test(tail);
    statuses.push({ serverId: `mcp__${sanitize(m[1])}`, connected, needsAuth });
  }
  return statuses;
}

/**
 * Run the readiness probe: a single cheap `claude mcp list` round-trip whose
 * connection-status column tells us which servers are live RIGHT NOW. Bounded by
 * a hard timeout (the probe must never become the hang it prevents). Any failure
 * to run the CLI returns an empty list — fail-OPEN on the probe itself (we don't
 * suppress every MCP just because the probe couldn't run), since the breaker is
 * the authoritative suppression source. Cached per dispatcher process (one tick).
 */
let probeCache: McpProbeStatus[] | null = null;

export function probeReadiness(): McpProbeStatus[] {
  if (probeCache) return probeCache;
  try {
    const out = execFileSync('claude', ['mcp', 'list'], {
      encoding: 'utf8',
      timeout: config.settings.mcp.probe.timeoutMs,
    });
    probeCache = parseMcpHealth(out);
  } catch (err) {
    console.warn('[mcp-resilience] readiness probe failed:', (err as Error).message);
    probeCache = [];
  }
  return probeCache;
}

/** For tests — clear the per-process probe cache. */
export function _resetProbeCache(): void {
  probeCache = null;
}

/**
 * The set of MCP servers (as `mcp__<server>` allowlist tokens) that should be
 * WITHHELD from a spawn this tick, with the reason. A server is withheld when its
 * breaker is OPEN, or — when the readiness probe ran — when the probe reports it
 * disconnected. Half-open is NOT withheld: the spawn is the probe that may close
 * the breaker.
 *
 * `availableServers` is the discovered allowlist (mcp-discovery.listMcpServers()).
 * We only ever withhold from that set, never invent server ids.
 */
export interface WithholdResult {
  /** Servers to KEEP in the allowlist. */
  allowed: string[];
  /** Servers withheld + why, for the audit trail. */
  withheld: Array<{ server: string; reason: 'breaker-open' | 'probe-disconnected' }>;
}

export function resolveWithheld(
  availableServers: string[],
  opts: { probe?: McpProbeStatus[]; now?: number } = {},
): WithholdResult {
  const now = opts.now ?? Date.now();
  const probe = opts.probe;
  const probeByid = new Map((probe ?? []).map((p) => [p.serverId, p]));
  const allowed: string[] = [];
  const withheld: WithholdResult['withheld'] = [];
  for (const server of availableServers) {
    if (isOpen(server, now)) {
      withheld.push({ server, reason: 'breaker-open' });
      continue;
    }
    // Only trust the probe when it actually observed this server. A server the
    // probe didn't list (probe failed, or CLI doesn't report it) is left in —
    // the breaker is the authoritative suppressor, the probe is best-effort.
    const p = probeByid.get(server);
    if (p && !p.connected) {
      withheld.push({ server, reason: 'probe-disconnected' });
      continue;
    }
    allowed.push(server);
  }
  return { allowed, withheld };
}

/**
 * Extract the `mcp__<server>` tokens an agent's output actually exercised, by
 * scanning for the `mcp__<server>__<tool>` tool-call shape the CLI surfaces.
 * Returns the SERVER-level tokens (deduped) so breaker bookkeeping is attributed
 * to the right server, not the individual tool.
 */
export function serversReferencedIn(output: string): string[] {
  const seen = new Set<string>();
  const re = /\bmcp__([A-Za-z0-9_]+?)__[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    if (m[1]) seen.add(`mcp__${m[1]}`);
  }
  return [...seen];
}

/**
 * Post-spawn breaker bookkeeping for an assistant/analysis task. Classifies the
 * spawn output for an MCP failure and updates the breaker for every server the
 * output referenced:
 *   - failure detected → recordFailure(kind) for each referenced server (opens the
 *     breaker once the threshold is crossed),
 *   - no failure AND the spawn exited cleanly → recordSuccess for each referenced
 *     server (closes a half-open breaker, resets the counter).
 *
 * Returns the classified failure kind so the caller can route an auth failure to
 * the operator-action path. Best-effort: this is bookkeeping, never fatal.
 *
 * Why attribute to "referenced" servers rather than all discovered: a Slack
 * timeout shouldn't trip the Notion breaker. The output naming `mcp__slack__…` is
 * the only signal available out-of-process about which server was in play.
 */
export function recordSpawnOutcome(
  output: string,
  opts: { exitCode: number; now?: number } = { exitCode: 0 },
): McpFailureKind {
  const now = opts.now ?? Date.now();
  const kind = classifyMcpFailure(output);
  const servers = serversReferencedIn(output);
  if (kind !== 'none') {
    for (const s of servers) recordFailure(s, kind, now);
  } else if (opts.exitCode === 0) {
    for (const s of servers) recordSuccess(s, now);
  }
  return kind;
}

/**
 * Per-tool policy resolution from settings.mcp.policy. The map is keyed by either
 * a full tool token (`mcp__server__tool`) or a server prefix (`mcp__server`);
 * the most specific match wins. Unlisted tools fall back to settings.mcp.policy
 * `defaultPolicy`. For a headless `claude -p` (no human at the keyboard) the
 * enforced posture is: `auto` → keep in the allowlist; `deny` → drop entirely;
 * `ask` → drop from the live allowlist AND mark for escalation (an ask-classed
 * write tool reified as Nyx's halt path — see run-once wiring).
 */
export interface PolicyDecision {
  server: string;
  policy: McpPolicy;
}

export function resolvePolicy(serverOrTool: string): McpPolicy {
  const map = config.settings.mcp.policy.tools;
  // Exact tool token wins, then the longest matching server prefix.
  if (map[serverOrTool]) return map[serverOrTool] as McpPolicy;
  let best: { len: number; policy: McpPolicy } | null = null;
  for (const [key, val] of Object.entries(map)) {
    if (serverOrTool === key || serverOrTool.startsWith(`${key}__`)) {
      if (!best || key.length > best.len) best = { len: key.length, policy: val as McpPolicy };
    }
  }
  return best?.policy ?? config.settings.mcp.policy.defaultPolicy;
}

/**
 * Apply per-server policy to a list of `mcp__<server>` tokens, returning the set
 * to keep (`auto`) and the sets dropped by `deny`/`ask`. Server-granularity is
 * what `permissionArgs` operates on (the allowlist enumerates servers, not
 * individual tools), so policy is resolved per server token here.
 */
export interface PolicyResult {
  allowed: string[];
  denied: string[];
  ask: string[];
}

export function applyPolicy(servers: string[]): PolicyResult {
  const allowed: string[] = [];
  const denied: string[] = [];
  const ask: string[] = [];
  for (const s of servers) {
    const p = resolvePolicy(s);
    if (p === 'deny') denied.push(s);
    else if (p === 'ask') ask.push(s);
    else allowed.push(s);
  }
  return { allowed, denied, ask };
}
