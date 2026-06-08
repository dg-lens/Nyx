/**
 * Pre-flight checks — fail at dispatch time instead of wasting a Claude run
 * on a precondition that was never going to pass.
 *
 * Currently runs two checks:
 *
 * 1. Install probe — if the working dir has a `package.json`, run
 *    `pnpm install --prefer-offline`. If it has a `pyproject.toml`, run
 *    `uv sync --all-extras --all-groups`. Any non-zero exit is a preflight
 *    failure; the audit phase kicks in and either heuristically fixes the
 *    install problem (pnpm config drift, missing devDep, etc.) or halts.
 *
 * 2. Env-var presence — for any task with `[env: NAME1, NAME2]`, verify each
 *    name is present in the resolved Bitwarden project's secrets. Without the
 *    env var, downstream code references will throw; failing here is faster
 *    than discovering it from a runtime stack trace.
 *
 * Both checks emit `task.preflight.failed` on miss; the caller (dispatchOne)
 * treats the result the same as any other recoverable failure and lets the
 * audit phase decide.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { audit } from './audit.js';
import { parseReadingRefs, resolveReadingRefs } from './reading-resolver.js';
import { fetchProjectSecretValues } from './secrets/bitwarden-client.js';
import { resolveProject } from './secrets/project-registry.js';
import type { ParsedTask } from './types.js';

const INSTALL_TIMEOUT_MS = 90_000;

/** Cap the install-probe failure log so it can't dump an unbounded blob into the
 *  audit row + Slack. The audit excerpt is already 500 chars; the propagated
 *  failureLog (run-once.ts task.failed) is uncapped, so cap it here at the source. */
const INSTALL_LOG_MAX = 4_000;

/** Env-var names whose values must never reach the install probe's stdout/stderr.
 *  Substring-matched, case-insensitive, against every env key. Two layers:
 *  (1) such vars are stripped from the probe's env so a registry/index URL can't
 *  interpolate them, and (2) any surviving value is redacted from captured output. */
const SECRET_ENV_PATTERNS = [
  'TOKEN',
  'KEY',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'AUTH',
];

function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_ENV_PATTERNS.some((p) => upper.includes(p));
}

/** Env for the install probe with secret-bearing vars removed, so a package
 *  manager resolving a creds-embedded registry/index URL can't echo them. */
function minimizedInstallEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isSecretEnvName(name)) continue;
    out[name] = value;
  }
  return out;
}

/** Redact any non-trivial secret env value that survived into captured output. */
function redactSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!isSecretEnvName(name)) continue;
    out = out.split(value).join(`<redacted:${name}>`);
  }
  return out;
}

export interface PreflightResult {
  /** True iff every check passed. */
  passed: boolean;
  /** When `passed === false`, this is the failure log emitted via task.failed. */
  failureLog?: string;
}

export function runPreflight(task: ParsedTask, workingDir: string): PreflightResult {

  // ── Reading-tag resolution check (v0.12) ──
  // Type-agnostic — runs regardless of task type or working-dir shape. Fails fast
  // if any [reading:] reference can't be resolved before burning Claude compute.
  if (task.reading && task.reading.length > 0) {
    const readingResult = checkReadingTag(task);
    if (!readingResult.passed) {
      audit('task.preflight.failed', 'preflight', {
        taskId: task.id,
        check: 'reading_tag',
        failure_log_excerpt: readingResult.failureLog?.slice(0, 500),
      });
      return readingResult;
    }
  }

  // ── Env-var presence ──
  // Type-agnostic — queries Bitwarden, not the working dir — so it must run
  // BEFORE the hasCodeProject early return. Assistant/content tasks run in an
  // empty outputs dir and analysis clones may lack a manifest; declaring
  // [env: NAME] on any of them must still be verified.
  if (task.envVars && task.envVars.length > 0) {
    const envResult = checkEnvVars(task);
    if (!envResult.passed) {
      audit('task.preflight.failed', 'preflight', {
        taskId: task.id,
        check: 'env-vars',
        failure_log_excerpt: envResult.failureLog?.slice(0, 500),
      });
      return envResult;
    }
  }

  // Skip code-project checks for tasks without a working code dir
  // (assistant + content + output-only tasks).
  if (!hasCodeProject(workingDir)) {
    return { passed: true };
  }

  // ── Install probe ──
  const installResult = runInstallProbe(workingDir);
  if (!installResult.passed) {
    audit('task.preflight.failed', 'preflight', {
      taskId: task.id,
      check: 'install',
      failure_log_excerpt: installResult.failureLog?.slice(0, 500),
    });
    return installResult;
  }

  return { passed: true };
}

