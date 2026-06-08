/**
 * Registry of Nyx-spawned `claude` PIDs, so the concurrency guard can count only
 * OUR processes ('own' mode) instead of every claude on the box ('global').
 *
 * Why: a global `ps` scan trips on any unrelated `claude -p` — e.g. a co-located
 * pm2 swarm from another agent system — and makes Nyx skip every tick forever.
 * The dispatch lockfile already serializes Nyx's own ticks; 'own' mode adds
 * detection of a LEAKED Nyx claude (a crashed tick that left a child running)
 * without seeing foreign processes.
 *
 * File-per-PID under <dataDir>/run/claude (touch on spawn, unlink on exit). The
 * count verifies liveness with `kill(pid, 0)` so a stale file from a crashed
 * spawn is ignored and swept — a stale entry can never wedge the guard.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

function defaultDir(): string {
  return join(config.dataDir, 'run', 'claude');
}

export function registerClaude(pid: number, dir: string = defaultDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, String(pid)), String(Date.now()));
  } catch {
    /* best-effort: registry is an optimization, never block a spawn */
  }
}

export function deregisterClaude(pid: number, dir: string = defaultDir()): void {
  try {
    unlinkSync(join(dir, String(pid)));
  } catch {
    /* already gone */
  }
}

function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Live Nyx-spawned claude count; sweeps dead/malformed registry entries. */
export function liveOwnClaudeCount(dir: string = defaultDir()): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const pid = Number.parseInt(f, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      continue;
    }
    if (alive(pid)) n++;
    else { try { unlinkSync(join(dir, f)); } catch { /* ignore */ } }
  }
  return n;
}
