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
 * Each entry's content is JSON `{ class, taskId, at }`. The class/taskId are
 * recorded for audit/diagnostic value; the live AGGREGATE count is what the
 * budget math consumes (effectiveIsoCap and the pipeline coder cap both subtract
 * the total live spawns from maxConcurrentClaude — a coder and a digest cost the
 * same one Max-plan slot regardless of class). Pre-existing plain-number files
 * (the old format) and malformed JSON still count toward liveness; they just
 * carry no class/taskId attribution.
 */
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * Live Nyx-spawned claude count (aggregate, all classes); sweeps dead/malformed
 * registry entries. This is the single number the budget math consumes:
 * effectiveIsoCap and the pipeline coder cap both subtract it from
 * maxConcurrentClaude so the ISO pool + the GIT task's spawn + a pipeline's
 * coders share one Max-plan ceiling.
 */
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
