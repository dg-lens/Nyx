import { existsSync, statSync } from 'node:fs';

import { readQueue, MINUTES_PER_SLOT } from '@nyx/dispatcher/dist/task-reader.js';
import type { ParsedTask } from '@nyx/dispatcher/dist/types.js';

import { config } from './config.js';

/**
 * Build the queue snapshot payload that goes into Supabase's queue_snapshot table.
 *
 * We only re-snapshot when nyx.md changes (mtime moves) — there's no point
 * pushing identical snapshots every poll cycle. Returns null if nothing changed
 * since the last call.
 */

let lastMtimeMs = 0;

interface TaskJson {
  id: string;
  description: string;
  type: ParsedTask['type'];
  model: ParsedTask['model'];
  gates: ParsedTask['gates'];
  priority: ParsedTask['priority'];
  repo?: string;
  output?: string;
  depends?: string[];
  checked: boolean;
  invalidTags: ParsedTask['invalidTags'];
  slot?: number;
  everySlots?: number;
  every?: string;
  completionLine?: string;
  completedAt?: string;
}

function everyLabel(stepSlots: number): string {
  const min = stepSlots * MINUTES_PER_SLOT;
  if (min < 60) return `${min}m`;
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

function extractCompletion(rawLines: string[]): { completionLine?: string; completedAt?: string } {
  for (const line of rawLines) {
    const m = line.match(/\[completed:\s*([^\]]+)\]/);
    if (m) {
      return { completionLine: line.trim(), completedAt: (m[1] ?? '').trim() };
    }
  }
  return {};
}

function toJson(t: ParsedTask): TaskJson {
  const completion = extractCompletion(t.rawLines);
  return {
    id: t.id,
    description: t.description,
    type: t.type,
    model: t.model,
    gates: t.gates,
    priority: t.priority,
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.output ? { output: t.output } : {}),
    ...(t.depends ? { depends: t.depends } : {}),
    checked: t.checked,
    invalidTags: t.invalidTags,
    ...(typeof t.slot === 'number' ? { slot: t.slot } : {}),
    ...(typeof t.everyStepSlots === 'number' ? { everySlots: t.everyStepSlots, every: everyLabel(t.everyStepSlots) } : {}),
    ...(completion.completionLine ? { completionLine: completion.completionLine } : {}),
    ...(completion.completedAt ? { completedAt: completion.completedAt } : {}),
  };
}

export function maybeBuildSnapshot(force = false): { active: TaskJson[]; completed: TaskJson[] } | null {
  if (!existsSync(config.queuePath)) return null;
  const mtime = statSync(config.queuePath).mtimeMs;
  if (!force && mtime <= lastMtimeMs) return null;
  lastMtimeMs = mtime;

  const q = readQueue(config.queuePath);
  return {
    active: q.active.map(toJson),
    completed: q.completed.map(toJson),
  };
}
