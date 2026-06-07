/**
 * Pipeline shipping stage (⑦⑧) — drive the held tasks to green, or escalate to
 * the review gate.
 *
 * Flow (scaffold/prompt-to-product-pipeline.md):
 *   - Composer redux flagged the catastrophic short-circuit → straight to the
 *     review gate (skip R1/R2). The human decides; the agent only escalated.
 *   - Otherwise: smoke (the project gate, run by an INDEPENDENT supervisor —
 *     never coder self-report) + held-task diagnostics in up to
 *     MAX_AUTONOMOUS_DIAGNOSTIC_ROUNDS rounds (R1, R2). Each round fixes the held
 *     tasks toward the remediation plan, then RE-RUNS redux (the in-pipeline loop
 *     that stops fix-A-rebreaks-B oscillation). Green (smoke passes + nothing
 *     held) → done. Still broken after R1+R2 → the review gate (R3 lives behind
 *     it, as a `fix` corrective wave).
 *
 * `runShipping` (the loop) is the testable core — `diagnose` + `smoke` are
 * dependency-injected. `buildReviewBrief` is pure. The real defaults spawn the
 * audit-phase diagnostic + an independent supervisor.
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import { pipelineRunEnv } from './run-secrets.js';
import { installDeps } from './install-deps.js';
import { updateRun } from './db.js';
import { extractJson, parsePlanJson } from './flight-plan.js';
import { type RemediationDirective } from './redux.js';
import type { PipelineRun } from './types.js';

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').toLowerCase();
}

export const MAX_AUTONOMOUS_DIAGNOSTIC_ROUNDS = 2;
const DIAGNOSTIC_TIMEOUT_MS = 20 * 60_000;
const SMOKE_TIMEOUT_MS = 15 * 60_000;
const DIAGNOSTIC_MODEL = 'opus';
const SMOKE_MODEL = 'sonnet';
const SMOKE_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite'];
const DIAGNOSTIC_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'MultiEdit', 'TodoWrite'];

export type ShipReason = 'catastrophic' | 'unresolved';

export interface SmokeResult {
  passed: boolean;
  summary: string;
  failures: string[];
}

export type ShipOutcome =
  | { kind: 'green'; smoke: SmokeResult }
  | { kind: 'review'; reason: ShipReason; brief: string; headline: string };

export interface ShippingDeps {
  /** Independent supervisor runs the project gate on the integration branch. */
  smoke?: (run: PipelineRun) => Promise<SmokeResult>;
}

interface Findings {
  held: string[];
  merged: string[];
  catastrophic: boolean;
  per_task: Array<{ task_id: string; fits_whole: boolean; reason: string }>;
  system_findings: Array<{ detail: string; involved: string[] }>;
}

function parseFindings(run: PipelineRun): Findings {
  const empty: Findings = { held: [], merged: [], catastrophic: false, per_task: [], system_findings: [] };
  if (!run.redux_findings) return empty;
  try {
    const j = JSON.parse(run.redux_findings) as Partial<Findings>;
    return {
      held: Array.isArray(j.held) ? j.held : [],
      merged: Array.isArray(j.merged) ? j.merged : [],
      catastrophic: j.catastrophic === true,
      per_task: Array.isArray(j.per_task) ? j.per_task : [],
      system_findings: Array.isArray(j.system_findings) ? j.system_findings : [],
    };
  } catch {
    return empty;
  }
}

