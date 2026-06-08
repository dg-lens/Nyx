/**
 * Audit phase — runs immediately after `task.failed`.
 *
 * Flow:
 *   1. Heuristic classifier (audit-classifier.ts) reads the failure log.
 *   2. If `auto-fixable`, apply the structural patch in the working dir and
 *      re-spawn Claude with the ORIGINAL task prompt + a postscript explaining
 *      the patch already applied. Claude takes over from where the prior agent
 *      left off, finishes the work, re-runs the gate.
 *   3. If `operator-required` or `unknown`, escalate to the Claude diagnostic
 *      agent (Opus, lower-context, narrowly-scoped). It either applies its own
 *      fix and resumes, OR writes an operator report and halts.
 *   4. Audit cap: at most 2 audit passes per task. After 2, halt unconditionally.
 *
 * The audit-runner DOES NOT decide whether to halt the chain — it only returns
 * a result. The caller (cli/run-once.ts) decides chain-blocking based on the
 * AuditOutcome.kind.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { audit } from './audit.js';
import {
  classifyFailure,
  type AutofixHint,
  type ClassifiedFailure,
  type FailureClass,
} from './audit-classifier.js';
import { config } from './config.js';
import { detectMainBranch } from './git-ops.js';
import { spawnWithTimeout } from './spawn-helpers.js';
import { buildSpawnInvocation } from './task-runner.js';
import type { ParsedTask } from './types.js';

const MAX_AUDIT_PASSES = 2;
// v0.8.x: bumped from 5 → 10 min. Initial 5-min cap was too tight for
// non-trivial migrations — Opus would routinely complete in 3-4 min on simple
// fixes but hit the wall on tasks with many files to inspect/rewrite. The
// SIGTERM kills the process mid-thought, claude's stdout buffer never flushes,
// and the audit-runner sees empty output → "unparseable diagnostic" → halt.
// 10 min gives real room while still bounded.
const AUDIT_TIMEOUT_MS = 10 * 60_000;

export type AuditOutcome =
  | {
      kind: 'autofix_applied';
      pattern: string;
      classification: FailureClass;
    }
  | {
      kind: 'escalated_to_halt';
      pattern?: string;
      operatorReport: string;
    }
  | {
      kind: 'audit_failed';
      reason: string;
    };

export interface AuditContext {
  task: ParsedTask;
  /** The working directory of the failed task (clone or worktree). */
  workingDir: string;
  /** The full failure log emitted with task.failed. */
  failureLog: string;
  /**
   * The original prompt Nyx built for the failed task — needed so the
   * audit-runner can re-spawn Claude with it as context.
   */
  originalPrompt: string;
  /** How many audit passes have already run on this task. */
  priorAuditPasses: number;
}

/** Top-level entry. */
export async function runAudit(ctx: AuditContext): Promise<AuditOutcome> {
  if (ctx.priorAuditPasses >= MAX_AUDIT_PASSES) {
    audit('task.audit.escalated', 'audit-runner', {
      taskId: ctx.task.id,
      reason: `audit cap reached (${MAX_AUDIT_PASSES} passes)`,
    });
    return {
      kind: 'escalated_to_halt',
      operatorReport: `Audit cap reached: this task has been audited ${MAX_AUDIT_PASSES} times without producing a green run. Manual intervention required. The most recent failure log:\n\n${ctx.failureLog.slice(0, 2000)}`,
    };
  }

  audit('task.audit.started', 'audit-runner', {
    taskId: ctx.task.id,
    pass: ctx.priorAuditPasses + 1,
    failure_log_excerpt: ctx.failureLog.slice(0, 500),
  });

  const classification = classifyFailure(ctx.failureLog);

  audit('task.audit.classified', 'audit-runner', {
    taskId: ctx.task.id,
    pattern: classification.pattern ?? null,
    classification: classification.kind,
  });

  if (classification.kind === 'auto-fixable' && classification.autofix) {
    return await runAutofix(ctx, classification);
  }

  if (classification.kind === 'operator-required' && classification.operatorReport) {
    audit('task.audit.escalated', 'audit-runner', {
      taskId: ctx.task.id,
      pattern: classification.pattern,
      reason: 'operator-required class',
    });
    return {
      kind: 'escalated_to_halt',
      pattern: classification.pattern,
      operatorReport: classification.operatorReport,
    };
  }

  // Unknown — fall through to the Claude diagnostic agent.
  return await runDiagnosticAgent(ctx);
}

