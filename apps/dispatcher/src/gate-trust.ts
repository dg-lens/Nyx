import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Finding G-C — same-trust-domain gate vulnerability.
 *
 * The gate (pytest / pnpm test) runs INSIDE the worktree the spawned agent
 * fully controls. That is the SWE-bench "conftest.py hole": an agent can write
 * or edit a test-infra file (a conftest that monkey-patches the runner, a
 * vitest config that excludes failing specs, a CI workflow that no-ops the gate)
 * and force the gate green without making the code correct. Berkeley RDI / the
 * BenchJack work measured a ~100% hack rate on this exact shape.
 *
 * Nyx cannot blanket-FAIL on test-infra edits: a legitimate task whose whole
 * purpose is editing test config (add a vitest setup file, tighten a CI gate,
 * fix a broken conftest fixture) is common and correct. Blanket-failing it would
 * be a false positive that halts honest work. So this is the CAREFUL POLICY:
 * detect and FLAG-FOR-REVIEW, never auto-fail. The detector is a pure function
 * over the changed-file list; the wiring emits an audit event and surfaces the
 * touched paths in the task outcome so the operator sees the gate ran against a
 * diff that could itself rewrite the gate.
 */

export type GateSensitiveCategory =
  | 'pytest-config'
  | 'js-test-config'
  | 'package-scripts'
  | 'ci-workflow'
  | 'python-project-config'
  | 'ts-compiler-config'
  | 'eslint-config';

export interface GateSensitiveHit {
  path: string;
  category: GateSensitiveCategory;
}

export interface GateSensitiveResult {
  hits: GateSensitiveHit[];
  paths: string[];
}

// Files whose basename alone makes them gate-controlling test infrastructure,
// regardless of the directory they live in. A conftest.py anywhere on the
// pytest rootdir path is collected; pytest.ini/tox.ini/setup.cfg carry pytest
// config; the JS configs are picked up by the test runner from any dir.
//
// pyproject.toml carries the [tool.pytest.*]/[tool.mypy]/[tool.ruff] tables the
// Python gate (pytest + mypy + ruff) reads — editing it can relax strictness,
// flip `addopts`, or narrow `testpaths`. tsconfig.json drives `tsc --noEmit`
// (strict/skipLibCheck/exclude can hide type errors the gate is meant to
// catch). Both are flagged on basename alone like the pytest configs above.
const EXACT_BASENAMES: ReadonlyArray<readonly [RegExp, GateSensitiveCategory]> = [
  [/^conftest\.py$/, 'pytest-config'],
  [/^pytest\.ini$/, 'pytest-config'],
  [/^tox\.ini$/, 'pytest-config'],
  [/^setup\.cfg$/, 'pytest-config'],
  [/^pyproject\.toml$/, 'python-project-config'],
  [/^tsconfig(?:\.[\w.-]+)?\.json$/, 'ts-compiler-config'],
];

// ESLint config files matched by basename. Both the legacy `.eslintrc*` family
// (any extension, or extensionless `.eslintrc`) and the flat-config
// `eslint.config.{js,cjs,mjs,ts,mts,cts}` are picked up by the linter from the
// nearest dir up the tree, so a change anywhere can loosen the rules the `lint`
// gate enforces (disable a rule, add an `ignorePatterns`, widen `overrides`).
const ESLINT_CONFIG_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.eslintrc$/,
  /^\.eslintrc\.(?:[cm]?js|json|ya?ml)$/,
  /^eslint\.config\.(?:[cm]?[jt]s)$/,
];

// Test-runner config files matched by a basename pattern (any extension the
// runner accepts: .js/.cjs/.mjs/.ts/.mts/.cts/.json). Covers jest, vitest,
// mocha, and the vitest/jest "setup" entrypoints (setupTests, vitest.setup,
// jest.setup) that run before the suite and can globally stub assertions.
const JS_CONFIG_PATTERNS: ReadonlyArray<RegExp> = [
  /^jest\.config\.(?:[cm]?[jt]s|json)$/,
  /^jest\.setup\.(?:[cm]?[jt]s)$/,
  /^vitest\.config\.(?:[cm]?[jt]s)$/,
  /^vitest\.setup\.(?:[cm]?[jt]s)$/,
  /^vitest\.workspace\.(?:[cm]?[jt]s|json)$/,
  /^\.mocharc\.(?:[cm]?[jt]s|json|ya?ml)$/,
  /^mocha\.opts$/,
  /^setupTests\.(?:[cm]?[jt]sx?)$/,
  /^karma\.conf\.(?:[cm]?[jt]s)$/,
  /^playwright\.config\.(?:[cm]?[jt]s)$/,
];

