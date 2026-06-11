import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Rotten-green detection (P7 — content-level test-quality oracle, deterministic
 * tier).
 *
 * A green gate proves the suite RAN and exited 0. It does not prove the new
 * tests actually ASSERT anything. The cheapest, false-negative-free oracle the
 * field converged on (Delplanque/Ducasse rotten-green, MutGen) is a syntactic
 * check over the changed test files themselves — no LLM, no second run:
 *
 *   1. min assertion density — a new/changed test file with test bodies but
 *      (near-)zero assertion sites is "rotten green": it passes because it never
 *      checks anything (the agent wrote `it('works', () => { foo() })`).
 *   2. blank-identifier sinks — a result deliberately discarded into `_`, `void`,
 *      or an unused throwaway so the linter/type-checker stops complaining while
 *      the value is never asserted on.
 *   3. skip-only — every test in a changed file is `.skip`/`.todo`/`xit`/`@pytest
 *      .mark.skip`; the suite is green because nothing executed.
 *
 * CAREFUL POLICY (mirrors gate-trust G-C): this is FLAG-FOR-REVIEW, not a hard
 * fail. A legitimate change can touch a test file without adding assertions (a
 * refactor that moves a helper, a fixture-only file, a deliberately-skipped
 * quarantine). Blanket-failing those would halt honest work. So the verifier
 * emits a structured finding + an operator DM; the dispatcher does NOT fail the
 * task on it. Only the lint gate is a hard signal.
 *
 * Pure where it can be: `analyzeTestSource` takes file text and returns the
 * per-file verdict; `assessRottenGreen` does the I/O (read each changed test
 * file off disk) and aggregates. No spawn, no network — free under the Max-plan
 * model.
 */

export type RottenGreenReason = 'no-assertions' | 'skip-only' | 'blank-identifier-sink';

export interface RottenGreenFileFinding {
  path: string;
  reasons: RottenGreenReason[];
  testCount: number;
  assertionCount: number;
  skippedCount: number;
}

export interface RottenGreenResult {
  findings: RottenGreenFileFinding[];
  paths: string[];
}

// A file is a test file if its path matches one of these shapes. Kept broad
// enough to cover the JS (jest/vitest/mocha) + Python (pytest) conventions the
// gate runs, narrow enough that production source never trips it.
const TEST_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.py$/,
];

export function isTestFile(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some((re) => re.test(norm));
}

const isPython = (path: string): boolean => /\.py$/i.test(path);

