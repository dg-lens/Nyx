/**
 * Flaky-test classification by rerun-on-same-commit (P7).
 *
 * The dangerous default this replaces is "retry-to-green": a gate that fails,
 * gets silently re-run, passes the second time, and the task ships — the flake
 * is hidden and the audit chain records a clean pass. That is exactly how a
 * non-deterministic test rots a suite while every dashboard stays green.
 *
 * Correct behavior: when a verdict is suspected non-deterministic, RERUN the
 * tests stage against the IDENTICAL working tree (no new commit, no file change)
 * and compare. The decision is purely about determinism:
 *
 *   - both runs agree (pass,pass) → deterministic pass; accept.
 *   - both runs agree (fail,fail) → deterministic fail; the real gate verdict
 *     stands (route to audit as usual).
 *   - the two runs DISAGREE on the identical tree → FLAKY. Never silently take
 *     the green: quarantine the task (halt for operator review) so the flake is
 *     surfaced and fixed, not laundered into a pass.
 *
 * `classifyRerun` is the pure decision; `assertSameTree` guards the invariant
 * that the rerun happened on an unchanged tree (a defensive check — if the tree
 * moved between runs the comparison is meaningless and we must not classify).
 */

import { execSync } from 'node:child_process';

export type FlakyVerdict = 'deterministic-pass' | 'deterministic-fail' | 'flaky';

export interface RerunClassification {
  verdict: FlakyVerdict;
  firstPassed: boolean;
  secondPassed: boolean;
}

/**
 * Pure: classify a pair of same-tree test runs. Order-independent on the two
 * booleans — a (pass,fail) and a (fail,pass) are both flaky. The only accepted
 * GREEN is two agreeing passes; the only deterministic FAIL is two agreeing
 * fails. Anything that disagrees on the identical tree is flaky.
 */
export function classifyRerun(firstPassed: boolean, secondPassed: boolean): RerunClassification {
  if (firstPassed && secondPassed) {
    return { verdict: 'deterministic-pass', firstPassed, secondPassed };
  }
  if (!firstPassed && !secondPassed) {
    return { verdict: 'deterministic-fail', firstPassed, secondPassed };
  }
  return { verdict: 'flaky', firstPassed, secondPassed };
}

/**
 * Snapshot a working tree's content fingerprint: HEAD sha + the porcelain status
 * (so uncommitted changes count). Used to assert the rerun happened on the SAME
 * tree the first run did. Returns null when git is unavailable (caller then
 * skips the same-tree assertion rather than crash). Never throws.
 */
export function treeFingerprint(workingDir: string): string | null {
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    const status = execSync('git status --porcelain --untracked-files=all', {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
    return `${head}\n${status}`;
  } catch {
    return null;
  }
}

/**
 * True iff the two fingerprints describe the same tree. A null on either side
 * (git unavailable) is treated as "can't prove same tree" → false, so the caller
 * declines to classify rather than risk comparing across a moved tree.
 */
export function sameTree(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return false;
  return before === after;
}

/**
 * Build the operator report for a quarantined flaky task. Surfaced verbatim in
 * the halt — the operator needs to know WHICH verdict flipped and that the task
 * was NOT silently retried to green.
 */
export function buildFlakyReport(taskId: string, c: RerunClassification): string {
  const first = c.firstPassed ? 'PASS' : 'FAIL';
  const second = c.secondPassed ? 'PASS' : 'FAIL';
  return [
    `Task ${taskId} quarantined — flaky test gate.`,
    '',
    `The tests stage produced different verdicts on the IDENTICAL working tree:`,
    `  - run 1: ${first}`,
    `  - run 2: ${second}`,
    '',
    `A non-deterministic test was NOT laundered into a pass (no retry-to-green).`,
    `Find the flaky test (ordering dependence, timing, shared state, network),`,
    `make it deterministic or quarantine it explicitly, then \`nyx resume ${taskId}\`.`,
  ].join('\n');
}
