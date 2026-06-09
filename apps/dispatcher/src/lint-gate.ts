import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from './config.js';

/**
 * Pinned-version, diff-scoped lint gate (P7 — the long-pending CORTANA-GATE-LINT).
 *
 * Two problems this closes:
 *
 *   1. The gate ran pytest/pnpm test but NOT ruff/eslint, so lint failures only
 *      surfaced in CI after push — costing a hotfix cycle per bounce.
 *   2. A locally-installed linter is rarely the version CI runs. A rule that
 *      shipped (or changed severity) in a newer ruff/eslint makes local-green /
 *      CI-red, the most confusing class of bounce. So the version is PINNED to
 *      the target repo's CI: we install + invoke exactly that version (via
 *      `uvx ruff@<v>` / `pnpm dlx eslint@<v>`), not whatever happens to be on
 *      PATH.
 *
 * Diff-scoped: only the files the agent changed are linted (not the whole repo),
 * so a pre-existing lint debt in an untouched file never fails an unrelated
 * task. `changedFiles` is the working-tree diff (`changedFilesWorkingTree`).
 *
 * Fail-fast hard signal: unlike rotten-green / content-judge (advisory), a lint
 * failure on the agent's OWN diff IS a real defect and fails the task into the
 * audit pipeline — that's the whole point of moving lint left of CI.
 *
 * BUT only when the linter actually RAN. Because the pinned version is fetched on
 * demand (`uvx ruff@<v>` / `pnpm dlx eslint@<v>`), a bad/nonexistent pin, a
 * registry 404, or an offline runner makes the WRAPPER exit non-zero without ever
 * linting the diff. That is infrastructure the agent cannot fix, so it degrades to
 * a non-fatal SKIP (ran:false), never a gate failure — see classifyLintResult /
 * isInstallOrUsageFailure. The hard-fail path is reserved for a real lint finding.
 */

export type LintEcosystem = 'js' | 'py';
export type LintTool = 'eslint' | 'ruff';

export interface LintGateOutcome {
  ran: boolean;
  passed: boolean;
  tool?: LintTool;
  pinnedVersion?: string;
  versionSource?: 'ci-pin' | 'repo-declared' | 'unpinned';
  scopedFiles: string[];
  log: string;
  /** Reason the stage did not run (no lintable files, no config, tool unavailable). */
  skipReason?: string;
}

const JS_LINT_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const PY_LINT_EXT = /\.py$/i;

/**
 * The lintable subset of a changed-file list for one ecosystem. Excludes deleted
 * files (a path no longer on disk can't be linted) — `existsSync` against the
 * working dir filters them. Pure aside from the existence probe.
 */
export function scopeLintFiles(
  workingDir: string,
  changedFiles: string[],
  ecosystem: LintEcosystem,
): string[] {
  const ext = ecosystem === 'js' ? JS_LINT_EXT : PY_LINT_EXT;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of changedFiles) {
    const path = raw.trim();
    if (!path || seen.has(path) || !ext.test(path)) continue;
    seen.add(path);
    if (existsSync(resolve(workingDir, path))) out.push(path);
  }
  return out;
}

/**
 * Resolve the ruff version to run. Order: (1) the operator's CI pin in
 * gitTargets[repo].lintPins.ruff; (2) a version the repo itself declares in
 * pyproject.toml (`ruff==X`, `ruff>=X`, or `[tool.ruff] required-version`); (3)
 * unpinned. Pinning to CI is the goal — repo-declared is the best available
 * proxy when the operator hasn't set an explicit CI pin.
 */
