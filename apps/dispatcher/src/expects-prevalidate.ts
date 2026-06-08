/**
 * Pre-validate [expects:] paths at dispatch time, before any compute is spent.
 *
 * Closes the recurring the apps-web-decomposer-guess node failure mode: the
 * dispatch-mode decomposer writes [expects:] paths from convention/memory
 * without inspecting the actual target repo, and the mismatch surfaces only
 * after the post-gate expects-verifier — after preflight, claude exec, and
 * gate have all run. The OUTREACH-PORTAL-UI cascade on 2026-05-25 wasted
 * ~21 min of correct claude work because the [expects:] paths dropped the
 * `src/` prefix that the portal's single-package layout requires.
 *
 * This module runs immediately after working dir setup in dispatchOne. For
 * each declared expects path, it checks that the path's PARENT DIRECTORY
 * exists in the freshly-cloned working dir. It does NOT check the file —
 * the file is what the task is supposed to produce. But the parent dir is
 * structural: if it doesn't exist, the path is wrong by convention.
 *
 * Common-pattern suggestions are surfaced in the failure log: if the path
 * starts with `app/` but the repo has `src/app/`, the message tells the
 * operator to add the `src/` prefix.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ParsedTask } from './types.js';

export interface PrevalidateResult {
  passed: boolean;
  missingParents: Array<{
    expectsPath: string;
    parentDir: string;
    suggestion?: string;
  }>;
}

/**
 * Detect a path that the tag parser (TAG_RE in task-reader.ts) truncated at an
 * inner `]`. TAG_RE captures `[expects: ...]` with `[^\]]+`, so any value
 * containing a Next.js dynamic-route segment (`[slug]`, `[id]`, `[[...x]]`)
 * is cut at the first inner `]` — `src/app/blog/[slug]/page.tsx` arrives here
 * as `src/app/blog/[slug`. The reliable signature of that truncation is an
 * unbalanced `[` (more `[` than `]`). Such a path can never name a real file,
 * so it must be flagged rather than silently passing prevalidation.
 *
 * Root-cause fix belongs in the parser (brace-balanced / quoted delimiter);
 * this is the stopgap that prevents a false PASS until that lands.
 */
function hasUnbalancedBracket(p: string): boolean {
  let open = 0;
  for (const ch of p) {
    if (ch === '[') open++;
    else if (ch === ']') open--;
  }
  return open !== 0;
}

/**
 * Compute a smart suggestion for a missing-parent path by checking common
 * wrong-prefix patterns against what does exist in the working dir.
 */
function suggestionFor(workingDir: string, expectsPath: string): string | undefined {
  // Pattern 1: agent wrote `app/...` but repo uses `src/app/...` (single-package Next.js)
  if (expectsPath.startsWith('app/') && existsSync(resolve(workingDir, 'src/app'))) {
    return `did you mean "src/${expectsPath}"? this repo is single-package — Next.js source lives under src/`;
  }
  // Pattern 2: agent wrote `apps/web/...` but the portal is single-package
  if (expectsPath.startsWith('apps/web/') && !existsSync(resolve(workingDir, 'apps/web'))) {
    const stripped = expectsPath.slice('apps/web/'.length);
    if (existsSync(resolve(workingDir, dirname(stripped)))) {
      return `did you mean "${stripped}"? this repo has no apps/web/ — it's single-package, source lives at repo root`;
    }
  }
  // Pattern 3: agent wrote `src/...` but the repo uses something else at root
  // (less common — skip for now, would need repo-specific knowledge)
  return undefined;
}

