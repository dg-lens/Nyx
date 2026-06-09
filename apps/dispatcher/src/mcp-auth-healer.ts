import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { audit } from './audit.js';
import { config } from './config.js';
import { openDb } from './db.js';

/**
 * Proactive MCP auth-healer (G-D finding 15).
 *
 * The failure this attacks: an OAuth token for an MCP server expires at slot N;
 * a 401 surfaces mid-spawn as a generic tool error, the agent drifts, and the
 * spawn dies at the 30-min wall clock (exit 124). The SecureCoders 14-client
 * audit found ZERO clients implement the spec'd silent refresh, so reactive
 * on-401 is the steady-state break, not an exception. Reactive refresh also
 * "fails the first time fifty agents wake at 8am" (thundering herd on expiry).
 *
 * SCOPE HONESTY — what this module actually does, and what it does NOT.
 *
 * Nyx does NOT own the host's `claude mcp` OAuth flow: the Claude CLI manages the
 * claude.ai connector connections and their browser re-auth, and `claude mcp list`
 * reports only connected / needs-auth — never a token expiry. So Nyx CANNOT learn
 * a connector's TTL out-of-process, which means the purely-PROACTIVE "refresh at
 * 80% of the TTL window" path has no data source for those connectors and would be
 * a no-op (the original dead-wiring defect: `mcp_credentials` was never populated,
 * so `classifyAuth` returned `unknown` for everything and `healAuth` flagged
 * nothing). We do NOT pretend otherwise.
 *
 * What this module genuinely does, REACTIVELY, is the load-bearing half:
 *   (a) when a spawn's stream-json shows an MCP call failing with an auth signature
 *       (401/403/invalid_grant/…), `recordAuthFailure` marks that server's
 *       credential EXPIRED in `mcp_credentials` — giving the TTL classifier real
 *       data for the first time;
 *   (b) the NEXT tick's pre-spawn `healAuth` then sees that server as `expired` and
 *       emits `task.mcp.auth_stale`, and the caller (run-once) reifies it as a
 *       structured operator-action halt — because the generic Opus diagnostic
 *       cannot drive a browser re-auth, so a plain failure would just burn an audit
 *       pass.
 *
 * The PROACTIVE-TTL path (`classifyAuth` → `stale`, `recordCredential` with a real
 * `ttlMs`/`expiresAt`, `persistToken`) is RETAINED but only fires for MCPs whose
 * token Nyx genuinely controls and was told the TTL of (the per-server token files
 * under ~/.config at chmod 600, mirroring the bitwarden/<project>.token convention).
 * For everything else the reactive path above is the real mechanism. This is the
 * narrowing the directive asked for: no dead proactive claim, the reactive route is
 * wired and used.
 */

export interface CredentialState {
  server_id: string;
  /** Absolute epoch-ms expiry. null = unknown TTL (never proactively refreshed). */
  expires_at: number | null;
  last_refreshed_at: number | null;
}

export type AuthHealth = 'fresh' | 'stale' | 'expired' | 'unknown';

let db: DatabaseSync | null = null;

/** For tests — swap the credential-state DB. */
export function _setAuthDb(newDb: DatabaseSync | null): void {
  db = newDb;
}

