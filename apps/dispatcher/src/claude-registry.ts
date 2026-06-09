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
 *
 * Each entry's content is JSON `{ class, taskId, at }` so the type-aware
 * concurrency model can count GIT vs ISO spawns precisely (a live pipeline's
 * coders are GIT-class and must be folded into the same Max-plan budget as the
 * ISO pool). Pre-existing plain-number files (the old format) and malformed
 * JSON degrade gracefully to class 'iso' with no taskId — they still count
 * toward liveness, they just can't be class-attributed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { TaskClass } from './concurrency.js';

export interface ClaudeMeta {
  class: TaskClass;
  taskId?: string;
}

interface RegistryEntry {
  class: TaskClass;
  taskId?: string;
  at: number;
}

function defaultDir(): string {
  return join(config.dataDir, 'run', 'claude');
}

export function registerClaude(
  pid: number,
  meta: ClaudeMeta = { class: 'iso' },
  dir: string = defaultDir(),
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const entry: RegistryEntry = {
      class: meta.class,
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
      at: Date.now(),
    };
    writeFileSync(join(dir, String(pid)), JSON.stringify(entry));
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

/**
 * Read an entry's class. A bare timestamp (legacy format) or any unparseable
 * content is treated as ISO with no task attribution — it still counts toward
 * liveness, just can't be class-split. Defaulting unknowns to ISO is the safe
 * choice: it never inflates the GIT count (which would wrongly block a GIT
 * spawn), and the ISO cap is a soft throughput limit, not a correctness gate.
 */
function readEntryClass(dir: string, file: string): TaskClass {
  try {
    const raw = readFileSync(join(dir, file), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RegistryEntry>;
    return parsed.class === 'git' ? 'git' : 'iso';
  } catch {
    return 'iso';
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

/**
 * Live Nyx-spawned claude count split by class; sweeps dead/malformed entries
 * exactly like {@link liveOwnClaudeCount}. The GIT count is the cross-tick
 * belt-and-suspenders behind {@link liveGitTaskExists}; the ISO count + the GIT
 * count together feed `effectiveIsoCap` so a coder-heavy pipeline phase and the
 * ISO pool never exceed the aggregate Max-plan ceiling.
 */
export function liveClaudeCountByClass(dir: string = defaultDir()): { git: number; iso: number } {
  if (!existsSync(dir)) return { git: 0, iso: 0 };
  let git = 0;
  let iso = 0;
  for (const f of readdirSync(dir)) {
    const pid = Number.parseInt(f, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      continue;
    }
    if (!alive(pid)) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      continue;
    }
    if (readEntryClass(dir, f) === 'git') git++;
    else iso++;
  }
  return { git, iso };
}