/**
 * Validate that every [expects:] path's parent directory exists in the
 * fresh-cloned working dir. Returns structured result; caller decides what
 * to do with failures (the dispatcher emits task.expects.prevalidate.failed
 * + task.failed + halts the task).
 *
 * Validation rule (v0.10.1 — corrected from v0.10.0's overly-strict rule):
 *  We do NOT require the immediate parent dir of the expects path to exist.
 *  Tasks legitimately create new directory trees (e.g. OUTREACH-SEQUENCE-CRON
 *  creates `apps/outreach-api/src/outreach_api/cron/` which doesn't exist on
 *  dev yet). Checking the immediate parent flags those false-positives.
 *
 *  Instead, we check the FIRST TWO PATH SEGMENTS. The actual T4 failure mode
 *  was top-level wrong-prefix (`app/...` when repo uses `src/app/...`, OR
 *  `apps/web/...` when repo is single-package). This pattern is fully
 *  captured by:
 *    - First segment MUST exist in the working dir. If not → flag (wrong root).
 *    - Second segment, if there are deeper segments below it, MUST exist.
 *      Catches `apps/web/src/...` where `apps/` exists but `apps/web/` doesn't.
 *    - Anything from segment 3 onward is allowed to not exist — the task is
 *      creating those.
 *
 * Edge cases:
 *  - No expects declared → passed=true (nothing to validate)
 *  - Task type isn't `code` → passed=true (other types don't typically use
 *    expects, and their working dirs aren't repos)
 *  - Single-segment path (file at repo root, e.g. `CHANGELOG.md`) → valid
 *  - Two-segment path (file in top-level dir, e.g. `migrations/0010.sql`) →
 *    valid iff the top-level dir exists
 */
export function prevalidateExpects(task: ParsedTask, workingDir: string): PrevalidateResult {
  if (task.type !== 'code') return { passed: true, missingParents: [] };
  if (!task.expects || task.expects.length === 0) return { passed: true, missingParents: [] };

  const missing: PrevalidateResult['missingParents'] = [];
  for (const p of task.expects) {
    // A path with an unbalanced `[` was truncated by TAG_RE at an inner `]`
    // (Next.js dynamic-route segment). It can never name a real file; flag it
    // before segment checks, which would otherwise PASS on the surviving prefix.
    if (hasUnbalancedBracket(p)) {
      missing.push({
        expectsPath: p,
        parentDir: p,
        suggestion:
          'this path was truncated at an inner "]" by the [expects:] tag parser ' +
          '(a Next.js dynamic-route segment like [slug] or [id]). Declare the parent ' +
          'directory instead of the bracketed leaf path, or omit dynamic-route files ' +
          'from [expects:] and rely on the gate + content-quality check.',
      });
      continue;
    }

    const segments = p.split('/').filter((s) => s.length > 0);
    if (segments.length <= 1) continue; // file at repo root — always valid

    // Check first segment: must exist
    const firstSeg = segments[0]!;
    if (!existsSync(resolve(workingDir, firstSeg))) {
      const entry: PrevalidateResult['missingParents'][number] = {
        expectsPath: p,
        parentDir: firstSeg,
      };
      const sug = suggestionFor(workingDir, p);
      if (sug) entry.suggestion = sug;
      missing.push(entry);
      continue;
    }

    // Check second segment iff there are deeper segments below it
    // (a 2-segment path like `migrations/0010.sql` is the file itself; nothing to check at depth 2)
    if (segments.length >= 3) {
      const firstTwo = `${segments[0]}/${segments[1]}`;
      if (!existsSync(resolve(workingDir, firstTwo))) {
        const entry: PrevalidateResult['missingParents'][number] = {
          expectsPath: p,
          parentDir: firstTwo,
        };
        const sug = suggestionFor(workingDir, p);
        if (sug) entry.suggestion = sug;
        missing.push(entry);
      }
    }
  }
  return { passed: missing.length === 0, missingParents: missing };
}

/**
 * Build a human-readable failure log from a failed prevalidate result.
 */
export function buildPrevalidateFailureLog(result: PrevalidateResult): string {
  const lines: string[] = [];
  lines.push(`[expects:] pre-validation failed. ${result.missingParents.length} path(s) have missing parent directories in the freshly-cloned working dir:`);
  lines.push('');
  for (const { expectsPath, parentDir, suggestion } of result.missingParents) {
    lines.push(`  - ${expectsPath}`);
    lines.push(`      parent dir "${parentDir}" does not exist in working dir`);
    if (suggestion) lines.push(`      suggestion: ${suggestion}`);
  }
  lines.push('');
  lines.push('This is the the apps-web-decomposer-guess node pattern — the dispatch-mode decomposer wrote');
  lines.push('paths from convention without inspecting the actual repo layout. Fix the [expects:] tag');
  lines.push('in the task spec to use paths that match the real repo, then `nyx resume <TASK-ID>`.');
  return lines.join('\n');
}