export function resolveRuffVersion(
  repo: string | undefined,
  pyprojectText: string,
): { version?: string; source: 'ci-pin' | 'repo-declared' | 'unpinned' } {
  const pin = repo ? config.gitTargets[repo]?.lintPins?.ruff : undefined;
  if (pin) return { version: pin, source: 'ci-pin' };

  // `required-version` (ruff's own pin mechanism) wins over a dep constraint.
  const req = /required-version\s*=\s*["']\s*[=~^>]*\s*([0-9][0-9A-Za-z.+-]*)\s*["']/.exec(pyprojectText);
  if (req?.[1]) return { version: req[1], source: 'repo-declared' };
  const dep = /["']ruff\s*(?:[=~!<>]=?|@)\s*v?([0-9][0-9A-Za-z.+-]*)["']/.exec(pyprojectText);
  if (dep?.[1]) return { version: dep[1], source: 'repo-declared' };
  return { source: 'unpinned' };
}

/**
 * Resolve the eslint version to run. Order mirrors ruff: CI pin → repo-declared
 * (package.json devDependencies/dependencies `eslint`) → unpinned. A leading
 * range operator (`^`, `~`, `>=`) is stripped to a concrete version so the
 * `eslint@<v>` install is reproducible rather than re-floating to latest.
 */
export function resolveEslintVersion(
  repo: string | undefined,
  pkgText: string,
): { version?: string; source: 'ci-pin' | 'repo-declared' | 'unpinned' } {
  const pin = repo ? config.gitTargets[repo]?.lintPins?.eslint : undefined;
  if (pin) return { version: pin, source: 'ci-pin' };
  try {
    const pkg = JSON.parse(pkgText) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const raw = pkg.devDependencies?.['eslint'] ?? pkg.dependencies?.['eslint'];
    if (raw) {
      const m = /([0-9][0-9A-Za-z.+-]*)/.exec(raw);
      if (m?.[1]) return { version: m[1], source: 'repo-declared' };
    }
  } catch {
    /* malformed package.json — fall through to unpinned */
  }
  return { source: 'unpinned' };
}

function hasOnPath(cmd: string): boolean {
  return spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5_000 }).status === 0;
}

/**
 * Distinguish "the pinned linter could not be installed/run" from "the linter ran
 * and found lint issues". We invoke ruff/eslint through `uvx ruff@<v>` /
 * `pnpm dlx eslint@<v>`, which FETCH the pinned version on demand. When that fetch
 * fails — a bad/nonexistent pinned version, a registry 404, an offline box — the
 * wrapper (uvx/uv, pnpm/npx) exits NON-ZERO with `status` SET (not null, no signal,
 * no spawn `error`), so it is indistinguishable from a real lint failure by exit
 * code alone. A code task must NOT fail its gate because a pinned linter version
 * could not be fetched, so we sniff the install/download/usage-error signature in
 * the combined output and treat a match as a non-fatal skip.
 *
 * Only matches the wrapper/install/network failure vocabulary — a genuine lint
 * finding (ruff "F401 imported but unused", eslint "error  'x' is defined but
 * never used") does NOT contain any of these tokens, so a real defect still fails.
 */
const INSTALL_OR_USAGE_FAILURE_RE = new RegExp(
  [
    // uv / uvx resolution + download failures (bad ruff@<v>, offline, 404)
    'no solution found',
    'no matching distribution',
    'failed to download',
    'failed to fetch',
    'failed to install',
    'failed to prepare',
    'failed to build',
    'distribution not found',
    'no version(?:s)? (?:of|found)',
    // pnpm dlx / npm resolution + fetch failures (bad eslint@<v>, offline, 404)
    'err_pnpm_no_matching_version',
    'err_pnpm_fetch',
    'no matching version found',
    'etarget',
    'notarget',
    'npm error code',
    'npm err!',
    // generic network / registry reachability (offline runners)
    'getaddrinfo',
    'eai_again',
    'enotfound',
    'econnrefused',
    'etimedout',
    'network error',
    'request to .* failed',
    'unexpected (?:status|response) .*404',
    // wrapper could not locate/spawn the tool binary at all
    'command not found',
    'executable .* not found',
    'could not determine executable',
    'no such file or directory',
  ].join('|'),
  'i',
);

export function isInstallOrUsageFailure(output: string): boolean {
  return INSTALL_OR_USAGE_FAILURE_RE.test(output);
}

