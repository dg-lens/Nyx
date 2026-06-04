/**
 * Gather composer input context for a task: ancestor flight plans + actual git
 * diffs of those ancestors against their parent commits.
 *
 * Per operator decision 5: stage-0 scope is immediate `[depends:]` parents
 * only — not the full ancestor closure. Keeps the composer prompt bounded
 * and mirrors the dependency graph the operator already declared.
 */

import { execSync } from 'node:child_process';

import type { ParsedTask } from '../types.js';
import { getLatestFlightPlan } from './db.js';
import type { FlightPlan } from './types.js';

const MAX_DIFF_BYTES = 50_000;

export interface AncestorContext {
  task_id: string;
  /** null if no plan was recorded (legacy task, or plan emission failed). */
  plan: FlightPlan | null;
  /** null if no commit can be located for this task ID. */
  actual_diff: string | null;
}

/**
 * Find the most recent commit whose subject contains the task ID. Nyx's
 * commit message convention (per CHANGELOG hygiene rule in T2) includes the
 * task ID in the subject line. Best-effort — returns null if no commit matches.
 */
function findCommitForTask(workingDir: string, taskId: string): string | null {
  try {
    // Use --format=%H so we get just the SHA. --grep matches against subject+body.
    // -n 1 keeps it fast; we want the most recent commit for this task.
    const out = execSync(`git log --all --format=%H -n 1 --grep="${taskId}"`, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Diff for an ancestor's commit against its first parent. Truncated to
 * MAX_DIFF_BYTES so the composer prompt stays bounded; large diffs are
 * rare in single-task changesets but a runaway codemod task could blow
 * the context window otherwise.
 */
function diffForTask(workingDir: string, taskId: string): string | null {
  const sha = findCommitForTask(workingDir, taskId);
  if (!sha) return null;
  try {
    const out = execSync(`git diff ${sha}^ ${sha}`, {
      cwd: workingDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (out.length > MAX_DIFF_BYTES) {
      return `${out.slice(0, MAX_DIFF_BYTES)}\n[...truncated ${out.length - MAX_DIFF_BYTES} bytes]`;
    }
    return out;
  } catch {
    return null;
  }
}

export function gatherAncestorContext(task: ParsedTask, workingDir: string): AncestorContext[] {
  const deps = task.depends ?? [];
  return deps.map((ancestorId) => ({
    task_id: ancestorId,
    plan: getLatestFlightPlan(ancestorId),
    actual_diff: diffForTask(workingDir, ancestorId),
  }));
}