function parseRemediation(run: PipelineRun): RemediationDirective[] {
  if (!run.remediation_plan) return [];
  try {
    const j = JSON.parse(run.remediation_plan) as RemediationDirective[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function isGreen(run: PipelineRun, smoke: SmokeResult): boolean {
  return smoke.passed && parseFindings(run).held.length === 0;
}

// ─── Pure cores (testable) ────────────────────────────────────────────────────

/**
 * Interpret a smoke run. The HERMETIC guard: a verifier must not touch the tree.
 * If `dirty` (git status --porcelain, run AFTER the supervisor) is non-empty, the
 * supervisor mutated the working tree — its "pass" is invalid (this is exactly
 * how a supervisor faked green: it Bash-wrote the missing module then validated
 * its own patch). Treat any tree change as a failure. Otherwise parse the JSON
 * verdict. (Build artifacts are gitignored, so they don't appear in porcelain —
 * only source-level changes do.)
 */
export function interpretSmoke(stdout: string, dirty: string): SmokeResult {
  const changed = dirty.trim();
  if (changed.length > 0) {
    return {
      passed: false,
      summary: 'smoke INVALID — the verifier modified the working tree; it must be read-only. Treated as failed.',
      failures: changed.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 12),
    };
  }
  const j = extractJson(stdout) as { passed?: unknown; summary?: unknown; failures?: unknown } | null;
  if (!j) return { passed: false, summary: 'smoke supervisor returned no usable verdict', failures: ['no JSON verdict'] };
  return {
    passed: j.passed === true,
    summary: typeof j.summary === 'string' ? j.summary : '',
    failures: Array.isArray(j.failures) ? j.failures.filter((x): x is string => typeof x === 'string') : [],
  };
}

/**
 * Classify a diagnostic's result against the held task's contract. `landed` =
 * the fix changed something; `strayed` = files it touched outside its
 * `creates`/`modifies` allow-list. A fix is only adopted (re-trialed) when it
 * landed AND didn't stray — this stops a non-compliant diagnostic from being
 * re-merged blindly (the "R1 made it worse" oscillation).
 */
function normalizeRepoPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

export function classifyDiagnosticFix(
  changed: string[],
  allowedFiles: string[],
): { landed: boolean; strayed: string[] } {
  const landed = changed.length > 0;
  const allowed = new Set(allowedFiles.filter(Boolean).map(normalizeRepoPath));
  const strayed = allowed.size > 0 ? changed.filter((f) => !allowed.has(normalizeRepoPath(f))) : [];
  return { landed, strayed };
}

// ─── Final smoke (testable core) ──────────────────────────────────────────────

/**
 * Shipping is now just the FINAL smoke on the fully-assembled integration branch.
 * Per-phase recovery (redux + R1/R2 diagnostics) happens inside the executing
 * phase loop (orchestrator), so by the time we get here every phase already
 * merged clean — a smoke failure here is a cross-phase integration issue, surfaced
 * to the human at the review gate (a `fix` corrective wave re-runs from phase 0).
 */
export async function runShipping(run: PipelineRun, deps: ShippingDeps = {}): Promise<ShipOutcome> {
  const smokeFn = deps.smoke ?? defaultSmoke;
  const smoke = await smokeFn(run);
  audit('pipeline.smoke.completed', 'pipeline.shipping', { runId: run.id, round: 'final', passed: smoke.passed });
  if (isGreen(run, smoke)) return { kind: 'green', smoke };
  return {
    kind: 'review',
    reason: 'unresolved',
    brief: buildReviewBrief(run, 'unresolved', smoke),
    headline: reviewRecommendation(run, 'unresolved', smoke),
  };
}

// ─── Review brief (pure) ──────────────────────────────────────────────────────

/**
 * One-line recommendation for the review gate. Shared by the brief + the Slack
 * ping. Says what the operator most likely wants to do and why, briefly.
 */
export function reviewRecommendation(run: PipelineRun, reason: ShipReason, smoke: SmokeResult | null): string {
  const f = parseFindings(run);
  if (reason === 'catastrophic') {
    return `CATASTROPHIC — composer flagged unrecoverable state; rollback or abort`;
  }
  const bits: string[] = [];
  if (f.held.length) bits.push(`${f.held.length} task(s) unintegrated (${f.held.join(', ')})`);
  if (smoke && !smoke.passed) bits.push('smoke failing');
  const why = bits.length ? bits.join(' · ') : 'issues survived auto-fix';
  return `NEEDS REVIEW — ${why}; fix (retry) or proceed (ship what merged)`;
}

/**
 * Review-gate brief: recommendation + decide commands on top, then terse details
 * (why · smoke failures · per-held-task remediation). No prompt echo.
 */
export function buildReviewBrief(run: PipelineRun, reason: ShipReason, smoke: SmokeResult | null): string {
  const f = parseFindings(run);
  const rem = parseRemediation(run);
  const L: string[] = [];
  L.push(`# Review gate — ${run.id}`);
  L.push('');
  L.push(`**${reviewRecommendation(run, reason, smoke)}**`);
  L.push('');
  L.push('```');
  L.push(`nyx pipeline accept ${run.id}        # merge held task(s) + CONTINUE the build`);
  L.push(`nyx pipeline proceed ${run.id}       # ship ONLY what merged + STOP (PR now)`);
  L.push(`nyx pipeline fix ${run.id} --note "..."   # corrective wave`);
  L.push(`nyx pipeline rollback ${run.id}      # replan from scratch`);
  L.push(`nyx pipeline abort ${run.id}`);
  L.push('```');
  L.push('');
  L.push(`Integrated: ${f.merged.length ? f.merged.join(', ') : '(none)'} · Held: ${f.held.length ? f.held.join(', ') : '(none)'}`);

  L.push('');
  L.push('<details><summary>Details</summary>');
  L.push('');
  if (smoke && !smoke.passed) {
    L.push(`**Smoke ❌** ${smoke.summary}`);
    for (const fl of smoke.failures) L.push(`- ${fl}`);
  }
  if (f.system_findings.length) {
    L.push('**System findings:**');
    for (const s of f.system_findings) L.push(`- [${s.involved.join(', ')}] ${s.detail}`);
  }
  if (rem.length) {
    L.push('**What each held task needs:**');
    for (const r of rem) L.push(`- ${r.task_id}: ${r.problem} → ${r.target_state}`);
  }
  L.push('</details>');
  return L.join('\n');
}

// ─── Real defaults (structured; injected away in tests) ───────────────────────

function gitRun(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
}
function gitTry(cmd: string, cwd: string): string | null {
  try {
    return gitRun(cmd, cwd);
  } catch {
    return null;
  }
}

function maxPlanEnv(runId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(runId ? pipelineRunEnv(runId) : process.env),
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  return env;
}

/**
 * Independent supervisor: a separate agent checks out the integration branch and
 * runs the project's own gate (it detects the command from the repo), reporting
 * pass/fail. Separate verification — never a coder's self-report.
 */
async function defaultSmoke(run: PipelineRun): Promise<SmokeResult> {
  const base = run.worktree_base;
  const integration = run.integration_branch;
  if (!base || !integration) return { passed: false, summary: 'no integration base to smoke', failures: ['missing base'] };
  // Pristine checkout of the integration branch: strip any pollution from a
  // prior round (or a cheating verifier) so smoke runs against EXACTLY what
  // would be PR'd. `clean -fd` removes untracked files but keeps gitignored
  // node_modules/build output, so deps are reused across rounds.
  gitTry(`git checkout -q "${integration}"`, base);
  gitTry(`git reset --hard -q "${integration}"`, base);
  gitTry(`git clean -fd -q`, base);
  // Install deps on the base BEFORE the verifier runs the gate. The pipeline
  // bypasses preflight and the verifier is read-only ("do NOT install missing
  // modules"), so without this the integration branch has no node_modules and a
  // greenfield Node gate fails on module-not-found. `git clean -fd` above keeps
  // gitignored node_modules, so the install persists across smoke rounds.
  const deps = installDeps(base);
  if (deps.ran.length > 0) {
    audit('pipeline.deps.installed', 'pipeline.shipping', {
      runId: run.id,
      ok: deps.ok,
      commands: deps.ran.map((r) => ({ cmd: r.cmd, ok: r.ok })),
    });
  }
  const prompt = [
    `# Pipeline smoke supervisor — ${run.id}`,
    '',
    'You are an INDEPENDENT verifier on the integration branch. Detect the project gate (package.json scripts test/build/typecheck, or pyproject + pytest/ruff) and RUN it. Report what actually ran and its real result.',
    '',
    'CRITICAL: you are VERIFYING, not fixing. Do NOT create, edit, move, or delete ANY file. Do NOT install missing modules by writing them. If the branch does not build/test AS-IS, that is a real failure — report `passed: false` and the errors. NEVER "fix" the tree to make the gate pass; any file you change invalidates the entire run.',
    '',
    'Write ONLY this JSON to stdout:',
    '```json',
    JSON.stringify({ passed: true, summary: 'what you ran + result', failures: ['concrete failures, empty if passed'] }, null, 2),
    '```',
  ].join('\n');
  const args = ['-p', prompt, '--model', SMOKE_MODEL, '--permission-mode', config.claudePermissionMode, '--allowed-tools', SMOKE_TOOLS.join(' '), '--add-dir', base];
  const r = await spawnWithTimeout('claude', args, { cwd: base, env: maxPlanEnv(run.id), captureStdout: true, label: `pipeline-smoke-${run.id}` }, SMOKE_TIMEOUT_MS);
  // Hermetic guard: any tree change means the verifier didn't just verify.
  const dirty = gitTry(`git status --porcelain`, base) ?? '';
  const result = interpretSmoke(r.stdout, dirty);
  if (dirty.trim().length > 0) {
    audit('pipeline.smoke.invalidated', 'pipeline.shipping', { runId: run.id, changed: dirty.trim().split('\n').slice(0, 12) });
    gitTry(`git reset --hard -q "${integration}"`, base); // undo the verifier's meddling
    gitTry(`git clean -fd -q`, base);
  }
  return result;
}

/**
 * Diagnostic round (used by the executing per-phase recovery loop): for each
 * currently-held task, re-implement it from a CLEAN integration baseline (not the
 * polluted held branch — so a scope violation can actually be dropped) on a fresh
 * per-round fix branch, driven by the remediation directive + the contract scope.
 * Then VERIFY the fix landed in-scope (#4): only a fix that changed something AND
 * stayed within its `creates`/`modifies` is ADOPTED as the task's branch (so the
 * next redux re-trials the clean fix). A no-op or out-of-scope fix is rejected and
 * the task stays held. Does NOT run redux or bump the round counter — the caller
 * (orchestrator phase loop) owns those.
 */
export async function runDiagnosticRound(run: PipelineRun, round: number): Promise<void> {
  const base = run.worktree_base;
  const integration = run.integration_branch;
  if (!base || !integration) return;
  const held = parseFindings(run).held;
  const rem = parseRemediation(run);
  const plan = parsePlanJson(run.plan_json);
  const planByTask = new Map((plan?.plans ?? []).map((p) => [p.task_id, p]));
  const coders = run.coder_results
    ? (JSON.parse(run.coder_results) as Array<{ task_id: string; branch: string; status: string; commit: string | null; files_changed: string[] }>)
    : [];

  let adopted = false;
  for (const taskId of held) {
    const coder = coders.find((c) => c.task_id === taskId);
    if (!coder) continue;
    const contract = planByTask.get(taskId);
    const directive = rem.find((r) => r.task_id === taskId);
    const fixBranch = `nyx-pipeline/${sanitize(run.id)}/fix-r${round}-${sanitize(taskId)}`;
    const wt = `${config.cloneRootPrefix}${run.id}-r${round}-${sanitize(taskId)}`;
    if (existsSync(wt)) gitTry(`git worktree remove --force "${wt}"`, base);
    gitTry(`git branch -D "${fixBranch}"`, base);
    // Branch off the CLEAN integration tip — the held branch's stray edits are
    // left behind, so an in-scope re-implementation is possible.
    if (!gitTry(`git worktree add -b "${fixBranch}" "${wt}" "${integration}"`, base)) continue;
    const prompt = [
      `# Pipeline diagnostic R${round} — ${taskId}`,
      '',
      'Composer redux held this task back. Re-implement it cleanly toward the target state below, STRICTLY within scope. You are starting from the integration branch; the prior attempt is discarded. Create/modify ONLY the files this task owns — touch nothing else.',
      contract ? `\n## Your scope (allowed files)\ncreate: ${contract.creates.map((c) => c.file).filter(Boolean).join(', ') || '(none)'}\nmodify: ${contract.modifies.join(', ') || '(none)'}` : '',
      directive ? `\n## What was broken\n${directive.problem}\n\n## Target state\n${directive.target_state}` : '',
      '\nCommit when done.',
    ].join('\n');
    const args = ['-p', prompt, '--model', DIAGNOSTIC_MODEL, '--permission-mode', config.claudePermissionMode, '--allowed-tools', DIAGNOSTIC_TOOLS.join(' '), '--add-dir', wt];
    await spawnWithTimeout('claude', args, { cwd: wt, env: maxPlanEnv(run.id), captureStdout: false, label: `pipeline-diag-${round}-${taskId}` }, DIAGNOSTIC_TIMEOUT_MS);
    gitTry(`git add -A`, wt);
    if ((gitTry(`git status --porcelain`, wt) ?? '').length > 0) {
      gitTry(`git -c user.name="${config.gitAuthorName.replace(/"/g, '\\"')}" -c user.email="${config.gitAuthorEmail.replace(/"/g, '\\"')}" commit -m "pipeline diag R${round}: ${taskId}"`, wt);
    }
    // #4 verify: did the fix land, and stay in scope?
    const changed = (gitTry(`git diff --name-only "${integration}".."${fixBranch}"`, base) ?? '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const allowed = contract ? [...contract.creates.map((c) => c.file), ...contract.modifies] : [];
    const { landed, strayed } = classifyDiagnosticFix(changed, allowed);
    if (landed && strayed.length === 0) {
      // adopt — redux re-trials the clean fix. Refresh the WHOLE record, not just
      // the branch: stale `status`/`commit` from the discarded attempt make
      // harvestFacts emit empty facts (redux.ts:145) and force a 'failed' P1
      // verdict (redux.ts:417), so the repaired branch would be held forever.
      coder.branch = fixBranch;
      coder.status = 'committed';
      coder.commit = (gitTry(`git rev-parse "${fixBranch}"`, base) ?? '').trim() || null;
      coder.files_changed = changed;
      adopted = true;
      audit('pipeline.diagnostic.fix.verified', 'pipeline.shipping', { runId: run.id, round, taskId, files: changed.length });
    } else {
      audit('pipeline.diagnostic.fix.rejected', 'pipeline.shipping', {
        runId: run.id,
        round,
        taskId,
        reason: !landed ? 'no_change' : 'out_of_scope',
        ...(strayed.length ? { strayed: strayed.slice(0, 8) } : {}),
      });
    }
    gitTry(`git worktree remove --force "${wt}"`, base);
  }

  // Persist adopted fix branches. The caller re-runs redux + bumps the counter.
  if (adopted) updateRun(run.id, { coder_results: JSON.stringify(coders) }, Date.now());
}
