import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from './config.js';
import { acquireHeavyGateLock, type HeavyGateLock, type HeavyGateLockOpts } from './heavy-gate-lock.js';
import type { GateResult, GateStage, ParsedTask } from './types.js';

interface StageDef {
  name: string;
  cmd: string;
  args: string[];
  /** When true, running this stage with exit code 0 is the only acceptable outcome. */
  strict?: boolean;
}

// ── Ecosystem detection ─────────────────────────────────────────────
//
// v0.6 adds Python alongside the existing JS/TS support. The choice is made
// per cwd by which manifests are present:
//   - package.json present  → JS/TS path (pnpm/npm/yarn detected by lockfile)
//   - pyproject.toml present → Python path (uv/pip + ruff/mypy/pytest)
//   - both → JS path wins (most repos that are "Python with a Node UI" still
//     want their JS gate; if you have a hybrid that needs both, add a second
//     gate task).
//   - neither + gates requested → fail loudly via stagesFor's preflight error.

interface PMContextJs {
  ecosystem: 'js';
  cwd: string;
  installer: { cmd: string; args: string[] };
  hasScript(script: string): boolean;
}
interface PMContextPy {
  ecosystem: 'py';
  cwd: string;
  hasUv: boolean;
  pyprojectText: string;
  /** True iff pyproject.toml declares a [tool.mypy] table (or mypy is in deps). */
  hasMypyConfig: boolean;
  /** True iff pyproject.toml declares pytest config OR a tests/ dir exists. */
  hasPytest: boolean;
  /** True iff pyproject.toml declares [tool.ruff]. */
  hasRuff: boolean;
}
interface PMContextEmpty {
  ecosystem: 'none';
  cwd: string;
}
interface PMContextError {
  ecosystem: 'error';
  cwd: string;
  error: string;
}
type PMContext = PMContextJs | PMContextPy | PMContextEmpty | PMContextError;