function hasCodeProject(workingDir: string): boolean {
  return (
    existsSync(join(workingDir, 'package.json')) ||
    existsSync(join(workingDir, 'pyproject.toml'))
  );
}

function runInstallProbe(workingDir: string): PreflightResult {
  if (existsSync(join(workingDir, 'package.json'))) {
    return runCmd('pnpm install --prefer-offline', workingDir);
  }
  if (existsSync(join(workingDir, 'pyproject.toml'))) {
    return runCmd('uv sync --all-extras --all-groups --no-progress', workingDir);
  }
  return { passed: true };
}

function runCmd(cmd: string, cwd: string): PreflightResult {
  try {
    execSync(cmd, {
      cwd,
      stdio: 'pipe',
      timeout: INSTALL_TIMEOUT_MS,
      encoding: 'utf8',
      env: minimizedInstallEnv(),
    });
    return { passed: true };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message: string };
    const stdout = e.stdout?.toString() ?? '';
    const stderr = e.stderr?.toString() ?? '';
    const log = redactSecrets(
      `Pre-flight install probe failed: \`${cmd}\`\n\n` +
        `stderr:\n${stderr}\n\nstdout:\n${stdout}\n\nerror: ${e.message}`,
    );
    return {
      passed: false,
      failureLog: log.length > INSTALL_LOG_MAX ? `${log.slice(0, INSTALL_LOG_MAX)}\n…[truncated]` : log,
    };
  }
}

function checkReadingTag(task: ParsedTask): PreflightResult {
  if (!task.reading || task.reading.length === 0) return { passed: true };

  let refs;
  try {
    refs = parseReadingRefs(task.reading.join(','));
  } catch (err) {
    return {
      passed: false,
      failureLog: `Pre-flight reading-tag check: malformed reference — ${(err as Error).message}`,
    };
  }

  const { missing } = resolveReadingRefs(refs);
  if (missing.length === 0) return { passed: true };

  return {
    passed: false,
    failureLog:
      `Pre-flight reading-tag check failed: ${missing.length} reference(s) could not be resolved:\n` +
      missing.map(r => `  - "${r.raw}"`).join('\n') +
      '\n\nVerify the referenced files/sections exist at the expected paths before re-queuing.',
  };
}

function checkEnvVars(task: ParsedTask): PreflightResult {
  if (!task.envVars || task.envVars.length === 0) return { passed: true };

  const project = resolveProject(task);
  if (!project) {
    return {
      passed: false,
      failureLog:
        `Task declares [env: ${task.envVars.join(', ')}] but no Bitwarden project is mapped. ` +
        `Add a [bw-project: <name>] tag or register the repo via the bitwarden_projects table.`,
    };
  }

  let secrets: Record<string, string>;
  try {
    secrets = fetchProjectSecretValues(project.bw_project_id, project.token_path);
  } catch (err) {
    return {
      passed: false,
      failureLog: `Pre-flight env-var check: bws secret list failed: ${(err as Error).message}`,
    };
  }

  const missing = task.envVars.filter((name) => !(name in secrets));
  if (missing.length === 0) return { passed: true };

  return {
    passed: false,
    failureLog:
      `Pre-flight env-var check failed: missing from Bitwarden project '${project.name}': ` +
      `${missing.join(', ')}.\n\n` +
      `Add via:\n` +
      missing
        .map(
          (n) =>
            `  BWS_ACCESS_TOKEN=$(cat ${project.token_path}) \\\n    bws secret create ${n} '<value>' ${project.bw_project_id}`,
        )
        .join('\n'),
  };
}
