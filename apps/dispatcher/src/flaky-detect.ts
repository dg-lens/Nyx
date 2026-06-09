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
 * `classifyRerun` is the pure decision; `buildFlakyReport` renders the operator
 * halt. The rerun is driven by the tests stage in test-gate.ts on the IDENTICAL
 * worktree (no commit, no file change between the two runs), so the same-tree
 * invariant is structural — the dispatcher never moves the tree mid-classify.
 */

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