// ────────────────────────────────────────────────────────────────────────────
// Heuristic autofixes
// ────────────────────────────────────────────────────────────────────────────

async function runAutofix(
  ctx: AuditContext,
  classification: ClassifiedFailure,
): Promise<AuditOutcome> {
  if (!classification.autofix) {
    return {
      kind: 'audit_failed',
      reason: 'auto-fixable classification missing autofix hint',
    };
  }
  try {
    applyAutofix(ctx.workingDir, classification.autofix, ctx.task);
    audit('task.audit.autofix.applied', 'audit-runner', {
      taskId: ctx.task.id,
      pattern: classification.pattern,
      autofix_kind: classification.autofix.kind,
    });
    return {
      kind: 'autofix_applied',
      pattern: classification.pattern ?? 'unknown',
      classification: classification.kind,
    };
  } catch (err) {
    audit('task.audit.autofix.failed', 'audit-runner', {
      taskId: ctx.task.id,
      pattern: classification.pattern,
      reason: (err as Error).message,
    });
    return {
      kind: 'audit_failed',
      reason: `autofix ${classification.autofix.kind} threw: ${(err as Error).message}`,
    };
  }
}

function applyAutofix(cwd: string, hint: AutofixHint, task: ParsedTask): void {
  switch (hint.kind) {
    case 'rewrite-pnpm-workspace': {
      rewritePnpmWorkspace(cwd);
      regenerateLockfileIfPnpm(cwd, task.id);
      return;
    }
    case 'add-pnpm-build-approval': {
      addPnpmBuildApproval(cwd, hint.packages);
      regenerateLockfileIfPnpm(cwd, task.id);
      return;
    }
    case 'regenerate-pnpm-lockfile': {
      regenerateLockfileIfPnpm(cwd, task.id);
      return;
    }
    case 'add-devdep': {
      addDevDeps(cwd, hint.packages);
      regenerateLockfileIfPnpm(cwd, task.id);
      return;
    }
    case 'rebase-against-main': {
      const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      // A self-task (~/Nyx) has no `origin` remote — rebasing against an
      // origin ref is impossible. Escalate rather than abort silently.
      const hasOrigin = (() => {
        try {
          const remotes = execSync('git remote', { cwd, stdio: 'pipe', timeout: 10_000, env: gitEnv });
          return remotes.toString().split('\n').some((r) => r.trim() === 'origin');
        } catch {
          return false;
        }
      })();
      if (!hasOrigin) {
        throw new Error(
          'rebase-against-main: no `origin` remote (likely a self-task); cannot rebase against a remote base — operator must resolve manually',
        );
      }
      // Resolve the base the same way finalize.ts/git-ops.ts do: per-repo
      // override first, else origin/HEAD (via detectMainBranch). Repos whose
      // default branch is not `main` (master, dev, release/*) would otherwise
      // fail to find `origin/main`.
      const baseBranch = (task.repo ? config.gitTargets[task.repo]?.baseBranch : undefined) ?? detectMainBranch();
      const baseRef = `origin/${baseBranch}`;
      execSync('git fetch origin', { cwd, stdio: 'pipe', timeout: 60_000, env: gitEnv });
      // Caller already aborted the merge, so this is a clean re-rebase.
      execSync(`git rebase ${baseRef} || git rebase --abort`, {
        cwd,
        stdio: 'pipe',
        timeout: 60_000,
        env: gitEnv,
      });
      return;
    }
    case 'add-mypy-plugin': {
      addMypyPlugin(cwd, hint.plugin);
      return;
    }
    case 'claude-rerun-with-context': {
      // No-op here — the caller re-invokes Claude with the postscript.
      return;
    }
  }
}

// ---------- specific autofix implementations ----------