// Test-declaration sites. JS: `it(`/`test(`/`it.each(`/`it.skip(`/`xit(`; Python:
// a `def test_…`. A SKIPPED test is still a declared test, so the count includes
// the `.skip`/`.todo`/`xit` forms — otherwise a file where every test is skipped
// would have testCount 0 and never trip the skip-only check. `describe`/class
// blocks are containers, not tests, so they're excluded.
const JS_TEST_RE = /\b(?:x?it|test)\s*(?:\.\s*(?:each|skip|todo|only|concurrent|failing)\b\s*(?:\([^)]*\))?\s*(?:`[^`]*`)?)?\s*\(/g;
const JS_SKIP_RE = /\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(|\bx(?:it|describe)\s*\(/g;
const PY_TEST_RE = /^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm;
const PY_SKIP_RE = /@pytest\.mark\.skip\b|@unittest\.skip\b|pytest\.skip\s*\(/g;

// Assertion sites. JS: `expect(`, `assert(`/`assert.foo(`, chai `.should`,
// node:test `t.assert`. Python: bare `assert ` statement, `self.assert…(`,
// `pytest.raises(`, `assertRaises(`.
const JS_ASSERT_RE = /\bexpect\s*\(|\bassert\b\s*(?:\.\s*\w+\s*)?\(|\.\s*should\b|\.\s*to\s*\.\s*(?:equal|be|deep)\b|\bt\s*\.\s*assert\b/g;
const PY_ASSERT_RE = /^\s*assert\b|\bself\s*\.\s*assert\w+\s*\(|\bpytest\s*\.\s*raises\s*\(|\bassertRaises\b/gm;

// Blank-identifier sinks: a returned/awaited value discarded so it's never
// asserted on. `const _ = foo()`, `void foo()`, `_ = await foo()` (JS) or `_ =
// foo()` (Python). A leading `_`-only binding of a CALL result is the smell;
// destructuring `const { _x } = …` and plain `_foo` names are not matched.
const JS_BLANK_SINK_RE = /(?:const|let|var)\s+_\s*=\s*[^=]|^\s*void\s+\w|(?:^|\s)_\s*=\s*await\b/gm;
const PY_BLANK_SINK_RE = /^\s*_\s*=\s*\w/gm;

function countMatches(text: string, re: RegExp): number {
  // RegExp with the `g` flag carries mutable lastIndex; rebuild a fresh matcher
  // per call so concurrent analysis can't interleave and miscount.
  const matcher = new RegExp(re.source, re.flags);
  let n = 0;
  while (matcher.exec(text) !== null) {
    n += 1;
    // Zero-width guard: a pattern that can match empty would loop forever.
    if (matcher.lastIndex === 0) matcher.lastIndex = 1;
  }
  return n;
}

/**
 * Strip line + block comments so an agent that writes assertions ONLY inside a
 * comment (MutGen's documented self-fooling lever — the agent authors both the
 * comment and the test) can't satisfy the assertion-density check with prose.
 * Conservative: removes `//…`, `/* … *​/`, and Python `#…`. String literals that
 * happen to contain `//` are over-stripped, but that only ever REMOVES potential
 * assertion text — it can never manufacture a false assertion, so it's safe for
 * a flag-for-review check.
 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/(^|\s)#[^\n]*/g, '$1');
}

/**
 * Per-file rotten-green verdict from source text. Pure. `path` only selects the
 * JS-vs-Python matcher set. A file with no test declarations at all returns an
 * empty `reasons` (it's a fixture/helper, not a rotten test).
 */
export function analyzeTestSource(path: string, rawSource: string): RottenGreenFileFinding {
  const source = stripComments(rawSource);
  const py = isPython(path);
  const testCount = countMatches(source, py ? PY_TEST_RE : JS_TEST_RE);
  const assertionCount = countMatches(source, py ? PY_ASSERT_RE : JS_ASSERT_RE);
  const skippedCount = countMatches(source, py ? PY_SKIP_RE : JS_SKIP_RE);
  const blankSinks = countMatches(source, py ? PY_BLANK_SINK_RE : JS_BLANK_SINK_RE);

  const reasons: RottenGreenReason[] = [];
  if (testCount > 0) {
    // skip-only: every declared test is skipped (the file is green because
    // nothing in it ran). Requires testCount>0 so a pure-fixture file is ignored.
    if (skippedCount >= testCount) {
      reasons.push('skip-only');
    } else if (assertionCount === 0) {
      // no-assertions: real (non-skipped) tests exist but the file asserts
      // nothing — the textbook rotten green.
      reasons.push('no-assertions');
    }
    // A blank-identifier sink is a smell regardless of assertion count: a value
    // was computed and deliberately discarded into `_`/`void` instead of
    // asserted on. Only flagged when there's at least one non-skipped test so a
    // fixture's `_ = setup()` doesn't trip it.
    if (blankSinks > 0 && skippedCount < testCount) {
      reasons.push('blank-identifier-sink');
    }
  }

  return { path, reasons, testCount, assertionCount, skippedCount };
}

/**
 * Read each changed TEST file off disk and aggregate rotten-green findings. Only
 * test files (per `isTestFile`) are inspected; production source is ignored.
 * Best-effort on I/O: a file that can't be read is skipped (never throws).
 * `changedFiles` is the working-tree diff (`changedFilesWorkingTree`).
 */
export function assessRottenGreen(workingDir: string, changedFiles: string[]): RottenGreenResult {
  const findings: RottenGreenFileFinding[] = [];
  const seen = new Set<string>();
  for (const raw of changedFiles) {
    const path = raw.trim();
    if (!path || seen.has(path) || !isTestFile(path)) continue;
    seen.add(path);
    const full = resolve(workingDir, path);
    if (!existsSync(full)) continue;
    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const finding = analyzeTestSource(path, source);
    if (finding.reasons.length > 0) findings.push(finding);
  }
  return { findings, paths: findings.map((f) => f.path) };
}
