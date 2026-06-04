/**
 * nyx-resume <TASK-ID> [--note "free text"] [--keep-worktree]
 *
 * Operator command that clears a `task.halted_for_review` state so the
 * dispatcher will pick the task up again on the next tick.
 *
 * What it does:
 *   1. Verifies the task is currently halted (emits an explanatory message
 *      and exits non-zero if not).
 *   2. Tears down the preserved working dir (clone in /tmp/nyx-clone-<id>
 *      and/or worktree in worktrees/<id>) so the retry is fresh, unless
 *      --keep-worktree is passed.
 *   3. Emits `task.failure_reset` with the optional --note as reason. This
 *      both clears the failure counter AND the audit-pass counter (both keyed
 *      on the most recent reset).
 *   4. Emits `task.resumed` so the dispatcher's halt filter clears.
 *
 * The next launchd tick (or `nyx-tick.sh`) will then pick the task up
 * fresh. The audit phase still applies on subsequent failures — only the
 * counter resets, not the audit-on-fail behavior itself.
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  audit,
  isTaskHalted,
  resetFailureCount,
} from '../audit.js';
import { config } from '../config.js';

function parseArgs(argv: string[]): { taskId: string; note: string; keepWorktree: boolean } | null {
  // argv after the node + script: positional task id, then optional flags.
  const args = argv.slice(2);
  if (args.length === 0) return null;
  const taskId = args[0]!;
  let note = '';
  let keepWorktree = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--note' && args[i + 1]) {
      note = args[i + 1]!;
      i++;
    } else if (args[i] === '--keep-worktree') {
      keepWorktree = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      return null;
    }
  }
  return { taskId, note, keepWorktree };
}

function usage(): void {
  process.stderr.write(
    `Usage: nyx resume <TASK-ID> [--note "free text"] [--keep-worktree]\n\n` +
      `  --note <text>      Recorded in the task.resumed audit row; surfaces to\n` +
      `                     the next attempt's Claude prompt as context about\n` +
      `                     what was resolved.\n` +
      `  --keep-worktree    Preserve /tmp/nyx-clone-<id> and worktrees/<id>.\n` +
      `                     Default is to wipe so the retry is fresh-clone.\n`,
  );
}

function main(): void {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    usage();
    process.exit(1);
  }
  const { taskId, note, keepWorktree } = parsed;

  if (!isTaskHalted(taskId)) {
    process.stderr.write(
      `[nyx resume] ${taskId} is not currently halted for review. Nothing to do.\n` +
        `If you expected this task to be halted, check:\n` +
        `  sqlite3 ~/Nyx/data/nyx.db \\\n` +
        `    "SELECT event, datetime(at,'localtime') FROM system_audit\\\n` +
        `     WHERE json_extract(payload,'\\$.taskId') = '${taskId}'\\\n` +
        `     ORDER BY id DESC LIMIT 10;"\n`,
    );
    process.exit(2);
  }

  if (!keepWorktree) {
    for (const stale of [
      resolve(config.worktreesDir, taskId),
      `${config.cloneRootPrefix}${taskId}`,
    ]) {
      if (existsSync(stale)) {
        try {
          rmSync(stale, { recursive: true, force: true });
        } catch (err) {
          process.stderr.write(
            `[nyx resume] warning: could not remove ${stale}: ${(err as Error).message}\n`,
          );
        }
      }
    }
  }

  const reason = note.trim() || 'operator resume (no note)';
  resetFailureCount(taskId, reason);
  audit('task.resumed', 'operator', { taskId, note: reason, keepWorktree });

  process.stdout.write(
    `[nyx resume] ${taskId} unblocked.\n` +
      `  failure + audit counters reset.\n` +
      `  ${keepWorktree ? 'worktree preserved.' : 'worktree wiped — next attempt is fresh-clone.'}\n` +
      `  next launchd tick will pick it up, or run scripts/nyx-tick.sh now.\n`,
  );
}

main();