function rewritePnpmWorkspace(cwd: string): void {
  const path = join(cwd, 'pnpm-workspace.yaml');
  const existing = readPnpmWorkspaceYaml(cwd);
  const allow = existing.allowBuilds ?? {};
  // Merge any "set this to true or false" placeholders to true (best guess).
  for (const k of Object.keys(allow)) {
    if (allow[k] !== true && allow[k] !== false) allow[k] = true;
  }
  // Merge old onlyBuiltDependencies into allow if present.
  for (const k of existing.onlyBuiltDependencies ?? []) {
    if (allow[k] == null) allow[k] = true;
  }
  const yaml = renderPnpmWorkspaceYaml({
    packages: ['.'],
    allowBuilds: allow,
  });
  writeFileSync(path, yaml);
}

function addPnpmBuildApproval(cwd: string, packages: string[]): void {
  const existing = readPnpmWorkspaceYaml(cwd);
  const allow = existing.allowBuilds ?? {};
  for (const p of packages) allow[p] = true;
  const yaml = renderPnpmWorkspaceYaml({
    packages: existing.packages ?? ['.'],
    allowBuilds: allow,
  });
  writeFileSync(join(cwd, 'pnpm-workspace.yaml'), yaml);
}

function addDevDeps(cwd: string, packages: string[]): void {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error('package.json not found');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.devDependencies = pkg.devDependencies ?? {};
  for (const p of packages) {
    if (!pkg.devDependencies[p] && !(pkg.dependencies?.[p])) {
      pkg.devDependencies[p] = '*';
    }
  }
  // Re-sort devDependencies alphabetically for stability.
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(pkg.devDependencies).sort()) {
    sorted[k] = pkg.devDependencies[k];
  }
  pkg.devDependencies = sorted;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function addMypyPlugin(cwd: string, plugin: string): void {
  const pyproj = join(cwd, 'pyproject.toml');
  if (!existsSync(pyproj)) return;
  const text = readFileSync(pyproj, 'utf8');
  if (text.includes(plugin)) return;
  // Naive: append plugin to existing plugins line or add one.
  const pluginsRe = /^plugins\s*=\s*\[(.*)\]/m;
  let next: string;
  if (pluginsRe.test(text)) {
    next = text.replace(pluginsRe, (_full, inner) => {
      const list = inner.trim();
      const sep = list.length > 0 ? ', ' : '';
      return `plugins = [${list}${sep}"${plugin}"]`;
    });
  } else if (/^\[tool\.mypy\]/m.test(text)) {
    next = text.replace(/^\[tool\.mypy\]/m, `[tool.mypy]\nplugins = ["${plugin}"]`);
  } else {
    next = text + `\n\n[tool.mypy]\nplugins = ["${plugin}"]\n`;
  }
  writeFileSync(pyproj, next);
}

function regenerateLockfileIfPnpm(cwd: string, taskId: string): void {
  if (!existsSync(join(cwd, 'package.json'))) return;
  try {
    execSync('pnpm install --lockfile-only --prefer-offline', {
      cwd,
      stdio: 'pipe',
      timeout: 60_000,
    });
  } catch (err) {
    // Non-fatal — the caller's gate retry will surface install errors clearly.
    audit('task.audit.autofix.failed', 'audit-runner', {
      taskId,
      reason: `pnpm install --lockfile-only failed: ${(err as Error).message}`,
    });
  }
}

interface PnpmWorkspaceYaml {
  packages?: string[];
  allowBuilds?: Record<string, boolean | string>;
  onlyBuiltDependencies?: string[];
}