/**
 * Run the pinned ruff/eslint over only the changed files. Returns an outcome the
 * gate folds in as a stage. Never throws — a spawn error becomes `ran:false`
 * with a skipReason so the gate degrades to its prior behavior rather than
 * hard-failing the task on a tooling problem the agent can't fix.
 */
export function runLintGate(
  workingDir: string,
  repo: string | undefined,
  changedFiles: string[],
): LintGateOutcome {
  const hasPyproject = existsSync(resolve(workingDir, 'pyproject.toml'));
  const hasPkg = existsSync(resolve(workingDir, 'package.json'));

  // Python ruff path. Only runs when the repo declares [tool.ruff] (or ruff is a
  // dep) — a repo with no ruff config shouldn't be force-linted.
  if (hasPyproject) {
    const pyprojectText = readFileSync(resolve(workingDir, 'pyproject.toml'), 'utf8');
    const declaresRuff =
      /\[tool\.ruff(?:\.|\])/.test(pyprojectText) ||
      /["']ruff(?:["'\s=<>~!,;@]|$)/m.test(pyprojectText);
    if (declaresRuff) {
      const scoped = scopeLintFiles(workingDir, changedFiles, 'py');
      if (scoped.length === 0) {
        return { ran: false, passed: true, scopedFiles: [], log: '', skipReason: 'no changed .py files to lint' };
      }
      const { version, source } = resolveRuffVersion(repo, pyprojectText);
      return runRuff(workingDir, scoped, version, source);
    }
  }

  // JS eslint path. Only runs when the repo has an eslint config (legacy
  // .eslintrc* or flat eslint.config.*) — same "don't force-lint an un-linted
  // repo" rule.
  if (hasPkg) {
    const hasEslintConfig =
      ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
        'eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs', 'eslint.config.ts', 'eslint.config.mts',
      ].some((f) => existsSync(resolve(workingDir, f)));
    if (hasEslintConfig) {
      const scoped = scopeLintFiles(workingDir, changedFiles, 'js');
      if (scoped.length === 0) {
        return { ran: false, passed: true, scopedFiles: [], log: '', skipReason: 'no changed JS/TS files to lint' };
      }
      const pkgText = readFileSync(resolve(workingDir, 'package.json'), 'utf8');
      const { version, source } = resolveEslintVersion(repo, pkgText);
      return runEslint(workingDir, scoped, version, source);
    }
  }

  return { ran: false, passed: true, scopedFiles: [], log: '', skipReason: 'no ruff/eslint config in repo' };
}

function runRuff(
  workingDir: string,
  scoped: string[],
  version: string | undefined,
  source: 'ci-pin' | 'repo-declared' | 'unpinned',
): LintGateOutcome {
  // `uvx ruff@<v>` fetches and runs the EXACT pinned ruff in an isolated env,
  // independent of whatever ruff (if any) the project venv has — that pin is the
  // whole point. Falls back to `uv run ruff` / bare `ruff` when uvx is absent so
  // the gate still runs unpinned rather than silently skipping.
  let cmd: string;
  let args: string[];
  if (hasOnPath('uvx')) {
    const spec = version ? `ruff@${version}` : 'ruff';
    cmd = 'uvx';
    args = [spec, 'check', '--no-cache', ...scoped];
  } else if (hasOnPath('ruff')) {
    cmd = 'ruff';
    args = ['check', '--no-cache', ...scoped];
  } else {
    return { ran: false, passed: true, scopedFiles: scoped, log: '', skipReason: 'neither uvx nor ruff on PATH' };
  }
  return execLint('ruff', version, source, scoped, cmd, args, workingDir);
}

