import { execFile, execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

import { config } from '../config.js';

const execFileP = promisify(execFile);

// ── Token file helpers ───────────────────────────────────────────────────

/**
 * Read a Bitwarden machine-account access token from disk. Enforces 600 perms.
 * Throws loudly if the file is world- or group-readable — these tokens grant
 * read access to every secret in their scoped project, treat them like
 * passwords.
 */
export function fetchMachineAccountToken(tokenPath: string): string {
  if (!existsSync(tokenPath)) {
    throw new Error(`Bitwarden machine-account token not found at ${tokenPath}`);
  }
  const stat = statSync(tokenPath);
  // POSIX mode bits — strip everything above 0o777, the lower 9 bits are perms.
  const mode = stat.mode & 0o777;
  // Reject any group/world access (0o077). Owner-only modes — 0600 and the
  // stricter 0400 — are both acceptable; pinning exactly 0600 would falsely
  // reject a hardened read-only token.
  if (mode & 0o077) {
    throw new Error(
      `Bitwarden token file ${tokenPath} has insecure perms ${mode.toString(8)} — ` +
        `must be owner-only (0600 or 0400). Run: chmod 600 ${tokenPath}`,
    );
  }
  return readFileSync(tokenPath, 'utf8').trim();
}

// ── bws CLI wrapper ──────────────────────────────────────────────────────

export interface RunWithSecretsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Invoke a command via `bws run --` so all secrets from the token's project
 * are exposed as environment variables to the child. The token is set as
 * `BWS_ACCESS_TOKEN` and is never logged or written to the audit DB.
 */
export function runWithSecrets(
  tokenPath: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<RunWithSecretsResult> {
  const token = fetchMachineAccountToken(tokenPath);
  return new Promise((resolve, reject) => {
    const child = spawn('bws', ['run', '--', ...args], {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...(opts.env ?? process.env),
        BWS_ACCESS_TOKEN: token,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.stderr?.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

// ── Org-admin REST: OAuth + project/machine-account creation ─────────────

export interface OrgCreds {
  client_id: string;
  client_secret: string;
}

/** Read the org-admin credentials JSON. Enforces 600 perms. */
export function loadOrgCreds(adminCredsPath: string): OrgCreds {
  if (!existsSync(adminCredsPath)) {
    throw new Error(`Bitwarden admin creds not found at ${adminCredsPath}`);
  }
  const mode = statSync(adminCredsPath).mode & 0o777;
  // Reject any group/world access (0o077); allow owner-only 0600 or 0400.
  if (mode & 0o077) {
    throw new Error(
      `Bitwarden admin creds file ${adminCredsPath} has insecure perms ${mode.toString(8)} — ` +
        `must be owner-only (0600 or 0400). Run: chmod 600 ${adminCredsPath}`,
    );
  }
  const raw = readFileSync(adminCredsPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<OrgCreds>;
  if (!parsed.client_id || !parsed.client_secret) {
    throw new Error(`${adminCredsPath} must contain client_id and client_secret`);
  }
  return { client_id: parsed.client_id, client_secret: parsed.client_secret };
}

interface CachedToken {
  bearer: string;
  /** epoch ms when this cached entry should no longer be served */
  expiresAt: number;
}
let orgTokenCache: CachedToken | null = null;

/**
 * OAuth2 client_credentials against identity.bitwarden.com.
 * Returns a bearer token usable for org-admin calls.
 * Cached for ~50 minutes (real tokens last 60 — keep 10 min headroom).
 */
export async function getOrgAccessToken(creds: OrgCreds, now: number = Date.now()): Promise<string> {
  if (orgTokenCache && orgTokenCache.expiresAt > now) {
    return orgTokenCache.bearer;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    scope: 'api.organization',
  });
  const res = await fetch('https://identity.bitwarden.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '<unreadable>');
    throw new Error(`Bitwarden OAuth failed: ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Bitwarden OAuth returned no access_token');
  const ttlSec = Math.max(60, (json.expires_in ?? 3600) - 600); // 10-min headroom
  orgTokenCache = { bearer: json.access_token, expiresAt: now + ttlSec * 1000 };
  return json.access_token;
}

/** For tests — reset the in-process cache. */
export function _resetOrgTokenCache(): void {
  orgTokenCache = null;
}

// ── Org-admin REST: project + machine account creation ───────────────────

export interface CreatedProject {
  projectId: string;
  name: string;
}
export interface CreatedMachineAccount {
  machineAccountId: string;
  accessToken: string;
  name: string;
}

/** POST a project to the Bitwarden org. Idempotent on name conflict (409). */
export async function createProject(
  bearer: string,
  organizationId: string,
  name: string,
): Promise<CreatedProject> {
  const res = await fetch(
    `${config.bitwardenApiBase}/projects?organizationId=${encodeURIComponent(organizationId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) {
    // A bearer that was valid-by-clock but revoked/rotated server-side returns
    // 401/403. Drop the cached bearer so the next getOrgAccessToken re-fetches a
    // fresh one instead of serving the dead token for the rest of its TTL.
    if (res.status === 401 || res.status === 403) _resetOrgTokenCache();
    const detail = await res.text().catch(() => '<unreadable>');
    throw new Error(`createProject(${name}) failed: ${res.status} — ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { id?: string; name?: string };
  if (!json.id) throw new Error(`createProject(${name}) returned no id`);
  return { projectId: json.id, name: json.name ?? name };
}

/**
 * Create a machine account inside the org, then create an access token scoped
 * to it and granted on `projectId`. Returns both ids and the access-token string.
 */
export async function createMachineAccount(
  bearer: string,
  organizationId: string,
  name: string,
  projectId: string,
): Promise<CreatedMachineAccount> {
  // Step 1: create the machine account
  const accountRes = await fetch(
    `${config.bitwardenApiBase}/service-accounts?organizationId=${encodeURIComponent(organizationId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
  );
  if (!accountRes.ok) {
    if (accountRes.status === 401 || accountRes.status === 403) _resetOrgTokenCache();
    const detail = await accountRes.text().catch(() => '<unreadable>');
    throw new Error(`createMachineAccount(${name}) failed: ${accountRes.status} — ${detail.slice(0, 300)}`);
  }
  const account = (await accountRes.json()) as { id?: string };
  if (!account.id) throw new Error('createMachineAccount returned no id');

  // Step 2: grant project access
  const grantRes = await fetch(
    `${config.bitwardenApiBase}/service-accounts/${account.id}/granted-policies`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ grantedProjectId: projectId, read: true, write: true }]),
    },
  );
  if (!grantRes.ok) {
    if (grantRes.status === 401 || grantRes.status === 403) _resetOrgTokenCache();
    const detail = await grantRes.text().catch(() => '<unreadable>');
    throw new Error(`grant project access for ${name} failed: ${grantRes.status} — ${detail.slice(0, 300)}`);
  }

  // Step 3: mint an access token for the machine account
  const tokenRes = await fetch(
    `${config.bitwardenApiBase}/service-accounts/${account.id}/access-tokens`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `${name}-token` }),
    },
  );
  if (!tokenRes.ok) {
    if (tokenRes.status === 401 || tokenRes.status === 403) _resetOrgTokenCache();
    const detail = await tokenRes.text().catch(() => '<unreadable>');
    throw new Error(`access-token mint for ${name} failed: ${tokenRes.status} — ${detail.slice(0, 300)}`);
  }
  const tokenJson = (await tokenRes.json()) as { clientSecret?: string };
  if (!tokenJson.clientSecret) throw new Error('access-token response missing clientSecret');
  return { machineAccountId: account.id, accessToken: tokenJson.clientSecret, name };
}

// ── Secret metadata listing (used by rotation watchdog) ──────────────────

export interface SecretMetadata {
  id: string;
  key: string;
  note?: string;
  createdAt?: string;
  revisionDate?: string;
}

/**
 * Fetch all secret key→value pairs for a project. Used by the spawn machinery
 * to inject secrets directly into the child's env, avoiding `bws run --` as
 * a process wrapper.
 *
 * Why this exists separately from runWithSecrets: `bws run -- claude -p "<long
 * prompt with shell metacharacters>"` was tripping bws's internal shell handler,
 * causing prompts with backticks/parens/quotes to fail with sh syntax errors
 * before Claude ever ran (see CHANGELOG v0.6.8). Pre-resolving the secrets and
 * injecting via Node's spawn env eliminates that whole class of failure: the
 * prompt argv goes through fork+exec only, never a shell.
 *
 * Trade-off: values live in Node memory briefly (in the returned map and in the
 * spawn options' env). They are never logged, audited, or written to disk —
 * Node's `spawn` passes env directly to the child process via execve.
 */
export function fetchProjectSecretValues(
  projectId: string,
  tokenPath: string,
): Record<string, string> {
  const token = fetchMachineAccountToken(tokenPath);
  const raw = execFileSync('bws', ['secret', 'list', projectId, '--output', 'json'], {
    env: { ...process.env, BWS_ACCESS_TOKEN: token },
    encoding: 'utf8',
    timeout: 10_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const s of parsed) {
    const o = s as Record<string, unknown>;
    const key = typeof o['key'] === 'string' ? o['key'] : null;
    const value = typeof o['value'] === 'string' ? o['value'] : null;
    if (key && value !== null) out[key] = value;
  }
  return out;
}

/**
 * List secret metadata for a project via `bws secret list --output json`.
 * Avoids leaking values into stdout (we only ask for the listing endpoint).
 */
export async function listSecretsWithMetadata(
  projectId: string,
  tokenPath: string,
): Promise<SecretMetadata[]> {
  const token = fetchMachineAccountToken(tokenPath);
  const { stdout } = await execFileP('bws', ['secret', 'list', projectId, '--output', 'json'], {
    env: { ...process.env, BWS_ACCESS_TOKEN: token },
    timeout: 10_000,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((s) => {
    const o = s as Record<string, unknown>;
    return {
      id: String(o['id'] ?? ''),
      key: String(o['key'] ?? ''),
      ...(typeof o['note'] === 'string' ? { note: o['note'] } : {}),
      ...(typeof o['creationDate'] === 'string' ? { createdAt: o['creationDate'] } : {}),
      ...(typeof o['revisionDate'] === 'string' ? { revisionDate: o['revisionDate'] } : {}),
    };
  });
}