function readPnpmWorkspaceYaml(cwd: string): PnpmWorkspaceYaml {
  const path = join(cwd, 'pnpm-workspace.yaml');
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  // Hand-roll a minimal YAML reader for the three keys we care about. We could
  // add a yaml dep but this avoids the pnpm-install dance on the dispatcher.
  const out: PnpmWorkspaceYaml = {};
  const lines = text.split('\n');
  let section: 'packages' | 'allowBuilds' | 'onlyBuiltDependencies' | null = null;
  for (const line of lines) {
    if (/^packages:/.test(line)) section = 'packages';
    else if (/^allowBuilds:/.test(line)) section = 'allowBuilds';
    else if (/^onlyBuiltDependencies:/.test(line)) section = 'onlyBuiltDependencies';
    else if (/^\S/.test(line)) section = null;
    else if (section === 'packages') {
      const m = line.match(/-\s*['"]?([^'"\s]+)['"]?/);
      if (m?.[1]) (out.packages ??= []).push(m[1]);
    } else if (section === 'allowBuilds') {
      const m = line.match(/^\s+(\S+):\s*(.*)$/);
      if (m?.[1]) {
        (out.allowBuilds ??= {})[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : m[2] ?? '';
      }
    } else if (section === 'onlyBuiltDependencies') {
      const m = line.match(/-\s*([^\s]+)/);
      if (m?.[1]) (out.onlyBuiltDependencies ??= []).push(m[1]);
    }
  }
  return out;
}

function renderPnpmWorkspaceYaml(content: PnpmWorkspaceYaml): string {
  const lines: string[] = [];
  if (content.packages?.length) {
    lines.push('packages:');
    for (const p of content.packages) lines.push(`  - '${p}'`);
  }
  if (content.allowBuilds && Object.keys(content.allowBuilds).length > 0) {
    if (lines.length) lines.push('');
    lines.push('allowBuilds:');
    for (const k of Object.keys(content.allowBuilds).sort()) {
      lines.push(`  ${k}: ${content.allowBuilds[k] === false ? 'false' : 'true'}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ────────────────────────────────────────────────────────────────────────────
// Diagnostic agent (Opus, narrow scope)
// ────────────────────────────────────────────────────────────────────────────

async function runDiagnosticAgent(ctx: AuditContext): Promise<AuditOutcome> {
  const prompt = buildDiagnosticPrompt(ctx);
  const claudeArgs = [
    '-p',
    prompt,
    '--model',
    'opus',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    ctx.workingDir,
  ];

  // Re-use buildSpawnInvocation so BWS secrets still inject (the diagnostic
  // agent may need them to verify configs or re-run the task fully). It also
  // routes around the bws-shell-wrapping pitfall that v0.6.8 fixed.
  const { command, args, extraEnv } = buildSpawnInvocation(ctx.task, claudeArgs);

  const result = await spawnDiagnostic(command, args, ctx.workingDir, extraEnv);

  // Parse the diagnostic agent's structured response. Convention:
  //   - Exit 0  + stdout contains "VERDICT: fixed"     → autofix_applied
  //   - Exit 0  + stdout contains "VERDICT: halt: …"   → escalated_to_halt
  //   - Anything else                                  → escalated_to_halt with raw report
  const verdict = parseDiagnosticVerdict(result.stdout);

  if (verdict.kind === 'fixed') {
    audit('task.audit.autofix.applied', 'audit-runner', {
      taskId: ctx.task.id,
      pattern: 'claude-diagnostic',
      autofix_kind: 'claude-rerun-with-context',
      note: verdict.note,
    });
    return {
      kind: 'autofix_applied',
      pattern: 'claude-diagnostic',
      classification: 'unknown',
    };
  }

  audit('task.audit.escalated', 'audit-runner', {
    taskId: ctx.task.id,
    pattern: 'claude-diagnostic',
    reason: verdict.kind === 'halt' ? verdict.note : 'unparseable diagnostic',
  });
  return {
    kind: 'escalated_to_halt',
    pattern: 'claude-diagnostic',
    operatorReport:
      verdict.kind === 'halt'
        ? verdict.note
        : `Diagnostic agent produced an unparseable verdict. Raw output:\n\n${result.stdout.slice(0, 2000)}\n\nStderr:\n\n${result.stderr.slice(0, 1000)}`,
  };
}

function buildDiagnosticPrompt(ctx: AuditContext): string {
  return `# Nyx audit pass

A code task failed and Nyx is asking you (running on Opus) to diagnose and, if possible, finish the work — stepping into the originally dispatched agent's place.

## The original task

\`\`\`
${ctx.originalPrompt}
\`\`\`

## The failure log

\`\`\`
${ctx.failureLog.slice(0, 4000)}
\`\`\`

## STEP 0 — Consult the Arachne memory graph BEFORE forming a hypothesis

The stack's memory is a knowledge graph at \`~/Nyx/Data/memory\` (nodes + MOCs, read via the \`memory_*\` MCP tools). \`lesson\` and \`invariant\` nodes record past failures, the fix that worked, and the wrong paths (\`ANTI:\`) tried along the way. Many recurring bug-classes are already nodes.

Required before suggesting any fix:

1. Query the graph for the failure: \`memory_search\` on keywords from the failure log, or grep \`~/Nyx/Data/memory/nodes/\` for the error substring.
2. If a node matches, read its \`FIX:\` and \`ANTI:\` sections in full.
3. If your intended approach matches a documented \`ANTI:\` (a wrong path) — **DO NOT do it again**. Pick a different approach.

This is not optional. Many failure classes (fly token scope, supabase ES256, CORS subdomain aliases, env-var name drift, double /rest/v1) are already nodes with the correct fix. Re-discovering them wastes operator time and Anthropic budget.

## STEP 1 — Diagnose + fix

The working directory (\`${ctx.workingDir}\`) is preserved from the failed attempt. Files the prior agent wrote are still there.

1. Inspect the failure log and working dir. Figure out what went wrong.
2. If you can fix it: make the patch, then COMPLETE the original task. The work is not done — the prior agent failed before finishing. You must produce the artifacts the task description asked for. Nyx will re-run the gate after you exit; if it passes, the task is considered complete.
3. If you cannot fix it without operator input (missing env var, broken external service, ambiguous spec, etc.): do not flail. Exit with a clear verdict.

## STEP 2 — Write a memory node if your fix is non-trivial

If your diagnosis involved real debugging (not just "ran missing command"), write a \`lesson\` node to \`~/Nyx/Data/memory/nodes/<id>.md\` (scope-meaningful kebab id, no date prefix) via \`memory_write\` or directly, with the body skeleton:

- \`SYMPTOM:\` the literal error string + user-visible behavior
- \`CAUSE:\` root cause, not surface
- \`ANTI:\` wrong fixes attempted (tried-and-failed, or considered+rejected) — the highest-value section
- \`FIX:\` what actually worked, with commands/snippets
- \`CHECK:\` how to verify / a regression guard

Set \`loc\`, \`pattern_signature\` (grep-friendly error substring), \`provenance: agent\`, \`confidence: medium\`. This makes your debugging permanent capacity — future agents won't repeat it.

If your fix is trivial (typo, missing import, etc.), skip the memory entry.

## Output protocol

Your LAST line of output MUST be one of:

  VERDICT: fixed — <one-sentence note about what you changed>
  VERDICT: halt: <one-paragraph operator report — what they need to do, then run nyx-resume>

Do not commit. Do not push. Nyx handles those after the gate re-runs.

If you spend more than 4 minutes on a single fix without progress, halt instead.
`;
}

function parseDiagnosticVerdict(stdout: string):
  | { kind: 'fixed'; note: string }
  | { kind: 'halt'; note: string }
  | { kind: 'unparseable' } {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const fixedMatch = line.match(/^VERDICT:\s*fixed\s*[—:-]?\s*(.*)$/i);
    if (fixedMatch) return { kind: 'fixed', note: (fixedMatch[1] ?? '').trim() };
    const haltMatch = line.match(/^VERDICT:\s*halt\s*[—:-]?\s*(.*)$/i);
    if (haltMatch) return { kind: 'halt', note: (haltMatch[1] ?? '').trim() };
  }
  return { kind: 'unparseable' };
}

function spawnDiagnostic(
  command: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Auth pass-through: if ANTHROPIC_API_KEY is set the diagnostic `claude -p`
  // uses API billing; if absent it falls back to the host's ~/.claude OAuth.
  // See task-runner.ts::invokeClaude for the model.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
    ...extraEnv,
  };
  return spawnWithTimeout(command, args, {
    cwd,
    env: spawnEnv,
    captureStdout: true,
    label: 'audit',
  }, AUDIT_TIMEOUT_MS);
}

// ────────────────────────────────────────────────────────────────────────────
// Used by callers to count prior audit passes from the audit DB.
// Importing here keeps audit-runner.ts the single owner of the cap.
// ────────────────────────────────────────────────────────────────────────────
export { MAX_AUDIT_PASSES };