function detectPM(cwd: string): PMContext {
  const pkgPath = resolve(cwd, 'package.json');
  const pyprojectPath = resolve(cwd, 'pyproject.toml');
  const hasPkg = existsSync(pkgPath);
  const hasPyproject = existsSync(pyprojectPath);

  if (hasPkg) {
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ecosystem: 'error', cwd, error: `package.json is not valid JSON: ${msg}` };
    }
    const hasPnpmLock = existsSync(resolve(cwd, 'pnpm-lock.yaml'));
    const hasNpmLock = existsSync(resolve(cwd, 'package-lock.json'));
    const hasYarnLock = existsSync(resolve(cwd, 'yarn.lock'));
    let installer: PMContextJs['installer'];
    if (hasPnpmLock) {
      // buildArgs is unused now — see stagesForJs which gates build-deps on the
      // presence of a packages/ dir. Kept on the type for backwards compat with
      // any future "workspace has shared packages" detection.
      installer = { cmd: 'pnpm', args: ['install', '--prefer-offline'] };
    } else if (hasYarnLock) {
      installer = { cmd: 'yarn', args: ['install', '--frozen-lockfile'] };
    } else if (hasNpmLock) {
      installer = { cmd: 'npm', args: ['ci'] };
    } else {
      installer = { cmd: 'npm', args: ['install'] };
    }
    return {
      ecosystem: 'js',
      cwd,
      installer,
      hasScript: (s) => Boolean(pkg.scripts?.[s]),
    };
  }

  if (hasPyproject) {
    const pyprojectText = readFileSync(pyprojectPath, 'utf8');
    return {
      ecosystem: 'py',
      cwd,
      hasUv: hasUvOnPath(),
      pyprojectText,
      hasMypyConfig:
        /\[tool\.mypy(\.|\])/.test(pyprojectText) ||
        /["']mypy(["'\s=<>~!,;]|$)/m.test(pyprojectText),
      hasPytest:
        /\[tool\.pytest/.test(pyprojectText) || existsSync(resolve(cwd, 'tests')),
      hasRuff:
        /\[tool\.ruff(\.|\])/.test(pyprojectText) ||
        /["']ruff(["'\s=<>~!,;]|$)/m.test(pyprojectText),
    };
  }

  return { ecosystem: 'none', cwd };
}

function hasUvOnPath(): boolean {
  const r = spawnSync('uv', ['--version'], { encoding: 'utf8', timeout: 3_000 });
  return r.status === 0;
}

interface BuiltStages {
  stages: StageDef[];
  error?: string;
}

function stagesForJs(gates: GateStage[], pm: PMContextJs): BuiltStages {
  const out: StageDef[] = [];
  out.push({ name: 'install', cmd: pm.installer.cmd, args: pm.installer.args });

  // build-deps stage is only relevant when the workspace has a `packages/` dir
  // with shared libraries that downstream apps consume via workspace deps. For
  // projects that use just `apps/web` (Next.js, Vite, etc.) with no shared
  // packages, this stage does nothing useful and the filter would propagate
  // through to `next build` (which doesn't understand `--filter`). v0.6.2.
  if (pm.installer.cmd === 'pnpm' && existsSync(resolve(pm.cwd, 'packages'))) {
    // pnpm's `--filter` MUST precede the action verb, otherwise the arg gets
    // passed through to whatever script the action invokes. Order matters.
    out.push({ name: 'build-deps', cmd: 'pnpm', args: ['--filter', './packages/*', '-r', 'build'] });
  }
  for (const g of gates) {
    if (g === 'typecheck') {
      if (pm.hasScript('typecheck')) {
        out.push({ name: 'typecheck', cmd: pm.installer.cmd, args: ['run', 'typecheck'], strict: true });
      } else if (existsSync(resolve(pm.cwd, 'tsconfig.json'))) {
        out.push({ name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], strict: true });
      } else {
        return { stages: [], error: `gate typecheck requested but repo has no \`typecheck\` script and no tsconfig.json` };
      }
    } else if (g === 'tests') {
      if (!pm.hasScript('test')) {
        return { stages: [], error: `gate tests requested but repo has no \`test\` script in package.json` };
      }
      out.push({ name: 'tests', cmd: pm.installer.cmd, args: ['run', 'test'] });
    } else if (g === 'lint') {
      if (!pm.hasScript('lint')) {
        return { stages: [], error: `gate lint requested but repo has no \`lint\` script in package.json` };
      }
      out.push({ name: 'lint', cmd: pm.installer.cmd, args: ['run', 'lint'], strict: true });
    }
  }
  return { stages: out };
}

/**
 * Python gate stages, modeled after the JS path:
 *   install   → `uv sync` if uv is on PATH; else `pip install -e ".[dev]"` falling
 *               back to `pip install -e .` if there's no [dev] extra. The current
 *               implementation just calls `uv sync` or skips install if no uv (we
 *               run tools directly and trust the operator has them globally).
 *   typecheck → `uv run mypy .` or `mypy .`. Only added if [tool.mypy] or mypy is
 *               listed in pyproject deps.
 *   tests     → `uv run pytest` or `pytest`. Always required when gates includes
 *               'tests' — if pyproject has no test config + no tests/ dir, we
 *               fail loudly rather than vacuously passing.
 *   lint      → `uv run ruff check` or `ruff check`. Requires [tool.ruff] declared.
 *
 * Why "uv run X" vs direct "X": uv creates a project-local venv at .venv/ and
 * `uv run` injects it into PATH for the subcommand. Without uv we trust globals.
 */
function stagesForPy(gates: GateStage[], pm: PMContextPy): BuiltStages {
  const out: StageDef[] = [];

  // install stage: uv sync with all extras + all groups so dev tools
  // ([project.optional-dependencies].dev OR [dependency-groups].dev) land in
  // the venv. No --frozen — bootstrap tasks won't have uv.lock yet on first run;
  // `uv sync` generates it if missing.
  if (pm.hasUv) {
    out.push({
      name: 'install',
      cmd: 'uv',
      args: ['sync', '--all-extras', '--all-groups', '--no-progress'],
    });
  }

  // After install, the project's declared dev deps (pytest-cov, pytest-asyncio,
  // mypy plugins, etc.) are in the venv. `uv run <tool>` uses that venv. If the
  // project doesn't list a tool as a dep, this fails — and that's correct, the
  // project owns its tooling. Without uv we trust globals.
  const runTool = (tool: string, rest: string[]): { cmd: string; args: string[] } => {
    if (pm.hasUv) return { cmd: 'uv', args: ['run', '--no-progress', tool, ...rest] };
    return { cmd: tool, args: rest };
  };

  for (const g of gates) {
    if (g === 'typecheck') {
      if (!pm.hasMypyConfig) {
        return { stages: [], error: `gate typecheck requested but pyproject.toml has no [tool.mypy] and mypy is not in dependencies` };
      }
      out.push({ name: 'typecheck', ...runTool('mypy', ['.']), strict: true });
    } else if (g === 'tests') {
      if (!pm.hasPytest) {
        return { stages: [], error: `gate tests requested but pyproject.toml has no [tool.pytest.*] config and no tests/ directory exists` };
      }
      out.push({ name: 'tests', ...runTool('pytest', []) });
    } else if (g === 'lint') {
      if (!pm.hasRuff) {
        return { stages: [], error: `gate lint requested but pyproject.toml has no [tool.ruff] config and ruff is not in dependencies` };
      }
      out.push({ name: 'lint', ...runTool('ruff', ['check', '.']), strict: true });
    }
  }
  return { stages: out };
}

function stagesFor(gates: GateStage[], pm: PMContext): BuiltStages {
  if (pm.ecosystem === 'error') {
    return { stages: [], error: pm.error };
  }
  if (pm.ecosystem === 'none') {
    if (gates.length > 0) {
      return {
        stages: [],
        error:
          `gate ${gates.join(',')} requested but working dir has no package.json AND no pyproject.toml — ` +
          `nothing to gate against`,
      };
    }
    return { stages: [] };
  }
  if (pm.ecosystem === 'js') return stagesForJs(gates, pm);
  return stagesForPy(gates, pm);
}

const TEST_FAILURE_RE = /(\b\d+\s+failed\b|\bfailed:\s*[1-9]|\d+\s+failing|\bFAIL\b\s)/i;
const TEST_PASS_MARKER_RE = /(Tests:\s+\d+\s+passed.*\btotal\b|^\s*\d+\s+passed\s*\(\d+m?s\)|\d+\s+passing|\d+\s+passed.*\bin\s+\d+\.\d+s)/im;

/**
 * For the `tests` stage: zero exit code → pass. Non-zero exit can still be a pass
 * if the runner clearly says "N passed" AND nowhere says "N failed" / FAIL — this
 * covers the vitest "TTS leak / unhandled rejection after all tests passed" pattern
 * that bit Jarvis. Pytest's summary line "N passed in 1.23s" also matches.
 * If we can't disambiguate, we trust the non-zero exit.
 */
function judgeTests(exitCode: number, log: string): { passed: boolean; note?: string } {
  if (exitCode === 0) return { passed: true };
  const hasFailure = TEST_FAILURE_RE.test(log);
  if (hasFailure) return { passed: false };
  const hasPositive = TEST_PASS_MARKER_RE.test(log);
  if (hasPositive) {
    return { passed: true, note: 'non-zero exit ignored: positive pass marker found, no failure marker' };
  }
  return { passed: false };
}

function runStage(stage: StageDef, cwd: string): { passed: boolean; durationMs: number; log: string; note?: string } {
  const start = Date.now();
  const res = spawnSync(stage.cmd, stage.args, {
    cwd,
    encoding: 'utf8',
    timeout: config.gateStageTimeoutMs,
    env: { ...process.env, CI: '1' },
  });
  const log = `[$ ${stage.cmd} ${stage.args.join(' ')}]\n${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  const exitCode = res.status ?? -1;

  // A spawn error (most importantly the timeout that SIGTERMs the child and
  // returns status=null) is an unconditional fail, regardless of any pass
  // marker in the partial stdout. Without this, judgeTests(-1, partialLog)
  // can match a "N passed" line printed before the process hung in teardown
  // and wrongly report the gate as passed.
  if (res.error || (res.status === null && res.signal != null)) {
    const errCode = (res.error as NodeJS.ErrnoException | undefined)?.code;
    const reason = res.error
      ? `${res.error.message}${errCode ? ` (${errCode})` : ''}`
      : `killed by signal ${res.signal} (likely gate stage timeout)`;
    return { passed: false, durationMs: Date.now() - start, log: `${log}\n[spawn error: ${reason}]`.trim() };
  }

  if (stage.name === 'tests' && !stage.strict) {
    const verdict = judgeTests(exitCode, log);
    return { passed: verdict.passed, durationMs: Date.now() - start, log, ...(verdict.note ? { note: verdict.note } : {}) };
  }
  return { passed: exitCode === 0, durationMs: Date.now() - start, log };
}

export function countTestsPassed(log: string): number | undefined {
  // Prefer the LAST "N passed" occurrence: when this receives concatenated
  // stage logs, installer/build output (pnpm peer-dep checks, lint summaries)
  // can print "N passed" before the tests stage, and the final summary line is
  // the one we want. Last match is the tests-stage summary.
  const matches = [...log.matchAll(/(\d+)\s+passed/gi)];
  const last = matches[matches.length - 1];
  if (!last || !last[1]) return undefined;
  return Number.parseInt(last[1], 10);
}

export interface RunGateOpts {
  /**
   * P7 flaky rerun. When true, a FAILED `tests` stage is re-run ONCE on the
   * identical tree before the gate is declared failed. If the rerun PASSES (the
   * verdict flipped with no tree change) the gate PASSES and is marked `flaky`
   * — the dispatcher surfaces the flake in the audit chain (`task.gate.flaky`)
   * instead of halting work; under machine load a single tests failure is more
   * often contention than a real break. A second failure is a deterministic
   * fail and routes to audit as usual. Only the `tests` stage is reran
   * (typecheck/lint are deterministic by construction).
   */
  rerunFlakyTests?: boolean;
  /** Test seam: shrink the heavy-gate lock's wait budget / poll interval. */
  _lockOpts?: HeavyGateLockOpts;
}

// Stages serialized machine-wide via the heavy-gate lock. These are the
// CPU-saturating ones whose concurrent execution flips load-sensitive test
// verdicts (see heavy-gate-lock.ts). The tests-rerun stage runs under the same
// hold — the lock is acquired at the first heavy stage and held to gate end.
const HEAVY_GATE_STAGES = new Set(['install', 'typecheck', 'tests']);

export function runGate(task: ParsedTask, cwd: string, opts: RunGateOpts = {}): GateResult {
  if (task.gates === 'none') {
    return { passed: true, stages: [], failureLog: '' };
  }
  const pm = detectPM(cwd);
  const built = stagesFor(task.gates, pm);
  if (built.error) {
    return {
      passed: false,
      stages: [{ name: 'preflight', passed: false, durationMs: 0, log: built.error }],
      failureLog: built.error,
    };
  }
  const results: GateResult['stages'] = [];
  let lock: HeavyGateLock | null = null;
  let flakyTimings: { firstRunMs: number; rerunMs: number } | null = null;
  const lockFields = (): Partial<GateResult> =>
    lock?.timedOut
      ? {
          lockTimedOut: true,
          lockWaitedMs: lock.waitedMs,
          ...(lock.ownerPid !== undefined ? { lockOwnerPid: lock.ownerPid } : {}),
        }
      : {};
  const flakyFields = (): Partial<GateResult> =>
    flakyTimings
      ? { flaky: true, flakyDetail: { firstPassed: false, secondPassed: true, ...flakyTimings } }
      : {};
  try {
    for (const s of built.stages) {
      // Machine-wide heavy-gate lock: acquired once, at the first heavy stage.
      // A timeout (live owner held it for the full budget) PROCEEDS unlocked —
      // surfaced on the result so the dispatcher audits task.gate.lock_timeout.
      if (lock === null && HEAVY_GATE_STAGES.has(s.name)) {
        lock = acquireHeavyGateLock(opts._lockOpts);
      }
      const r = runStage(s, cwd);
      results.push({ name: s.name, passed: r.passed, durationMs: r.durationMs, log: r.log });
      if (!r.passed) {
        // Flaky rerun: a failed tests stage is re-run once on the unchanged
        // tree. A flip (now passes) is a flaky-PASS — the gate proceeds, and
        // the flake stays visible via flaky/flakyDetail → task.gate.flaky.
        if (s.name === 'tests' && opts.rerunFlakyTests) {
          const second = runStage(s, cwd);
          results.push({ name: 'tests-rerun', passed: second.passed, durationMs: second.durationMs, log: second.log });
          if (second.passed) {
            flakyTimings = { firstRunMs: r.durationMs, rerunMs: second.durationMs };
            continue;
          }
        }
        const failureLog = `Gate failed at stage "${s.name}":\n${r.log}`;
        return { passed: false, stages: results, failureLog, ...lockFields() };
      }
    }
    return { passed: true, stages: results, failureLog: '', ...flakyFields(), ...lockFields() };
  } finally {
    lock?.release();
  }
}
