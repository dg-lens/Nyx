/**
 * Pipeline dependency install.
 *
 * Pipeline runs bypass the per-task `preflight.ts` install probe (they route
 * straight into the orchestrator), and the smoke verifier is sandboxed read-only
 * ("do NOT install missing modules"). So nothing ever ran `npm install` on the
 * integration base — a greenfield Node project's smoke gate would fail on
 * "Cannot find module" because `node_modules` was never created. This module is
 * the pipeline's install step: run it on the integration base before smoke so the
 * gate (and the operator's eventual `npm run dev`) sees real dependencies.
 *
 * `detectInstallCommands` is pure (fs reads only) and unit-tested. `installDeps`
 * is the side-effectful runner with an injectable exec seam for tests.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface InstallCommandResult {
  cmd: string;
  ok: boolean;
  log: string;
}

export interface InstallResult {
  ran: InstallCommandResult[];
  ok: boolean;
}

/** True when the project declares Playwright — its browser binaries are a
 * separate download (`npx playwright install`), not covered by `npm install`. */
function hasPlaywright(baseDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(baseDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return '@playwright/test' in deps || 'playwright' in deps;
  } catch {
    return false;
  }
}

/**
 * Ordered install commands for whatever ecosystems the base declares. Node
 * package-manager is chosen by lockfile (pnpm > yarn > npm); Playwright browsers
 * follow the node install; Python via uv. Empty when there's nothing to install.
 */
export function detectInstallCommands(baseDir: string): string[] {
  const cmds: string[] = [];
  if (existsSync(resolve(baseDir, 'package.json'))) {
    if (existsSync(resolve(baseDir, 'pnpm-lock.yaml'))) cmds.push('pnpm install --prefer-offline');
    else if (existsSync(resolve(baseDir, 'yarn.lock'))) cmds.push('yarn install');
    else cmds.push('npm install');
    if (hasPlaywright(baseDir)) cmds.push('npx --yes playwright install chromium');
  }
  if (existsSync(resolve(baseDir, 'pyproject.toml'))) {
    cmds.push('uv sync --all-extras --all-groups --no-progress');
  }
  return cmds;
}

const INSTALL_TIMEOUT_MS = 12 * 60_000;

function realExec(cmd: string, cwd: string): InstallCommandResult {
  try {
    const out = execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS });
    return { cmd, ok: true, log: out.slice(-2000) };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return { cmd, ok: false, log: (e.stderr || e.stdout || e.message || 'install failed').slice(-2000) };
  }
}

export interface InstallDepsDeps {
  /** Injectable exec (tests). Defaults to a real, timeout-bounded execSync. */
  exec?: (cmd: string, cwd: string) => InstallCommandResult;
}

/**
 * Run the detected install commands on `baseDir`, in order. Best-effort: a
 * failing command is recorded but does not throw — the smoke gate surfaces the
 * real consequence (a broken install → module-not-found → red gate). Returns the
 * per-command results + an overall `ok`. No-op (ok:true, ran:[]) when there's
 * nothing to install.
 */
export function installDeps(baseDir: string, deps: InstallDepsDeps = {}): InstallResult {
  const exec = deps.exec ?? realExec;
  const ran: InstallCommandResult[] = [];
  for (const cmd of detectInstallCommands(baseDir)) {
    ran.push(exec(cmd, baseDir));
  }
  return { ran, ok: ran.every((r) => r.ok) };
}
