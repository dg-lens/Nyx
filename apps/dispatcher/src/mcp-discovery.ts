import { execFileSync } from 'node:child_process';

/**
 * Discover currently-configured MCP servers from the Claude CLI's perspective.
 *
 * v0.5 returns to an allowlist permission model (per the v0.5 handoff). The
 * Claude CLI's `--allowed-tools` flag is *exclusive* — listing tool names
 * whitelists ONLY those names. Wildcards like `mcp__*` are not documented
 * to work, and pasting them as literals would block every MCP call.
 *
 * Solution: run `claude mcp list`, parse the connected server names, and
 * build explicit `mcp__<sanitized-name>` entries for the allowlist. This
 * makes "give MCP access to assistant/analysis" a runtime-discovered
 * property rather than a hardcoded enumeration that drifts.
 *
 * Cached for the lifetime of the dispatcher process (one tick == one process).
 */

let cached: string[] | null = null;

function sanitize(name: string): string {
  // The Claude CLI registers MCPs with the literal display name as part of the
  // tool prefix, with spaces and dots replaced by underscores. Match that.
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

export function listMcpServers(): string[] {
  if (cached) return cached;
  try {
    // Intentional exception to the spawnWithTimeout / process-group-kill
    // invariant (apps/dispatcher/src/spawn-helpers.ts). That helper exists for
    // long-running async `claude -p` task spawns whose tool-invocation
    // grandchildren hold pipe FDs open and cause duration overshoots when only
    // the direct child is signalled. `claude mcp list` is a short, synchronous,
    // tightly-bounded discovery call (10s hard timeout, no streaming tool use,
    // no grandchildren) run once per dispatcher process. A synchronous
    // process-group variant would add complexity with no practical benefit at
    // this bound, so this site is deliberately left on execFileSync.
    const out = execFileSync('claude', ['mcp', 'list'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    cached = parseMcpList(out);
  } catch (err) {
    // Don't crash the dispatcher if `claude mcp list` is slow / misconfigured.
    // Empty list means assistant tasks get the base READ_ONLY allowlist only.
    console.warn('[mcp-discovery] claude mcp list failed:', (err as Error).message);
    cached = [];
  }
  return cached;
}

/**
 * Parse `claude mcp list` output. Lines look like:
 *   "claude.ai Slack: https://mcp.slack.com/mcp - ✓ Connected"
 *   "Sanity: https://mcp.sanity.io (HTTP) - ✓ Connected"
 *   "claude.ai Google Calendar: https://... - ! Needs authentication"
 *
 * We collect every entry regardless of connection status — the allowlist
 * should reflect what the CLI is configured for, not which ones happen to
 * be authenticated this minute. An unauthenticated MCP returns an error
 * when called, which is preferable to silently denying via the allowlist.
 */
export function parseMcpList(out: string): string[] {
  const names: string[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Checking MCP')) continue;
    // "name: <url> - status"
    const m = line.match(/^(.+?):\s+https?:\/\//);
    if (!m || !m[1]) continue;
    names.push(`mcp__${sanitize(m[1])}`);
  }
  return names;
}

/** For tests — clear the in-process cache. */
export function _resetCache(): void {
  cached = null;
}