function basename(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? norm : norm.slice(idx + 1);
}

function isCiWorkflow(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(norm)) return true;
  if (/(^|\/)\.gitlab-ci\.yml$/.test(norm)) return true;
  if (/(^|\/)\.circleci\/config\.yml$/.test(norm)) return true;
  return false;
}

function classify(path: string): GateSensitiveCategory | null {
  if (isCiWorkflow(path)) return 'ci-workflow';
  const base = basename(path);
  for (const [re, cat] of EXACT_BASENAMES) {
    if (re.test(base)) return cat;
  }
  for (const re of JS_CONFIG_PATTERNS) {
    if (re.test(base)) return 'js-test-config';
  }
  for (const re of ESLINT_CONFIG_PATTERNS) {
    if (re.test(base)) return 'eslint-config';
  }
  if (base === 'package.json') return 'package-scripts';
  return null;
}

/**
 * Pure: returns the gate-controlling / test-infra paths touched in `changedFiles`,
 * each tagged with its category. No I/O. Order-preserving on input, de-duplicated.
 *
 * A `package.json` change is flagged as `package-scripts` here on path alone —
 * the test/scripts block is the gate-controlling part, but a pure path check
 * cannot see whether the diff touched it. Callers that have the working tree on
 * disk should narrow with `packageJsonTouchesGate` to avoid flagging a pure
 * dependency-bump. Pure (path-only) callers get the conservative superset.
 */
export function detectGateSensitiveChanges(changedFiles: string[]): GateSensitiveResult {
  const hits: GateSensitiveHit[] = [];
  const seen = new Set<string>();
  for (const raw of changedFiles) {
    const path = raw.trim();
    if (!path || seen.has(path)) continue;
    const category = classify(path);
    if (category) {
      hits.push({ path, category });
      seen.add(path);
    }
  }
  return { hits, paths: hits.map((h) => h.path) };
}

/**
 * Best-effort content narrowing for a `package.json` hit: returns true iff the
 * file on disk declares a `scripts` block that contains a `test`/`typecheck`/
 * `lint` entry — the keys the gate actually invokes (`pnpm run test`, etc.).
 * A package.json whose diff is purely a dependency version bump has scripts but
 * doesn't change them; this can't see the diff, only whether gate-relevant
 * scripts EXIST, so it errs toward flagging. Returns true on any read/parse
 * failure (fail-safe: when unsure, keep the flag). Never throws.
 */
export function packageJsonTouchesGate(workingDir: string, relPath: string): boolean {
  try {
    const full = resolve(workingDir, relPath);
    if (!existsSync(full)) return true;
    const pkg = JSON.parse(readFileSync(full, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    return Boolean(scripts['test'] || scripts['typecheck'] || scripts['lint']);
  } catch {
    return true;
  }
}

/**
 * Convenience for the run-once wiring: classify the working-tree diff and, for
 * any `package.json` hit, narrow it with the on-disk scripts check so a pure
 * dependency bump doesn't get flagged. Returns the surviving hits + a short
 * operator-facing summary line. `changedFiles` comes from
 * `changedFilesWorkingTree(workingDir)`.
 */
export function assessGateTrust(
  workingDir: string,
  changedFiles: string[],
): GateSensitiveResult {
  const { hits } = detectGateSensitiveChanges(changedFiles);
  const kept = hits.filter((h) =>
    h.category === 'package-scripts'
      ? packageJsonTouchesGate(workingDir, h.path)
      : true,
  );
  return { hits: kept, paths: kept.map((h) => h.path) };
}