function runEslint(
  workingDir: string,
  scoped: string[],
  version: string | undefined,
  source: 'ci-pin' | 'repo-declared' | 'unpinned',
): LintGateOutcome {
  // `pnpm dlx eslint@<v>` fetches the pinned eslint. dlx (not the project's local
  // eslint) is what makes the version reproducible against CI. `--no-error-on-
  // unmatched-pattern` keeps a path eslint chooses to ignore from failing the run.
  let cmd: string;
  let args: string[];
  if (hasOnPath('pnpm')) {
    const spec = version ? `eslint@${version}` : 'eslint';
    cmd = 'pnpm';
    args = ['dlx', spec, '--no-error-on-unmatched-pattern', ...scoped];
  } else if (hasOnPath('npx')) {
    const spec = version ? `eslint@${version}` : 'eslint';
    cmd = 'npx';
    args = ['--yes', spec, '--no-error-on-unmatched-pattern', ...scoped];
  } else {
    return { ran: false, passed: true, scopedFiles: scoped, log: '', skipReason: 'neither pnpm nor npx on PATH' };
  }
  return execLint('eslint', version, source, scoped, cmd, args, workingDir);
}

/** The subset of a spawnSync result the lint classifier needs. */
export interface LintSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Pure: turn a linter invocation's result into a gate outcome. Three-way:
 *   1. spawn error / signal-kill (failed to launch, stage timeout) → SKIP (ran:false).
 *   2. non-zero exit whose output carries an install/download/usage-error
 *      signature (bad pinned version, registry 404, offline, tool-not-found) → SKIP.
 *      The linter never got to lint the diff, so this is infra, not the agent's defect.
 *   3. otherwise → RAN: passed iff exit 0. A non-zero exit with a genuine lint
 *      finding (no install/usage signature) is a REAL failure and hard-fails.
 * Extracted from the spawn so the skip-on-install-failure decision is unit-testable.
 */
export function classifyLintResult(
  tool: LintTool,
  version: string | undefined,
  source: 'ci-pin' | 'repo-declared' | 'unpinned',
  scoped: string[],
  log: string,
  res: LintSpawnResult,
): LintGateOutcome {
  const base = { tool, ...(version ? { pinnedVersion: version } : {}), versionSource: source, scopedFiles: scoped, log };

  if (res.error || (res.status === null && res.signal != null)) {
    const reason = res.error
      ? `${res.error.message}`
      : `killed by signal ${res.signal} (lint stage timeout)`;
    return { ran: false, passed: true, ...base, skipReason: reason };
  }

  if (res.status !== 0 && isInstallOrUsageFailure(`${res.stdout}\n${res.stderr}`)) {
    return {
      ran: false,
      passed: true,
      ...base,
      skipReason: `pinned ${tool}${version ? `@${version}` : ''} could not be installed/run (install/download/usage error) — lint skipped, not failed`,
    };
  }

  return { ran: true, passed: res.status === 0, ...base };
}

function execLint(
  tool: LintTool,
  version: string | undefined,
  source: 'ci-pin' | 'repo-declared' | 'unpinned',
  scoped: string[],
  cmd: string,
  args: string[],
  workingDir: string,
): LintGateOutcome {
  // A spawn error (failed to launch the wrapper, timeout SIGTERM with status=null)
  // is NOT a lint failure. A non-zero exit whose output matches the install/
  // download/usage-error signature (a bad pinned version, a registry 404, an
  // offline box, a missing tool) is ALSO not a lint failure — the wrapper
  // (uvx / pnpm dlx) could not fetch+run the pinned linter, so the diff was never
  // linted. Both degrade to ran:false (a non-fatal skip) rather than hard-failing
  // the task on infra the agent can't fix. classifyLintResult owns that decision.
  const res = spawnSync(cmd, args, {
    cwd: workingDir,
    encoding: 'utf8',
    timeout: config.gateStageTimeoutMs,
    env: { ...process.env, CI: '1' },
  });
  const header = `[$ ${cmd} ${args.slice(0, 2).join(' ')} … (${scoped.length} file(s))]`;
  const log = `${header}\n${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  return classifyLintResult(tool, version, source, scoped, log, {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    ...(res.error ? { error: res.error } : {}),
  });
}