function open(): DatabaseSync {
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  // Idempotent so a test-injected DB (via _setAuthDb) is schema-ready.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_credentials (
      server_id         TEXT PRIMARY KEY,
      expires_at        INTEGER,
      last_refreshed_at INTEGER
    );
  `);
  return db;
}

export function getCredential(serverId: string): CredentialState | null {
  const d = open();
  return (
    (d.prepare(`SELECT * FROM mcp_credentials WHERE server_id = ?`).get(serverId) as
      | CredentialState
      | undefined) ?? null
  );
}

/**
 * Record a credential's absolute expiry (e.g. after a successful refresh, or when
 * the operator registers a token). `ttlMs` is convenience: when given, expiry is
 * `now + ttlMs`. Persists the per-server token state.
 */
export function recordCredential(
  serverId: string,
  opts: { expiresAt?: number; ttlMs?: number; now?: number },
): void {
  const d = open();
  const now = opts.now ?? Date.now();
  const expiresAt = opts.expiresAt ?? (opts.ttlMs != null ? now + opts.ttlMs : null);
  d.prepare(
    `INSERT INTO mcp_credentials (server_id, expires_at, last_refreshed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       expires_at = excluded.expires_at,
       last_refreshed_at = excluded.last_refreshed_at`,
  ).run(serverId, expiresAt, now);
}

/**
 * REACTIVE auth-failure record. Called when a spawn's stream-json showed an MCP
 * call failing with an auth signature (recordSpawnOutcome returned `auth`). Marks
 * that server's credential EXPIRED so the next tick's `healAuth` flags it and the
 * caller routes it to the operator-action path. THIS is what gives the otherwise-
 * un-fed TTL classifier real data — without it `mcp_credentials` stays empty and
 * the whole auth-healer is a no-op (the defect). Best-effort, never throws on a
 * caller's hot path: a DB error is swallowed (the breaker still suppressed the
 * server, so the reactive route degrades gracefully to breaker-only).
 *
 * Setting `expires_at = now` (not now-1) makes the very next `classifyAuth` at any
 * `now' >= now` report `expired`; we set `last_refreshed_at` to null so the
 * proactive-window math can't later mistake this forced-expiry for a fresh anchor.
 */
export function recordAuthFailure(serverId: string, now: number = Date.now()): void {
  try {
    const d = open();
    d.prepare(
      `INSERT INTO mcp_credentials (server_id, expires_at, last_refreshed_at)
       VALUES (?, ?, NULL)
       ON CONFLICT(server_id) DO UPDATE SET
         expires_at = excluded.expires_at,
         last_refreshed_at = NULL`,
    ).run(serverId, now);
  } catch {
    /* reactive bookkeeping is best-effort; the breaker is the hard suppressor */
  }
}

/**
 * Classify a credential's freshness against its TTL window.
 *
 * `unknown` (no recorded expiry) is treated as fresh for gating — Nyx never saw a
 * TTL, so it can't claim staleness; the breaker + reactive 401 classifier catch a
 * genuinely-dead one. `stale` means past `refreshAtFraction` of the way to expiry
 * but not yet expired (the proactive-refresh window — the 80%-TTL point). `expired`
 * means past `expires_at`.
 */
export function classifyAuth(serverId: string, now: number = Date.now()): AuthHealth {
  const cred = getCredential(serverId);
  if (!cred || cred.expires_at == null) return 'unknown';
  if (now >= cred.expires_at) return 'expired';
  // refreshAtFraction of the window between last refresh and expiry. Without a
  // last_refreshed_at anchor, fall back to a fixed lead time before expiry.
  const frac = config.settings.mcp.auth.refreshAtFraction;
  const anchor = cred.last_refreshed_at ?? cred.expires_at - config.settings.mcp.auth.defaultTtlMs;
  const window = cred.expires_at - anchor;
  const refreshAt = anchor + window * frac;
  return now >= refreshAt ? 'stale' : 'fresh';
}

/**
 * Path to a per-server MCP token file, mirroring ~/.config/bitwarden/<project>.token.
 * The directory is created 0700 and files are written 0600 — credentials never
 * land world-readable.
 */
export function tokenPathFor(serverId: string): string {
  const dir = join(homedir(), '.config', 'nyx', 'mcp-tokens');
  return join(dir, `${serverId.replace(/[^A-Za-z0-9_-]/g, '_')}.token`);
}

/**
 * Atomically persist a refreshed token value to its per-server file (temp + rename),
 * chmod 600. Used by a refresh path that DOES obtain a new token headlessly. The
 * rename is atomic on the same filesystem, so a concurrent reader sees either the
 * old or the new file, never a torn write.
 */
export function persistToken(serverId: string, value: string): void {
  const path = tokenPathFor(serverId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, value);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * The proactive heal decision for a set of required servers, before a spawn.
 * Returns the servers whose credentials are stale/expired and need attention.
 * For each, emits `task.mcp.auth_stale` so the operator-action path can act.
 *
 * Best-effort and headless-honest: we do NOT attempt an interactive browser
 * re-auth here (there's no human). A stale/expired credential is surfaced to the
 * caller, which (in run-once) reifies it as the structured operator halt — the
 * generic Opus diagnostic can't drive a browser flow, so a plain failure would
 * just burn an audit pass. Returns the stale set so the caller decides whether to
 * defer/downgrade/halt.
 */
export interface AuthHealResult {
  /** Servers whose credentials are stale or expired (need re-auth). */
  needsAuth: Array<{ server: string; health: 'stale' | 'expired' }>;
}

export function healAuth(
  requiredServers: string[],
  opts: { taskId?: string; now?: number } = {},
): AuthHealResult {
  const now = opts.now ?? Date.now();
  const needsAuth: AuthHealResult['needsAuth'] = [];
  for (const server of requiredServers) {
    const health = classifyAuth(server, now);
    if (health === 'stale' || health === 'expired') {
      needsAuth.push({ server, health });
      audit('task.mcp.auth_stale', 'mcp-auth-healer', {
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        server,
        health,
      });
    }
  }
  return { needsAuth };
}
