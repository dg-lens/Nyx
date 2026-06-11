import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  AMBIGUITY_FILE,
  buildAmbiguityHaltReport,
  parseAmbiguityFile,
} from '../ambiguity-escalation.js';
import {
  audit,
  auditPassCountForTask,
  failureCountForTask,
  isTaskHalted,
  lastEventAt,
  lastEventPayload,
  lastSuccessfulTaskAt,
  tasksFiredInWindow,
  verifyChainPeriodic,
} from '../audit.js';
import { runEvalLoop } from '../eval/online-eval-runner.js';
import { runAudit, MAX_AUDIT_PASSES, routeAuditOutcome, type AttemptStage } from '../audit-runner.js';
import type { FlightPlan } from '../composer/types.js';
import {
  maybeRunShadowNormalize,
  type ShadowNormalizeResult,
} from '../composer/orchestrate.js';
import {
  advancePipeline,
  createPipelineRun,
  failPipelineRun,
  getRunByTaskId,
} from '../pipeline/orchestrator.js';
import { claimRunForResume, runsAwaitingDecision } from '../pipeline/db.js';
import { isAwaiting, isTerminal, type DecisionKind, type PipelineStatus } from '../pipeline/types.js';
import { buildPrevalidateFailureLog, prevalidateExpects } from '../expects-prevalidate.js';
import { config, validateConfig } from '../config.js';
import { liveOwnClaudeCount } from '../claude-registry.js';
import { liveGitTaskExists, removeGitLock, writeGitLock } from '../git-task-lock.js';
import { runTwoClassTick } from '../tick-scheduler.js';
import { emitHook, initPlugins } from '../plugins/index.js';
import { drainPendingActions, insertUnderActiveTasks } from '../control/actions.js';
import { listPending, markApplied, markFailed } from '../control/db.js';
import { invokeDecomposer, type DecomposeIntent } from '../decomposer.js';
import {
  invokeTemplateComposer,
  templatesStorePath,
  writeTemplateIntoStore,
  type ComposeTemplateIntent,
} from '../template-composer.js';
import { submitDecision } from '../pipeline/decide.js';
import { isValidRepoTag, targetMode } from '../pipeline/target.js';
import { maybeRenderLedgerAtTickEnd } from '../ledger.js';
import { acquire } from '../lockfile.js';
import { maybeFlushDigest } from '../notification-digest-flush.js';
import * as notify from '../notifier.js';
import {
  markTaskCompleted,
  pickNextTask,
  readQueue,
  slotOf,
  slotToTime,
  slotWindow,
  tasksWithInvalidTags,
} from '../task-reader.js';
import { runPreflight } from '../preflight.js';
import { STALLED_EXIT_CODE } from '../spawn-helpers.js';
import { redactCredentialPatterns } from '../redaction.js';
import { listMcpServers } from '../mcp-discovery.js';
import { authFailedServers, recordSpawnOutcome } from '../mcp-resilience.js';
import { healAuth, recordAuthFailure } from '../mcp-auth-healer.js';
import { buildPrompt, invokeClaude, invokeContentJudge, invokeWisdomCapture } from '../task-runner.js';
import { WISDOM_FILE, parseWisdomFile, routeWisdomCapture } from '../wisdom-capture.js';
import { countTestsPassed, runGate } from '../test-gate.js';
import { changedFilesWorkingTree } from '../deploy-detector.js';
import { assessGateTrust } from '../gate-trust.js';
import { runLintGate } from '../lint-gate.js';
import { assessRottenGreen } from '../rotten-green.js';
import {
  JUDGE_FILE,
  isJudgeConcern,
  parseJudgeFile,
  summarizeJudgement,
} from '../content-judge.js';
import {
  finalizeAnalysis,
  finalizeAssistant,
  finalizeCodeExternal,
  finalizeCodeLocal,
  finalizeContent,
} from './finalize.js';
import { tickGapMinutes } from '../heartbeat.js';
import * as git from '../git-ops.js';
import { ingestInbox } from '../secrets/inbox-ingest.js';
import { handleSpawnProject, isSpawnProjectTask } from '../secrets/spawn-project.js';
import { schedulingOf, type ParsedTask, type RunOutcome } from '../types.js';

const COOLDOWN_MIN = 60 * 60_000;
const STALE_THRESHOLD_HOURS = 24;

/**
 * Scrub secret values out of a spawned-claude failure log before it reaches the
 * hash-chained audit DB or Slack. The spawned `claude -p` runs with the
 * configured GitHub/Anthropic/Slack tokens (and `BWS_ACCESS_TOKEN`, if present)
 * in its environment; any tool it invokes that prints those values to
 * stderr/stdout would otherwise be persisted and broadcast verbatim. Redacting
 * by known value is robust regardless of how the secret surfaced.
 *
 * `git.redactSecrets` already covers the GitHub token + the
 * `x-access-token:…@` URL credential form; we chain it and then strip the
 * remaining cross-cutting config secrets that the child inherits via the
 * `process.env` spread in task-runner's spawn env.
 *
 * Per-task Bitwarden secret VALUES (injected via `extraEnv`, never in this
 * process's env) are scrubbed at their one known site — `invokeClaude` /
 * `invokeWisdomCapture` in task-runner — before the ClaudeResult leaves that
 * module, so `claudeResult.stdout/stderr` arrive here already value-redacted.
 * The `redactCredentialPatterns` backstop below is the final shape-based net for
 * any credential token that no exact-value pass knew about.
 */
function redactClaudeOutput(s: string): string {
  let out = git.redactSecrets(s);
  const denylist = [
    config.anthropicApiKey,
    config.slackBotToken,
    process.env['BWS_ACCESS_TOKEN'] ?? '',
  ];
  for (const secret of denylist) {
    if (secret) out = out.split(secret).join('***');
  }
  return redactCredentialPatterns(out);
}

/**
 * Detect a live `claude` CLI process that isn't us.
 *
 * Strict: only counts processes whose argv[0] basename is exactly "claude",
 * OR `node`/`tsx` invocations whose argv[1] basename is "claude" (or ends in
 * `claude.js`). GUI/dispatcher exclusion is decided from the EXECUTABLE path
 * tokens (argv[0]/argv[1]) only — never the full command line, which carries
 * user-controlled prompt/`--add-dir` args that could otherwise spoof the guard.
 */
function hasLiveClaude(): boolean {
  try {
    const out = execSync('ps -axww -o pid=,command=', { encoding: 'utf8' });
    const me = process.pid;
    for (const raw of out.split('\n')) {
      const m = raw.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1] ?? '0', 10);
      if (pid === me) continue;
      const cmd = (m[2] ?? '').trim();
      if (!cmd) continue;

      const tokens = cmd.split(/\s+/);
      // Exclude the Nyx dispatcher's own processes AND the operator's
      // interactive Claude Code session(s) by inspecting the EXECUTABLE-path
      // region only — the tokens BEFORE the first flag (a token starting with
      // `-`). The spawned task's user-controlled args (`-p <prompt>`,
      // `--add-dir <path>`) all come AFTER the first flag, so a prompt or
      // working-dir path that happens to contain "claude.app" or "claude-code/"
      // can no longer be misclassified as the operator's GUI session and skipped
      // (which would defeat the concurrency guard). The executable region still
      // spans multiple whitespace tokens so a GUI path with spaces
      // (/Users/<u>/Library/Application Support/Claude/claude-code/.../claude.app/...)
      // is matched in full.
      //
      // Case-insensitive on the GUI markers because the new claude-code path on
      // macOS is /Users/<u>/Library/Application Support/Claude/claude-code/<ver>/claude.app/...
      // (lowercase claude.app), while the older /Applications/Claude.app/... GUI
      // had a capital C. Both must be excluded; only the spawned `claude` CLI for
      // an in-flight Nyx task should trigger live detection.
      const firstFlagIdx = tokens.findIndex((t) => t.startsWith('-'));
      const exeRegion = (firstFlagIdx === -1 ? tokens : tokens.slice(0, firstFlagIdx)).join(' ');
      const exeRegionLower = exeRegion.toLowerCase();
      if (
        exeRegion.includes('nyx-dispatch.sh') ||
        exeRegion.includes('run-once') ||
        exeRegionLower.includes('claude.app') ||
        exeRegionLower.includes('claude-code/')
      ) {
        continue;
      }

      const exe = tokens[0] ?? '';
      const wrapped = tokens[1] ?? '';
      const t0 = basename(exe);
      if (t0 === 'claude') return true;
      if ((t0 === 'node' || t0 === 'tsx') && wrapped) {
        const t1 = basename(wrapped);
        if (t1 === 'claude' || t1.endsWith('claude.js')) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Snapshot the set of untracked paths in a working dir (relative to its git
 * root). Used to bracket the wisdom-capture spawn: anything that becomes
 * untracked DURING the spawn — and isn't in this pre-snapshot — was created by
 * the wisdom agent and must be swept before `commitAll` (`git add -A`) stages
 * it into the task's commit/PR. The main task's own output (and the operator's
 * pre-existing untracked files in a self-task worktree) all exist BEFORE the
 * spawn, so they're in the snapshot and never removed. Best-effort: a git error
 * returns an empty set, and the caller falls back to removing only WISDOM_FILE.
 */
function untrackedSnapshot(workingDir: string): Set<string> {
  try {
    const out = execSync('git status --porcelain --untracked-files=all', {
      cwd: workingDir,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      if (line.startsWith('?? ')) set.add(line.slice(3).trim());
    }
    return set;
  } catch {
    return new Set<string>();
  }
}

async function dispatchOne(task: ParsedTask): Promise<RunOutcome> {
  // Built-in dispatcher routes that skip Claude entirely. Security-critical
  // org-admin operations (Bitwarden project spawn) run in-process to avoid
  // exposing admin credentials to a subprocess.
  if (isSpawnProjectTask(task)) {
    return handleSpawnProject(task);
  }

  const startedAt = Date.now();
  const sched = schedulingOf(task);
  audit('task.started', 'dispatcher', { taskId: task.id, type: task.type, model: task.model, scheduling: sched });

  // Observation-only: code tasks with no [reading:] are logged for operator review.
  // Not a halt — just an audit trail to surface tasks that might benefit from primed context.
  if (task.type === 'code' && (!task.reading || task.reading.length === 0)) {
    audit('task.reading_tag.absent', 'dispatcher', { taskId: task.id });
  }
  const gateSummary = task.gates === 'none' ? 'none' : task.gates.join('+');
  await notify.taskDispatched(task.id, task.type, task.model, gateSummary);

  // ── Setup stage ──
  // First attempt: fresh clone/worktree. Subsequent attempts (audit-driven retry)
  // reuse the preserved working dir so heuristic/diagnostic fixes survive.
  const priorAuditPasses = auditPassCountForTask(task.id);
  const isRetry = priorAuditPasses > 0;
  let workingDir: git.WorkingDir;
  try {
    workingDir = createWorkingDir(task, { reuseExisting: isRetry });
  } catch (err) {
    const e = err as Error;
    const failureLog = `working dir setup failed: ${e.message}`;
    audit('task.failed', 'dispatcher', { taskId: task.id, failure_log: failureLog });
    await notify.taskFailed(task.id, 'setup', failureLog);
    cleanupStaleWorkingDir(task.id);
    return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
  }

  // ── [expects:] prevalidate (v0.9) ──
  // Catch malformed [expects:] paths at dispatch time, BEFORE any compute is
  // spent on planning/composer/claude/gate. Closes the recurring [T4
  // apps-web-decomposer-guess] failure mode where dispatch-mode Claude writes
  // expects paths from convention without inspecting the actual repo. Halts
  // fast with a structured operator report identifying which paths are wrong
  // and (where pattern-matched) suggesting the correct shape.
  //
  // Only validates on first attempt (not audit retries) — by then the expects
  // paths have already been validated once on the first attempt.
  if (!isRetry) {
    const prevalidate = prevalidateExpects(task, workingDir.path);
    if (!prevalidate.passed) {
      const failureLog = buildPrevalidateFailureLog(prevalidate);
      audit('task.expects.prevalidate.failed', 'dispatcher', {
        taskId: task.id,
        missing_parents: prevalidate.missingParents,
      });
      audit('task.halted_for_review', 'dispatcher', {
        taskId: task.id,
        pattern: 'expects-prevalidate',
        operator_report: failureLog,
        working_dir: workingDir.path,
      });
      await notify.taskHalted(task.id, 'expects-prevalidate', failureLog);
      return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog };
    }
  }

  // ── Attempt + audit loop ──
  // Each iteration: invoke Claude → run gate → finalize. On any stage failure,
  // run the audit phase. If audit auto-fixes, loop. If audit halts or audit cap
  // is reached, emit task.halted_for_review and return.
  //
  // (The stage-0 composer layer — a plan-only + composer-check spawn before
  // execution — was a proof-of-concept and has been removed for non-pipeline
  // tasks; code tasks now run a single execution spawn. The composer module is
  // retained for the pipeline's composer-redux stage.)
  for (let attempt = priorAuditPasses; attempt <= MAX_AUDIT_PASSES; attempt++) {
    const result = await attemptTask(task, workingDir, startedAt, { flightPlan: null });
    if (result.status === 'completed' || result.status === 'failed-final') {
      return result.outcome;
    }
    if (result.status === 'rate-limited') {
      // Capacity, not a defect: bubble up so the tick leaves the task queued and
      // opens the cooldown. Do NOT enter the audit pipeline.
      return {
        taskId: task.id,
        status: 'rate-limited',
        durationMs: Date.now() - startedAt,
        ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
      };
    }
    if (result.status === 'ambiguity-escalated') {
      audit('task.ambiguity.escalated', 'dispatcher', { taskId: task.id, ambiguity_file: AMBIGUITY_FILE });
      void notify.taskAmbiguityEscalated(task.id, result.report);
      return haltTask(task, workingDir, startedAt, {
        operatorReport: result.report,
        pattern: 'aesthetic-ambiguity',
      });
    }
    if (result.status === 'normalizer-rejected') {
      // PRE-DISPATCH REJECT (COMPOSER_NORMALIZER_ENFORCED=true): the normalizer
      // judged the spec un-normalizable as written, so attemptTask did NOT spawn
      // the coder. Emit the dedicated event + action-required notice, then halt
      // the chain. The operator tightens the spec and `nyx resume`s. This is
      // PRE-DISPATCH ONLY — never a post-execution / findings gate.
      audit('composer.normalize.rejected', 'dispatcher', {
        taskId: task.id,
        blocking_issues: result.blockingIssues,
        reject_reason: result.rejectReason,
      });
      void notify.deliver(
        'action-required',
        `🛑 *${task.id}* — composer normalizer REJECTED the spec pre-dispatch (the coder was not spawned).\n\n${result.report}`,
      );
      return haltTask(task, workingDir, startedAt, {
        operatorReport: result.report,
        pattern: 'normalizer-reject',
      });
    }
    // result.status === 'failed-recoverable' — try to audit + auto-fix.
    if (attempt >= MAX_AUDIT_PASSES) {
      return haltTask(task, workingDir, startedAt, {
        operatorReport: `Audit cap reached without recovery (${MAX_AUDIT_PASSES} passes). Last failure log:\n\n${result.failureLog.slice(0, 1500)}`,
        pattern: 'audit-cap',
      });
    }
    const auditOutcome = await runAudit({
      task,
      workingDir: workingDir.path,
      failureLog: result.failureLog,
      originalPrompt: buildPrompt(task),
      priorAuditPasses: attempt,
      stage: result.stage,
    });
    if (auditOutcome.kind === 'autofix_applied') {
      audit('task.audit.autofix.succeeded', 'dispatcher', {
        taskId: task.id,
        pattern: auditOutcome.pattern,
      });
      // Loop back — re-run Claude + gate + finalize against the fixed working dir.
      continue;
    }
    // All remaining outcomes (`delivered`, `escalated_to_halt`, `audit_failed`)
    // route through the pure decision function so the complete/re-run/halt logic
    // is exhaustively testable without a live spawn or gate. The stage of the
    // audited failure is load-bearing: a `delivered` verdict only auto-completes
    // when the failure was at finalize (gate already green) AND the verdict cited
    // artifact evidence. Earlier-stage or evidence-free `delivered` is demoted.
    const route = routeAuditOutcome(result.stage, auditOutcome);
    if (route.decision === 'rerun') {
      // Reached only when auditOutcome.kind === 'delivered' and the stage was not
      // finalize (the autofix re-run path above already `continue`d). The gate
      // never validated this tree, so we re-run Claude + gate exactly as the
      // autofix path would — if it truly is delivered the re-run is cheap and the
      // gate revalidates. Record the demotion for the anti-gaming rollup.
      audit('task.audit.delivered.demoted', 'dispatcher', {
        taskId: task.id,
        pattern: auditOutcome.kind === 'delivered' ? auditOutcome.pattern : undefined,
        stage: result.stage,
        delivered_demoted: route.demoted ?? 'wrong_stage',
      });
      continue;
    }
    if (route.decision === 'complete') {
      // delivered + finalize + artifact evidence. The audit pass found (or made)
      // the deliverable already complete — e.g. the original gh-create failure
      // was transient and the diagnostic agent opened the PR itself. Re-running
      // Claude + finalize would attempt a second ship and hit the same failure,
      // the loop this branch exists to stop. Emit the completion events the
      // success finalize path normally emits (so downstream consumers — Slack,
      // ledger, desktop — see the same shape), clean up, and return completed.
      const delivered = auditOutcome as Extract<typeof auditOutcome, { kind: 'delivered' }>;
      audit('task.audit.delivered.succeeded', 'dispatcher', {
        taskId: task.id,
        pattern: delivered.pattern,
        ...(delivered.prUrl ? { pr_url: delivered.prUrl } : {}),
        ...(delivered.commitSha ? { commit_sha: delivered.commitSha } : {}),
      });
      if (delivered.prUrl) {
        audit('task.pr.created', 'dispatcher', {
          taskId: task.id,
          prUrl: delivered.prUrl,
          source: 'audit-delivered',
        });
        await notify.prCreated(task.id, delivered.prUrl);
      }
      workingDir.cleanup();
      return {
        taskId: task.id,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        ...(delivered.prUrl ? { prUrl: delivered.prUrl } : {}),
      };
    }
    // route.decision === 'halt'.
    if (route.demoted === 'no_evidence') {
      // delivered + finalize but NO PR URL and NO commit SHA — the ship is
      // unverifiable. Do NOT auto-complete on the agent's bare word; hand it to
      // the operator with the note, recording delivered_demoted in the payload.
      const delivered = auditOutcome as Extract<typeof auditOutcome, { kind: 'delivered' }>;
      audit('task.audit.delivered.demoted', 'dispatcher', {
        taskId: task.id,
        pattern: delivered.pattern,
        stage: result.stage,
        delivered_demoted: 'no_evidence',
      });
      return haltTask(task, workingDir, startedAt, {
        operatorReport:
          `Audit pass returned VERDICT: delivered with no artifact evidence ` +
          `(no PR URL, no commit SHA). The deliverable cannot be verified, so the ` +
          `task was NOT auto-completed. Inspect the working dir and the agent note, ` +
          `then nyx-resume if the work is genuinely shipped.\n\nAgent note: ${delivered.note}`,
        pattern: 'delivered-no-evidence',
        extraPayload: { delivered_demoted: 'no_evidence' },
      });
    }
    // 'escalated_to_halt' or 'audit_failed' — both halt the chain.
    const report =
      auditOutcome.kind === 'escalated_to_halt'
        ? auditOutcome.operatorReport
        : auditOutcome.kind === 'audit_failed'
          ? `Audit phase errored: ${auditOutcome.reason}`
          : 'Audit halted.';
    return haltTask(task, workingDir, startedAt, {
      operatorReport: report,
      pattern: auditOutcome.kind === 'escalated_to_halt' ? auditOutcome.pattern : 'audit-failed',
    });
  }

  // Unreachable in practice — the loop always returns. Safety net.
  return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog: 'attempt loop exited unexpectedly' };
}

/** Create the working dir appropriate for this task type. Pure helper. */
function createWorkingDir(task: ParsedTask, opts: { reuseExisting?: boolean }): git.WorkingDir {
  // Defense in depth behind the task-reader/queue_task validators: app:<slug>
  // is a pipeline-only target, and pipeline tasks never reach this helper (they
  // are redirected into the orchestrator). If one slips through anyway, fail
  // loudly here rather than letting the truthy `task.repo` branch below route
  // it into `git clone https://github.com/app:foo.git` — a guaranteed 404.
  if (targetMode(task.repo) === 'app') {
    throw new Error(
      `[repo: ${task.repo}] is a pipeline-only app:<slug> target — it is not cloneable. ` +
        `Use [type: pipeline] to scaffold an app.`,
    );
  }
  // v0.8.x: pull baseBranch from gitTargets when it's set for this repo, so
  // clones come from the same branch the task will eventually push to. Tasks
  // that target a non-default branch (e.g. a custom integration branch) need their
  // clones rooted at the target branch's HEAD, otherwise pre-staged commits
  // on that branch are invisible to the spawned Claude.
  const target = task.repo ? config.gitTargets[task.repo] : undefined;
  const cloneOpts = { ...opts, ...(target ? { baseBranch: target.baseBranch } : {}) };
  if (task.type === 'code' && task.repo) return git.createCloneWithBranch(task.id, task.repo, cloneOpts);
  if (task.type === 'code') return git.createLocalWorktree(task.id);
  if (task.type === 'analysis' && task.repo) return git.cloneExternalRepo(task.id, task.repo, 1, cloneOpts);
  if (task.type === 'analysis') return git.createLocalWorktree(task.id);
  return git.createOutputDir(task.id, task.output);
}

/** Wipe any partial clone/worktree dirs for a task whose setup failed. */
function cleanupStaleWorkingDir(taskId: string): void {
  for (const stale of [
    resolve(config.worktreesDir, taskId),
    `${config.cloneRootPrefix}${taskId}`,
  ]) {
    if (existsSync(stale)) {
      try { rmSync(stale, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  }
}

type AttemptResult =
  | { status: 'completed'; outcome: RunOutcome }
  | { status: 'failed-final'; outcome: RunOutcome }
  | { status: 'failed-recoverable'; failureLog: string; stage: AttemptStage }
  | { status: 'ambiguity-escalated'; report: string }
  | {
      status: 'normalizer-rejected';
      report: string;
      blockingIssues: string[];
      rejectReason: string | null;
    }
  | { status: 'rate-limited'; retryAfterMs?: number };

/**
 * Operator-facing report body for a pre-dispatch normalizer reject. PRE-DISPATCH
 * ONLY — this is produced BEFORE any coder spawns; it describes a spec the
 * composer could not normalize, never a post-execution finding.
 */
function buildNormalizerRejectReport(
  task: ParsedTask,
  decision: Extract<ShadowNormalizeResult, { action: 'reject' }>,
): string {
  const lines: string[] = [];
  lines.push(
    `The composer normalizer REJECTED this spec pre-dispatch — the coder was NOT spawned.`,
  );
  if (decision.rejectReason) {
    lines.push('');
    lines.push(`Reason: ${decision.rejectReason}`);
  }
  if (decision.blockingIssues.length > 0) {
    lines.push('');
    lines.push('Blocking issues:');
    for (const issue of decision.blockingIssues) lines.push(`  - ${issue}`);
  }
  lines.push('');
  lines.push(
    `Tighten the task spec to resolve the issues above, then \`nyx resume ${task.id}\`.`,
  );
  return lines.join('\n');
}

/**
 * One attempt at the work: invoke Claude, run gate, finalize. Emits the usual
 * task.claude.exited / task.gate.completed / task.failed events along the way.
 * Returns:
 *   - 'completed'           — finalize succeeded; outcome is the success outcome.
 *   - 'failed-final'        — a failure mode where audit can't help (e.g. setup
 *                             impossible mid-attempt). Outcome is the failure.
 *   - 'failed-recoverable'  — a failure where the working dir is intact and an
 *                             audit pass might fix it. Caller decides.
 */
async function attemptTask(
  task: ParsedTask,
  workingDir: git.WorkingDir,
  startedAt: number,
  opts: { flightPlan?: FlightPlan | null } = {},
): Promise<AttemptResult> {
  // ── Pre-flight ──
  // Fail at dispatch instead of mid-Claude if install or env vars are broken.
  // Result is treated as a recoverable failure so audit can fix it (e.g. heuristic
  // autofix for pnpm config drift, operator-required for missing BW secrets).
  const preflight = runPreflight(task, workingDir.path);
  if (!preflight.passed) {
    const failureLog = preflight.failureLog ?? 'preflight failed (no detail)';
    audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'preflight', failure_log: failureLog });
    await notify.taskFailed(task.id, 'preflight', failureLog);
    return { status: 'failed-recoverable', failureLog, stage: 'preflight' };
  }

  // ── Pre-spawn MCP auth-heal (G-D) ──
  // For MCP-dependent task types, proactively check each credential's TTL BEFORE
  // the spawn. A token past its refresh window surfaces as a generic tool error
  // mid-spawn → agent drift → exit 124. Proactive flagging (the 80%-TTL point)
  // emits task.mcp.auth_stale so the operator can re-auth before the next tick.
  // Observation-only / non-fatal: we never block the spawn here — a stale token
  // may still work, and the reactive 401 classifier below catches a dead one.
  if (task.type === 'assistant' || task.type === 'analysis') {
    try {
      healAuth(listMcpServers(), { taskId: task.id });
    } catch {
      /* auth-heal is best-effort; never block a spawn on it */
    }
  }

  // ── Pre-dispatch composer normalizer (OFF by default) ──
  // Additive and fully gated. When config.composer.normalizer.enabled is false
  // (the shipped default) this is a no-op and the dispatch path below is
  // behaviorally identical to a build without it.
  //
  // When ENABLED but NOT enforced (COMPOSER_NORMALIZER_ENFORCED=false) it runs
  // one extra sonnet planning spawn that computes + persists + audit-logs a
  // SHADOW normalization of the spec — it does NOT alter the prompt the executor
  // sees, the gate decision, or the task outcome.
  //
  // When ENFORCED (COMPOSER_NORMALIZER_ENFORCED=true) the decision is applied
  // PRE-DISPATCH ONLY — tighten or reject BEFORE the coder spawns; it is NEVER a
  // post-execution findings gate:
  //   - clean verdict  → inject the compiled "## NORMALIZED SPEC" block into the
  //                       coder's prompt (additive plumbing via buildPrompt).
  //   - would_reject    → do NOT spawn the coder; halt the task pre-dispatch.
  //   - normalizer null → proceed unchanged (never block on its OWN failure).
  //
  // maybeRunShadowNormalize is double-guarded internally and fails open; the
  // extra try/catch here makes it STRUCTURALLY impossible for a throw to touch
  // dispatch even if that contract ever regresses.
  let normalizedSpecBlock: string | undefined;
  if (task.type === 'code' && config.composer.normalizer.enabled) {
    let decision: ShadowNormalizeResult = { action: 'proceed' };
    try {
      decision = await maybeRunShadowNormalize(task, workingDir.path);
    } catch {
      /* normalizer wiring fault is fail-open; never affects dispatch */
    }
    if (decision.action === 'reject') {
      // PRE-DISPATCH REJECT: the spec is un-normalizable as written. The coder is
      // NOT spawned. Surface a structured result; dispatchOne emits
      // composer.normalize.rejected + notifies + halts via haltTask.
      const report = buildNormalizerRejectReport(task, decision);
      return {
        status: 'normalizer-rejected',
        report,
        blockingIssues: decision.blockingIssues,
        rejectReason: decision.rejectReason,
      };
    }
    if (decision.action === 'inject') {
      normalizedSpecBlock = decision.normalizedSpecBlock;
    }
  }

  const claudeResult = await invokeClaude(task, workingDir.path, {
    ...(opts.flightPlan ? { flightPlan: opts.flightPlan } : {}),
    ...(normalizedSpecBlock ? { normalizedSpecBlock } : {}),
  });
  audit('task.claude.exited', 'dispatcher', {
    taskId: task.id,
    exitCode: claudeResult.exitCode,
    durationMs: claudeResult.durationMs,
  });

  // ── Post-spawn MCP breaker bookkeeping (G-D) ──
  // For MCP-dependent task types, attribute each MCP tool call in the spawn's
  // stream-json output to its server and update the cross-process breaker per
  // server: a failed call (auth 401/403 vs transport 5xx/timeout) increments toward
  // opening the breaker, a successful call closes a half-open one. This is what
  // makes the breaker survive the cold-per-spawn model — the state lives in nyx.db,
  // not the dead child — and what makes it actually accumulate (the single-result
  // envelope dropped the tool tokens, so the prior text-regex path saw nothing).
  // The breaker_opened/closed rows are the post-mortem join the MCP-heavy hang T4
  // entries lacked. Best-effort: any throw here never affects the task outcome.
  //
  // CRUCIALLY: the returned auth-kind is USED, not discarded. An auth-classed
  // failure marks the failing servers' credentials expired (mcp_credentials) so the
  // NEXT tick's pre-spawn healAuth flags them and routes to the operator-action
  // path — the generic Opus diagnostic can't drive a browser re-auth, so without
  // this an auth failure just burns audit passes. We re-derive the per-server auth
  // set from the same stream-json tool events recordSpawnOutcome used, so only the
  // server that actually 401'd is marked, not every server the spawn touched.
  if (task.type === 'assistant' || task.type === 'analysis') {
    try {
      const combined = `${claudeResult.stderr}\n${claudeResult.stdout}`;
      const events = claudeResult.mcpToolEvents ?? [];
      const kind = recordSpawnOutcome(combined, { exitCode: claudeResult.exitCode, events });
      if (kind === 'auth') {
        const authServers = authFailedServers(events, combined);
        for (const server of authServers) recordAuthFailure(server);
        audit('task.mcp.auth_failure', 'dispatcher', { taskId: task.id, servers: authServers });
        void notify.dm(
          `🔑 *${task.id}* — an MCP server returned an auth error (${authServers.join(', ') || 'unattributed'}). ` +
            `Re-auth the connector; the breaker has suppressed it for this cooldown.`,
        );
      }
    } catch {
      /* breaker bookkeeping is best-effort; never affect task flow */
    }
  }

  // Per-spawn cost/token metering (G-B/P1). Locally-estimated dollars survive the
  // Max-plan OAuth seat (no billing signal). Recorded as its own audit event so it
  // never perturbs the existing exit/gate flow; absent when metering is off or the
  // JSON envelope was unparseable.
  if (claudeResult.usage) {
    const u = claudeResult.usage;
    audit('task.usage.metered', 'dispatcher', {
      taskId: task.id,
      estimated_cost_usd: u.estimatedCostUsd,
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_read_input_tokens: u.cacheReadInputTokens,
      cache_creation_input_tokens: u.cacheCreationInputTokens,
      total_tokens: u.totalTokens,
      num_turns: u.numTurns,
    });
  }

  // Rate-limit/overload: NOT a code defect. Surface it as a distinct result so
  // the tick leaves the task queued ([ ], no [FAILED]) and opens a global
  // cooldown — re-running it through the audit pipeline would burn compute on a
  // capacity problem the audit agent can't fix. `rateLimited` is set by
  // spawnWithTimeout ONLY on a non-zero exit carrying a machine signature
  // (rate_limit_error / overloaded_error / a 429 with context) — a clean exit-0
  // run never trips it, so a task that legitimately implements/tests rate
  // limiting completes normally instead of livelocking.
  if (claudeResult.rateLimited) {
    audit('task.skipped.rate_limited', 'dispatcher', {
      taskId: task.id,
      ...(claudeResult.retryAfterMs != null ? { retryAfterMs: claudeResult.retryAfterMs } : {}),
    });
    return { status: 'rate-limited', ...(claudeResult.retryAfterMs != null ? { retryAfterMs: claudeResult.retryAfterMs } : {}) };
  }

  if (claudeResult.exitCode !== 0) {
    // Loop-detector classification: 125 means the silence watchdog killed a hung
    // spawn (no output for the silence window) — distinct from a wall-clock 124.
    // Surface it as its own audit event before the generic failure so the post-
    // mortem doesn't have to infer a stall from a generic exit code.
    if (claudeResult.exitCode === STALLED_EXIT_CODE) {
      audit('task.claude.stalled', 'dispatcher', {
        taskId: task.id,
        durationMs: claudeResult.durationMs,
        silenceTimeoutMs: config.claudeSilenceTimeoutMs,
      });
    }
    const failureLog = redactClaudeOutput(
      `claude exit ${claudeResult.exitCode}\nstderr:\n${claudeResult.stderr}\nstdout-tail:\n${claudeResult.stdout.slice(-2000)}`,
    );
    audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'claude', failure_log: failureLog });
    await notify.claudeCrashed(task.id, claudeResult.exitCode, redactClaudeOutput(claudeResult.stderr));
    return { status: 'failed-recoverable', failureLog, stage: 'claude' };
  }

  // Ambiguity escalation: agent exited 0 but wrote .nyx/ambiguity.json to
  // signal a genuine aesthetic decision it cannot resolve without operator input.
  // Detected BEFORE the gate so partial/stub code doesn't produce misleading
  // typecheck/test failures. Malformed files (bad JSON, wrong schema) fall
  // through silently — the gate runs and the real failure surfaces there instead.
  const ambiguity = parseAmbiguityFile(workingDir.path);
  if (ambiguity) {
    return { status: 'ambiguity-escalated', report: buildAmbiguityHaltReport(ambiguity) };
  }

  // Wisdom capture (v0.15): second claude -p spawn — agent reflects on lessons
  // learned from the just-completed task and writes NYX_WISDOM.md. Routes
  // the capture to a memory-graph node (or the Personality doc) or no-ops
  // for None. Non-fatal: any failure here is logged and skipped; it never blocks
  // dispatch or gate execution.
  if (task.type === 'code') {
    // Snapshot untracked files BEFORE the wisdom spawn so the finally block can
    // sweep anything the spawn newly created (not just the known WISDOM_FILE) —
    // the spawn has an unrestricted Write tool and could drop scratch files that
    // commitAll's `git add -A` would otherwise fold into the task's commit/PR.
    const preWisdomUntracked = untrackedSnapshot(workingDir.path);
    try {
      const wisdomResult = await invokeWisdomCapture(task, workingDir.path);
      const wisdom = wisdomResult.exitCode === 0
        ? parseWisdomFile(workingDir.path)
        : null;
      if (wisdom) {
        const { fileModified } = routeWisdomCapture(wisdom, task.id, workingDir.path);
        // routeWisdomCapture returns { fileModified: null } for BOTH a legitimate
        // `target: None` no-op AND a genuine routing failure (a non-existent
        // T2/T3/Personality path, a Graph id that fails its regex, or any FS
        // throw it swallows). Only `None` is a real no-op; any other target with
        // no file written means the lesson was lost — audit it as skipped, not
        // captured, so it doesn't masquerade as a successful capture.
        if (wisdom.target !== 'None' && fileModified === null) {
          audit('task.wisdom.skipped', 'dispatcher', {
            taskId: task.id,
            reason: `route returned no file for target ${wisdom.target}`,
          });
        } else {
          audit('task.wisdom.captured', 'dispatcher', {
            taskId: task.id,
            target: wisdom.target,
            ...(fileModified ? { fileModified } : {}),
          });
        }
      } else {
        audit('task.wisdom.skipped', 'dispatcher', {
          taskId: task.id,
          reason: wisdomResult.exitCode !== 0
            ? `wisdom spawn exit ${wisdomResult.exitCode}`
            : 'no file or malformed',
        });
      }
    } catch (err) {
      audit('task.wisdom.skipped', 'dispatcher', {
        taskId: task.id,
        reason: `wisdom capture threw: ${(err as Error).message}`,
      });
    } finally {
      // Guarantee zero net change to the committed diff from wisdom capture.
      // Sweep every path the spawn newly made untracked — not just WISDOM_FILE —
      // so a scratch file written under any name (or nested path) can't survive
      // into commitAll's `git add -A`. Files untracked BEFORE the spawn (the main
      // task's output, the operator's pre-existing untracked files) are in the
      // snapshot and left untouched.
      const postWisdomUntracked = untrackedSnapshot(workingDir.path);
      const toSweep = new Set<string>([WISDOM_FILE]);
      for (const rel of postWisdomUntracked) {
        if (!preWisdomUntracked.has(rel)) toSweep.add(rel);
      }
      for (const rel of toSweep) {
        const p = resolve(workingDir.path, rel);
        if (existsSync(p)) {
          try { rmSync(p, { recursive: true, force: true }); } catch { /* swallow */ }
        }
      }
    }
  }

  // Flaky rerun (P7): only the gate's `tests` stage is non-deterministic by
  // nature, so the rerun-on-same-tree check is armed for code tasks that gate on
  // tests. typecheck/lint are deterministic and need no rerun.
  const rerunFlakyTests =
    config.flakyRerunEnabled &&
    task.type === 'code' &&
    task.gates !== 'none' &&
    task.gates.includes('tests');
  const gate = runGate(task, workingDir.path, { rerunFlakyTests });
  if (gate.lockTimedOut) {
    // The machine-wide heavy-gate lock's wait budget elapsed with a live owner
    // still holding it; the heavy stages ran unlocked. Observational only —
    // never deadlock a tick on a stuck external process.
    audit('task.gate.lock_timeout', 'dispatcher', {
      taskId: task.id,
      waitedMs: gate.lockWaitedMs ?? 0,
      ownerPid: gate.lockOwnerPid ?? null,
    });
  }
  audit('task.gate.completed', 'dispatcher', {
    taskId: task.id,
    passed: gate.passed,
    stages: gate.stages.map(s => ({ name: s.name, passed: s.passed, durationMs: s.durationMs })),
  });
  if (gate.flaky) {
    // Rerun-pass = flaky-pass: the tests stage failed, then passed on the
    // IDENTICAL tree. Proceed (gate.passed is true) — under machine load a
    // single tests failure is contention more often than a real break (memory:
    // nyx-timing-tests-flake-under-load). The flake stays visible in the chain
    // instead of halting good work.
    const detail = gate.flakyDetail;
    audit('task.gate.flaky', 'dispatcher', {
      taskId: task.id,
      stage: 'tests',
      firstRunMs: detail?.firstRunMs ?? 0,
      rerunMs: detail?.rerunMs ?? 0,
    });
  }
  if (!gate.passed) {
    audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'gate', failure_log: gate.failureLog });
    const lastStage = gate.stages[gate.stages.length - 1]?.name ?? 'gate';
    await notify.taskFailed(task.id, lastStage, gate.failureLog);
    return { status: 'failed-recoverable', failureLog: gate.failureLog, stage: 'gate' };
  }

  // ── Pinned-version diff-scoped lint gate (P7 — CORTANA-GATE-LINT) ──
  // The script-based `lint` gate (if requested) runs the repo's own lint command
  // repo-wide. THIS stage is the version-pinned, diff-scoped lint: it runs the
  // EXACT ruff/eslint version the target repo's CI uses, over ONLY the files the
  // agent changed — closing the local-green / CI-red gap that cost a hotfix cycle
  // per bounce. HARD signal: a lint failure on the agent's own diff is a real
  // defect → failed-recoverable → audit. Code tasks only; never runs on a repo
  // with no ruff/eslint config, and degrades to a skip (not a fail) when the
  // pinned linter can't be installed/run.
  if (task.type === 'code') {
    const changedForLint = changedFilesWorkingTree(workingDir.path);
    const lint = runLintGate(workingDir.path, task.repo, changedForLint);
    if (!lint.ran) {
      audit('task.lint.skipped', 'dispatcher', { taskId: task.id, reason: lint.skipReason ?? 'no lintable files' });
    } else if (lint.passed) {
      audit('task.lint.passed', 'dispatcher', {
        taskId: task.id,
        tool: lint.tool,
        ...(lint.pinnedVersion ? { pinnedVersion: lint.pinnedVersion } : {}),
        versionSource: lint.versionSource,
        files: lint.scopedFiles.length,
      });
    } else {
      const pinNote = lint.pinnedVersion
        ? `${lint.tool}@${lint.pinnedVersion} (${lint.versionSource})`
        : `${lint.tool} (unpinned)`;
      const failureLog =
        `Pinned-version lint gate failed (${pinNote}) over ${lint.scopedFiles.length} changed file(s):\n\n${lint.log}`;
      audit('task.lint.failed', 'dispatcher', {
        taskId: task.id,
        tool: lint.tool,
        ...(lint.pinnedVersion ? { pinnedVersion: lint.pinnedVersion } : {}),
        versionSource: lint.versionSource,
        files: lint.scopedFiles,
      });
      audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'lint', failure_log: failureLog });
      await notify.taskFailed(task.id, 'lint', failureLog);
      return { status: 'failed-recoverable', failureLog, stage: 'lint' };
    }
  }

  // ── [expects:] verifier ──
  // Gate passing only proves the code compiles and tests run. It doesn't prove
  // the task actually produced the artifacts the spec asked for (the EMP-002
  // failure mode — wrong filename, silent no-op). expects checks each declared
  // artifact path exists; missing → failed-recoverable → audit pipeline.
  if (task.expects && task.expects.length > 0) {
    const missing = task.expects.filter((p) => !existsSync(resolve(workingDir.path, p)));
    if (missing.length > 0) {
      const failureLog =
        `Task [expects:] verifier failed.\n\n` +
        `Declared artifacts missing from working dir:\n` +
        missing.map((p) => `  - ${p}`).join('\n') +
        `\n\nThe gate passed, but the task description promised these files. Either Claude\n` +
        `produced them under different names (spec divergence), or didn't produce them at all.`;
      audit('task.expects.failed', 'dispatcher', {
        taskId: task.id,
        missing,
      });
      audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'expects', failure_log: failureLog });
      await notify.taskFailed(task.id, 'expects', failureLog);
      return { status: 'failed-recoverable', failureLog, stage: 'expects' };
    }
  }

  // ── Gate-trust flag (finding G-C) ──
  // The gate just ran INSIDE the worktree the agent controls. If the agent's
  // diff touched gate-controlling test-infra (conftest.py, jest/vitest config,
  // a CI workflow, the package.json scripts block, pyproject.toml/tsconfig.json/
  // eslint config), the green verdict could have been steered rather than earned
  // (the SWE-bench conftest hole). CAREFUL POLICY: flag for operator review — do
  // NOT fail. A task whose purpose IS editing test/lint config is legitimate and
  // must pass; we only surface the touched paths so the operator can confirm the
  // gate wasn't gamed. This is self-contained: the audit event + dedicated DM
  // fire here, at the detection point. Code tasks only — analysis/content/
  // assistant tasks neither run a gate nor commit a code diff.
  if (task.type === 'code') {
    const changed = changedFilesWorkingTree(workingDir.path);
    const trust = assessGateTrust(workingDir.path, changed);
    if (trust.paths.length > 0) {
      audit('task.gate.test_infra_touched', 'dispatcher', {
        taskId: task.id,
        paths: trust.paths,
        categories: [...new Set(trust.hits.map((h) => h.category))],
      });
      await notify.taskGateTestInfraTouched(task.id, trust.paths);
    }

    // ── Rotten-green oracle (P7, deterministic tier) ──
    // The gate is green, but a changed test file might assert nothing / be
    // skip-only / sink its result into a blank identifier — green because it
    // never checks anything. Cheap syntactic check over the changed TEST files
    // only; no LLM, no rerun. CAREFUL POLICY (mirrors gate-trust): flag for
    // review, never fail — a refactor can legitimately touch a test file.
    const rotten = assessRottenGreen(workingDir.path, changed);
    if (rotten.findings.length > 0) {
      audit('task.test_oracle.rotten_green', 'dispatcher', {
        taskId: task.id,
        findings: rotten.findings.map((f) => ({
          path: f.path,
          reasons: f.reasons,
          tests: f.testCount,
          assertions: f.assertionCount,
          skipped: f.skippedCount,
        })),
      });
      await notify.taskRottenGreen(
        task.id,
        rotten.findings.map((f) => `${f.path} (${f.reasons.join(', ')})`),
      );
    }
  }

  // ── Content-judge (P7, independent advisory tier) ──
  // A second, INDEPENDENT signal the gate cannot give: a haiku read-only spawn
  // scores the working-tree diff PASS/FAIL against the task's acceptance criteria.
  // This runs BEFORE finalize commits, so the diff lives in the working tree, not
  // a commit yet. Same-family (Claude judging Claude) so it is ADVISORY — a
  // confident FAIL flags for review, it never fails the task. Non-fatal end to
  // end, mirroring wisdom-capture: any spawn/parse failure is logged as skipped
  // and ignored. Code tasks only (the only type with a diff + acceptance criteria).
  if (task.type === 'code' && config.contentJudgeEnabled) {
    const preJudgeUntracked = untrackedSnapshot(workingDir.path);
    try {
      const judgeResult = await invokeContentJudge(task, workingDir.path);
      const judgement = judgeResult.exitCode === 0 ? parseJudgeFile(workingDir.path) : null;
      if (judgement) {
        audit('task.judge.captured', 'dispatcher', {
          taskId: task.id,
          verdict: judgement.verdict,
          confidence: judgement.confidence,
          score: judgement.score,
          dimensions: judgement.dimensions,
          parts: judgement.parts,
          parts_present: judgement.partsPresent,
          parts_total: judgement.partsTotal,
        });
        if (isJudgeConcern(judgement, config.contentJudgeConfidenceThreshold)) {
          const summary = summarizeJudgement(judgement);
          audit('task.judge.concern', 'dispatcher', { taskId: task.id, summary });
          await notify.taskJudgeConcern(task.id, summary);
        }
      } else {
        audit('task.judge.skipped', 'dispatcher', {
          taskId: task.id,
          reason: judgeResult.exitCode !== 0 ? `judge spawn exit ${judgeResult.exitCode}` : 'no file or malformed',
        });
      }
    } catch (err) {
      audit('task.judge.skipped', 'dispatcher', { taskId: task.id, reason: `judge threw: ${(err as Error).message}` });
    } finally {
      // Sweep NYX_JUDGE.md + anything the judge spawn newly made untracked, so
      // the advisory artifact never folds into the task's commit/PR (same guard
      // the wisdom spawn uses with its unrestricted Write tool).
      const postJudgeUntracked = untrackedSnapshot(workingDir.path);
      const toSweep = new Set<string>([JUDGE_FILE]);
      for (const rel of postJudgeUntracked) {
        if (!preJudgeUntracked.has(rel)) toSweep.add(rel);
      }
      for (const rel of toSweep) {
        const p = resolve(workingDir.path, rel);
        if (existsSync(p)) {
          try { rmSync(p, { recursive: true, force: true }); } catch { /* swallow */ }
        }
      }
    }
  }

  const testsPassed = countTestsPassed(gate.stages.map(s => s.log).join('\n'));
  const ctx = { task, workingDir, durationMs: Date.now() - startedAt, ...(testsPassed != null ? { testsPassed } : {}) };
  let outcome: RunOutcome;
  if (task.type === 'code' && task.repo) outcome = await finalizeCodeExternal(ctx);
  else if (task.type === 'code') outcome = await finalizeCodeLocal(ctx);
  else if (task.type === 'analysis') outcome = await finalizeAnalysis(ctx);
  else if (task.type === 'content') outcome = await finalizeContent(ctx);
  else outcome = await finalizeAssistant(ctx);

  if (outcome.status === 'failed') {
    // Finalize failures (push, PR-create) are recoverable in principle —
    // a rebase or auth fix lets the next attempt push. Audit decides.
    const fl = outcome.failureLog ?? 'finalize failure (no log)';
    // v0.8.x: emit task.failed for finalize failures too. Previously this
    // jumped straight to audit without an audit-row trail explaining why,
    // making post-hoc diagnosis ("what happened between task.committed and
    // task.audit.started?") needlessly archaeological.
    audit('task.failed', 'dispatcher', {
      taskId: task.id,
      stage: 'finalize',
      failure_log: fl,
    });
    await notify.taskFailed(task.id, 'finalize', fl);
    return { status: 'failed-recoverable', failureLog: fl, stage: 'finalize' };
  }

  return { status: 'completed', outcome };
}

/**
 * Emit task.halted_for_review, notify the operator, and return a failed
 * outcome. The clone/worktree is preserved so the operator can inspect.
 */
function haltTask(
  task: ParsedTask,
  workingDir: git.WorkingDir,
  startedAt: number,
  info: { operatorReport: string; pattern?: string; extraPayload?: Record<string, unknown> },
): RunOutcome {
  audit('task.halted_for_review', 'dispatcher', {
    taskId: task.id,
    pattern: info.pattern,
    operator_report: info.operatorReport,
    working_dir: workingDir.path,
    ...(info.extraPayload ?? {}),
  });
  // Fire-and-forget: don't block the dispatcher on Slack latency.
  void notify.taskHalted(task.id, info.pattern, info.operatorReport);
  // The halt is recorded in the audit chain (task.halted_for_review) and the
  // operator is notified above. A future remote plugin can surface it (e.g. a
  // dashboard banner) by reading that event until a task.resumed clears it;
  // the local core needs no extra work here.
  return {
    taskId: task.id,
    status: 'failed',
    durationMs: Date.now() - startedAt,
    failureLog: info.operatorReport,
  };
}

/**
 * Drive a thrown pipeline segment to the terminal `failed` sink AND surface it
 * to the operator. Used by BOTH tick entry points (the resume scan and the
 * queue loop) so a throw is handled identically regardless of which path was
 * advancing the run. Without the terminal transition the run sits at its
 * non-terminal status and re-runs the identical doomed work every tick; without
 * the DM the operator gets no signal a pipeline died (there is no
 * `notify.pipelineFailed`, so we use the generic `notify.dm`).
 */
async function failPipelineWithNotice(taskId: string, err: Error): Promise<void> {
  audit('pipeline.failed', 'pipeline', { taskId, error: err.stack ?? err.message });
  // Drive the run terminal so a thrown stage doesn't leave it at a non-terminal
  // status and retry the same doomed work every tick.
  failPipelineRun(taskId, err.message);
  await notify.dm(`🛑 *${taskId}* — pipeline run failed: ${err.message.slice(0, 500)}`);
}

/**
 * Tick priority 1: advance every run parked at a gate whose operator decision
 * arrived since the last tick, one run at a time so a throw on one run doesn't
 * abort advancement of the others. On throw, the run is driven to the terminal
 * `failed` sink (mirroring the queue-loop path) — leaving it at a non-terminal
 * status would re-run the identical doomed planning/delivery segment on every
 * tick. Returns the set of task_ids whose runs were touched this tick so the
 * queue loop can skip re-advancing the same run a second time in one tick.
 */
async function resumeDecidedRunsInTick(): Promise<Set<string>> {
  const handled = new Set<string>();
  for (const run of runsAwaitingDecision()) {
    // Resume-lease CAS (P3): atomically claim the run before advancing it so a
    // manual `nyx tick` overlapping the launchd tick can't both resume it (the
    // shell single-flight lock serializes scheduled ticks but NOT a manual tick
    // racing one). A lost CAS skips the run this tick; the winner owns it.
    const claimed = claimRunForResume(run.id, Date.now());
    if (!claimed) {
      audit('pipeline.resume.contended', 'pipeline', { runId: run.id, taskId: run.task_id });
      continue;
    }
    handled.add(run.task_id);
    try {
      await advancePipeline(claimed);
    } catch (err) {
      const e = err as Error;
      await failPipelineWithNotice(run.task_id, e);
      console.error(`[nyx] resume: pipeline ${run.task_id} threw:`, e.stack ?? e.message);
    }
  }
  return handled;
}

/**
 * Route a `[type: pipeline]` task through the stateful orchestrator. Find-or-
 * create its run, advance it as far as it goes this tick (autonomous segments
 * run synchronously, pausing only at a gate), and report whether the standing
 * task should now be marked complete.
 *
 * Runs parked at a gate with no decision are left untouched — `resumeDecidedRunsInTick`
 * (tick priority 1) advances them once the operator answers. ANY terminal run
 * (`done`/`failed`/`aborted`) whose standing task is still `[ ]` is reconciled out
 * of the active picker — a `done` run is marked complete, a `failed`/`aborted` run
 * is marked complete with the `[FAILED]` flag. Without this, a failed/aborted run
 * leaves its `[ ]` task in Active forever and the picker re-selects it every tick,
 * re-entering this branch and returning early — a runaway re-pick.
 *
 * Pipeline tasks deliberately bypass the inFlight/3-strike machinery the single-
 * spawn path uses — the run's own state table + the resume scan handle
 * continuation across ticks. (Internal coder sub-tasks DO use worktree/inFlight,
 * but that's inside the executing segment, added in a later build step.)
 */
async function handlePipelineInTick(
  task: ParsedTask,
  alreadyAdvanced: Set<string>,
): Promise<{ status: PipelineStatus; markComplete: boolean; failed: boolean }> {
  const isStanding = task.slot == null && task.everyStepSlots == null;
  const existing = getRunByTaskId(task.id);

  // C1: reject a fresh self-mode pipeline run (no valid [repo:]) up front. Self
  // mode builds the deliverable in a /tmp clone that cleanup deletes with no
  // merge-back — it never delivered, it only lost the output (silent success-
  // reported data loss). Fail loudly with guidance instead. Correct choices:
  // [repo: local] (greenfield → persists to Data/projects), [repo: owner/name]
  // (external → PR), or [type: code] to modify Nyx itself. In-flight runs (an
  // `existing` row from before this guard) are left to the branches below.
  if (!existing && targetMode(task.repo) === 'self') {
    const reason =
      `self-mode pipeline is unsupported: a [type: pipeline] task with no [repo:] ` +
      `builds in /tmp and is deleted at cleanup with no merge-back. Use [repo: local] ` +
      `for a new standalone project, [repo: owner/name] for a GitHub repo, or ` +
      `[type: code] to modify Nyx itself.`;
    audit('pipeline.rejected', 'pipeline', {
      taskId: task.id,
      reason: 'self-mode-unsupported',
      message: reason,
    });
    void notify.taskFailed(task.id, 'pipeline', reason);
    return { status: 'failed', markComplete: isStanding && !task.checked, failed: true };
  }

  if (existing && isTerminal(existing.status)) {
    // A prior tick (or the resume scan) already finished this run. Reconcile the
    // queue: ANY terminal run still sitting as `[ ]` in Active gets marked so the
    // picker stops re-selecting it. `done` → clean; `failed`/`aborted` → [FAILED].
    return reconcileTerminal(existing.status, isStanding, task.checked);
  }
  if (existing && isAwaiting(existing.status) && !existing.operator_decision) {
    // Still waiting on the operator. Don't advance; don't mark.
    return { status: existing.status, markComplete: false, failed: false };
  }
  if (existing && alreadyAdvanced.has(task.id)) {
    // The resume scan already advanced this run earlier in THIS tick. Advancing
    // it again here would run the next phase's coders in the same tick (the
    // resume scan ran phase-0, this would run phase-1). Reconcile only — a run
    // that reached a terminal status in the resume scan still gets its standing
    // task marked; a non-terminal run resumes its next segment on the next tick.
    if (isTerminal(existing.status)) return reconcileTerminal(existing.status, isStanding, task.checked);
    return { status: existing.status, markComplete: false, failed: false };
  }

  const run = existing ?? createPipelineRun(task);
  const final = await advancePipeline(run);
  if (isTerminal(final.status)) return reconcileTerminal(final.status, isStanding, false);
  return { status: final.status, markComplete: false, failed: false };
}

/**
 * Decide how a terminal pipeline run reconciles its standing queue task. `done`
 * marks it complete cleanly; `failed`/`aborted` mark it complete with the
 * `[FAILED]` flag so the picker drops it (its `baseFilter` excludes `[FAILED]`).
 */
function reconcileTerminal(
  status: PipelineStatus,
  isStanding: boolean,
  alreadyChecked: boolean,
): { status: PipelineStatus; markComplete: boolean; failed: boolean } {
  const shouldMark = isStanding && !alreadyChecked;
  return { status, markComplete: shouldMark, failed: status !== 'done' };
}

async function maybeIdleOrStaleAlert(): Promise<void> {
  const lastIdle = lastEventAt('dispatch.idle');
  if (!lastIdle || Date.now() - new Date(lastIdle).getTime() > COOLDOWN_MIN) {
    audit('dispatch.idle', 'dispatcher', {});
    await notify.queueIdle();
  }
  const last = lastSuccessfulTaskAt();
  if (last) {
    const ageHours = (Date.now() - new Date(last).getTime()) / 3_600_000;
    if (ageHours > STALE_THRESHOLD_HOURS) {
      const lastStale = lastEventAt('dispatch.stale');
      if (!lastStale || Date.now() - new Date(lastStale).getTime() > COOLDOWN_MIN) {
        audit('dispatch.stale', 'dispatcher', { ageHours });
        await notify.queueStale(Math.round(ageHours));
      }
    }
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

function desktopNotify(title: string, body: string): void {
  try {
    execFileSync(
      'osascript',
      ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`],
      { timeout: 5_000 },
    );
  } catch {
    // best-effort: non-macOS box or no GUI session
  }
}

/**
 * Once a day, compare the installed Core commit against origin/main and notify
 * the operator when behind. Gated by the `dispatch.update_check` audit event so
 * the network call runs at most once per UPDATE_CHECK_INTERVAL_MS; deduped by
 * remote sha via `dispatch.update_available` so the same pending update isn't
 * re-announced every day. With updates.autoApply, runs 'nyx update' instead.
 */
async function maybeUpdateCheck(): Promise<void> {
  if (config.settings.updates.check === false) return;
  const last = lastEventAt('dispatch.update_check');
  if (last && Date.now() - new Date(last).getTime() < UPDATE_CHECK_INTERVAL_MS) return;

  const script = resolve(config.repoRoot, 'scripts', 'nyx-update-check.sh');
  if (!existsSync(script)) return;

  let out = '';
  let code = 0;
  try {
    out = execFileSync('bash', [script], { encoding: 'utf8', timeout: 20_000, env: process.env }).trim();
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    code = typeof e.status === 'number' ? e.status : -1;
    out = (e.stdout ?? '').toString().trim();
  }
  const parts = out.split(/\s+/);
  const status = parts[0] || 'unknown';
  audit('dispatch.update_check', 'dispatcher', { status });
  if (code !== 10 && status !== 'update-available') return;

  const local = parts[1] ?? '?';
  const remote = parts[2] ?? '?';
  const prev = lastEventPayload('dispatch.update_available');
  if (prev && prev['remote'] === remote) return;
  audit('dispatch.update_available', 'dispatcher', { local, remote });

  if (config.settings.updates.autoApply) {
    await notify.dm(`⬆️ Nyx update available (${local} → ${remote}). Auto-applying via 'nyx update'.`);
    try {
      execFileSync('bash', [resolve(config.repoRoot, 'scripts', 'nyx-update.sh')], {
        env: process.env,
        timeout: 10_000,
      });
    } catch {
      // nyx-update detaches the reinstall; a non-zero/early return here is fine
    }
    return;
  }
  await notify.dm(`⬆️ Nyx update available: ${local} → ${remote}. Run 'nyx update' to apply.`);
  desktopNotify('Nyx update available', `${local} → ${remote} — run 'nyx update'`);
}

async function auditInvalidTagged(queuePath: string): Promise<void> {
  const queue = readQueue(queuePath);
  const flagged = tasksWithInvalidTags(queue);
  for (const t of flagged) {
    audit('task.tag.invalid', 'dispatcher', { taskId: t.id, invalidTags: t.invalidTags });
    await notify.dm(`⚠️ Task ${t.id} has invalid tags: ${t.invalidTags.map(x => `${x.tag}=${x.raw}`).join(', ')}. Skipping until fixed.`);
  }
}

/**
 * Apply the completion/failure bookkeeping for ONE finished single-spawn task
 * (code/analysis/assistant/content — NOT pipeline, which has its own reconcile
 * path). Extracted from the legacy serial loop so BOTH the concurrent ISO drain
 * and the synchronous GIT path reuse identical semantics: mark a standing task
 * complete on success, emit task.completed/failed, notify, and tear down a
 * failed external clone (unless the audit halted it, in which case the working
 * dir is preserved for the operator).
 *
 * MUST be called sequentially (never inside a Promise.all map) because
 * markTaskCompleted read-modify-writes the whole queue file — two concurrent
 * completions would race the file. The drain loop awaits each settle in turn,
 * so JS's single event loop gives us that serialization for free.
 */
async function applyTaskOutcome(task: ParsedTask, outcome: RunOutcome): Promise<void> {
  const isStanding = task.slot == null && task.everyStepSlots == null;
  if (outcome.status === 'completed') {
    if (isStanding) {
      markTaskCompleted(config.queuePath, task.id, {
        durationMs: outcome.durationMs,
        ...(outcome.testsPassed != null ? { testsPassed: outcome.testsPassed } : {}),
        ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
        ...(outcome.outputPath ? { outputPath: outcome.outputPath } : {}),
      });
    }
    const mins = Math.max(1, Math.round(outcome.durationMs / 60_000));
    const gateSum = outcome.testsPassed != null ? `${outcome.testsPassed} tests passed` : 'gate ok';
    const fin = outcome.prUrl
      ? `PR: ${outcome.prUrl}`
      : outcome.outputPath
      ? `output: ${outcome.outputPath}`
      : isStanding
      ? 'merged to main'
      : `slot ${slotOf()} (${slotToTime(slotOf())}) fired`;
    audit('task.completed', 'dispatcher', { taskId: task.id, durationMs: outcome.durationMs });
    await notify.taskCompleted(task.id, mins, gateSum, fin);
    return;
  }

  // Failure path. dispatchOne audits task.failed for setup/claude/gate failures,
  // but finalize-stage failures only return status:failed without an audit row.
  // Backstop: if the outcome carries a failureLog AND there's no fresh
  // task.failed row, emit one. Always notify so the operator sees the dead end.
  if (outcome.failureLog) {
    const recentFailAt = lastEventAt('task.failed');
    const isFresh = recentFailAt
      ? new Date(recentFailAt).getTime() >= Date.now() - outcome.durationMs - 1000
      : false;
    if (!isFresh) {
      audit('task.failed', 'dispatcher', {
        taskId: task.id,
        stage: 'finalize',
        failure_log: outcome.failureLog,
        durationMs: outcome.durationMs,
      });
      await notify.taskFailed(task.id, 'finalize', outcome.failureLog);
    }
  }
  // Tear down a failed external clone ONLY if the audit pipeline did NOT halt
  // the task — a halt preserves the working dir for operator inspection.
  if (!isTaskHalted(task.id)) {
    const cloneDir = `${config.cloneRootPrefix}${task.id}`;
    if (existsSync(cloneDir)) {
      try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

/**
 * True iff a rate-limit cooldown opened by a prior tick (or earlier in this one)
 * is still in effect. When open, ZERO new spawns of any class fire this tick —
 * the queued tasks simply wait. This is the global brake the directive calls
 * for: a 429 leaves work queued, never failed.
 */
function rateLimitCooldownActive(now: number = Date.now()): boolean {
  const payload = lastEventPayload('dispatch.rate_limited');
  if (!payload) return false;
  const until = typeof payload['until'] === 'number' ? payload['until'] : 0;
  return until > now;
}

/** Open (or extend) the rate-limit cooldown after a 429/overload outcome. */
function openRateLimitCooldown(taskId: string, retryAfterMs?: number): void {
  const cooldownMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : config.rateLimitCooldownMs;
  audit('dispatch.rate_limited', 'dispatcher', {
    taskId,
    until: Date.now() + cooldownMs,
    cooldownMs,
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Shared pre-dispatch gates for a single-spawn (non-pipeline) task: halt-chain,
 * the inFlight sentinel, and the legacy ≥3-raw-failures drain. Returns whether
 * the task is dispatchable; on a skip it records the audit row + adds the id to
 * `skippedThisTick` so the same tick doesn't re-pick it. Extracted so the ISO
 * refill and the GIT path apply identical gating.
 *
 * Halt-check MUST precede inFlight (the documented working-dir-preservation
 * invariant): inFlight on a halted task sees a dead sentinel pid and wipes the
 * preserved dir. Order is retained here.
 */
async function prepareSingleSpawn(
  task: ParsedTask,
  skippedThisTick: Set<string>,
): Promise<boolean> {
  if (isTaskHalted(task.id)) {
    audit('task.skipped.halt_chain', 'dispatcher', { taskId: task.id });
    skippedThisTick.add(task.id);
    return false;
  }
  const flightStatus = git.inFlight(task.id);
  if (flightStatus === 'live') {
    audit('task.skipped.in_flight', 'dispatcher', { taskId: task.id });
    skippedThisTick.add(task.id);
    return false;
  }
  if (flightStatus === 'stale_cleared') {
    audit('task.stale_worktree_cleared', 'dispatcher', { taskId: task.id });
    // Fall through — the ghost dir was cleaned up.
  }
  const failCount = failureCountForTask(task.id);
  if (failCount >= 3) {
    audit('task.halted_for_review', 'dispatcher', {
      taskId: task.id,
      pattern: 'legacy-3-strike',
      operator_report: `Task accumulated ${failCount} failures before v0.7 audit pipeline existed. Inspect the audit history, then \`nyx resume ${task.id}\`.`,
    });
    await notify.taskAbandoned(task.id, `${failCount} prior failures`);
    skippedThisTick.add(task.id);
    return false;
  }
  return true;
}

/**
 * Advance one `[type: pipeline]` task this tick + apply its queue reconcile.
 * Extracted from the legacy loop so the GIT path runs it under the git lock. A
 * pipeline phase that does real work IS the tick's GIT actor — the caller holds
 * the lock for its lifetime. Returns true if a phase actually ran (so a
 * subsequent ISO refill respects the global ceiling).
 */
async function advancePipelineTask(
  task: ParsedTask,
  resumedTaskIds: Set<string>,
): Promise<void> {
  try {
    const result = await handlePipelineInTick(task, resumedTaskIds);
    if (result.markComplete) {
      const run = getRunByTaskId(task.id);
      const durationMs = run ? Date.now() - run.created_at : 0;
      markTaskCompleted(config.queuePath, task.id, { durationMs, ...(result.failed ? { failed: true } : {}) });
      if (result.failed) {
        audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'pipeline', failure_log: `pipeline run terminated: ${result.status}` });
      } else {
        audit('task.completed', 'dispatcher', { taskId: task.id, durationMs, type: 'pipeline' });
      }
      console.log(`[nyx] pipeline ${task.id} reconciled (${result.status})`);
    } else {
      console.log(`[nyx] pipeline ${task.id} advanced to ${result.status}`);
    }
  } catch (err) {
    const e = err as Error;
    await failPipelineWithNotice(task.id, e);
    console.error(`[nyx] pipeline ${task.id} threw:`, e.stack ?? e.message);
  }
}

async function processDecomposeActions(): Promise<number> {
  const pending = listPending().filter((a) => a.action === 'decompose_task');
  let decomposed = 0;
  for (const a of pending) {
    try {
      const { tasks, error } = await invokeDecomposer(a.params as unknown as DecomposeIntent);
      if (!tasks) {
        markFailed(a.id, error ?? 'no tasks produced', Date.now());
        audit('control.decompose.failed', 'control', { id: a.id, source: a.source, error: error ?? 'no tasks' });
        continue;
      }
      const cur = existsSync(config.queuePath) ? readFileSync(config.queuePath, 'utf8') : '## Active Tasks\n';
      writeFileSync(config.queuePath, insertUnderActiveTasks(cur, tasks));
      markApplied(a.id, 'decomposed', Date.now());
      audit('control.decompose.applied', 'control', { id: a.id, source: a.source });
      decomposed++;
      console.log(`[nyx] decomposed action ${a.id} -> tasks queued`);
    } catch (err) {
      markFailed(a.id, (err as Error).message, Date.now());
      audit('control.decompose.failed', 'control', { id: a.id, source: a.source, error: (err as Error).message });
    }
  }
  return decomposed;
}

/**
 * Drain pending `compose_template` actions — the desktop Create Templates
 * page's "Draft with Claude" path. Mirrors processDecomposeActions: each
 * action spawns a sonnet `claude -p` (invokeTemplateComposer), the validated
 * template is appended to $NYX_DATA_DIR/templates.json atomically with
 * source: "ai", and the action is marked applied/failed HERE so the generic
 * drainPendingActions (status='pending') skips it.
 */
async function processComposeTemplateActions(): Promise<number> {
  const pending = listPending().filter((a) => a.action === 'compose_template');
  let composed = 0;
  for (const a of pending) {
    try {
      const { template, error } = await invokeTemplateComposer(a.params as unknown as ComposeTemplateIntent);
      if (!template) {
        markFailed(a.id, error ?? 'no template produced', Date.now());
        audit('control.compose_template.failed', 'control', { id: a.id, source: a.source, error: error ?? 'no template' });
        continue;
      }
      writeTemplateIntoStore(templatesStorePath(), template);
      markApplied(a.id, `composed ${template.id}`, Date.now());
      audit('control.compose_template.applied', 'control', { id: a.id, source: a.source, templateId: template.id });
      composed++;
      console.log(`[nyx] compose_template action ${a.id} -> template ${template.id} written`);
    } catch (err) {
      markFailed(a.id, (err as Error).message, Date.now());
      audit('control.compose_template.failed', 'control', { id: a.id, source: a.source, error: (err as Error).message });
    }
  }
  return composed;
}

async function main(): Promise<void> {
  validateConfig();
  const lock = acquire(config.lockfilePath);
  if (!lock) {
    console.log('[nyx] another dispatcher is running. exit 0.');
    process.exit(0);
  }

  audit('dispatch.tick', 'dispatcher', { pid: process.pid, slot: slotOf() });

  const chain = verifyChainPeriodic();
  if (!chain.ok) {
    const msg = `audit chain broken at row ${chain.firstBadRowId} (${chain.reason}). refusing to start.`;
    console.error(`[nyx] ${msg}`);
    await notify.dm(`🚨 ${msg}`);
    lock.release();
    process.exit(2);
  }
  audit('dispatch.chain_verified', 'dispatcher', { rows: chain.totalRows, full: chain.wasFull });

  // Tick-gap self-detection. The shell writes data/last-tick-ok (epoch seconds)
  // on `tick exit 0`. If the gap since the last healthy tick exceeds the
  // threshold, a prior outage (failed keg, dead launchd — the 2026-06-08
  // incident) just ended; this is the FIRST tick after recovery. Emit a recovery
  // signal + notify so the operator learns the daemon is alive again. Swallowed:
  // a heartbeat read/parse hiccup must never abort a tick that can do real work.
  try {
    const lastTickPath = `${config.dataDir}/data/last-tick-ok`;
    let lastOk: number | null = null;
    if (existsSync(lastTickPath)) {
      const parsed = Number.parseInt(readFileSync(lastTickPath, 'utf8').trim(), 10);
      lastOk = Number.isFinite(parsed) ? parsed : null;
    }
    const gap = tickGapMinutes(lastOk, Date.now());
    if (gap !== null && gap > 20) {
      audit('tick.gap_detected', 'dispatcher', { gap_minutes: gap });
      await notify.deliver(
        'action-required',
        `⚠️ Nyx outage recovered: first successful tick after a ${gap}m gap. ` +
          `The dispatcher was silent for ~${Math.round(gap / 60)}h — check logs/launchctl for the cause.`,
      );
    }
  } catch (err) {
    console.error('[nyx] tick-gap check failed (non-fatal):', (err as Error).message);
  }

  await initPlugins();
  await emitHook('tick.before', { slot: slotOf(), pid: process.pid });

  // Decompose any pending decompose_task actions (a natural-language request ->
  // fully-tagged tasks via a sonnet claude -p call) before the generic drain,
  // so the resulting tasks land under ## Active Tasks this same tick. Each is
  // marked applied/failed here, so drainPendingActions (status='pending') skips
  // them.
  const decomposedThisTick = await processDecomposeActions();

  // Compose any pending compose_template actions (Create Templates "Draft with
  // Claude") the same way — handled before the generic drain, marked
  // applied/failed in-place.
  await processComposeTemplateActions();

  const controlApplied = drainPendingActions(
    {
      queueTask: (p) => {
        // Accept either a pre-built `raw` task block, or a simple intent
        // ({ text, type, repo }) from UI producers (desktop, Slack,
        // remoteactions) — canonicalize the latter into a task block here so
        // every control-surface producer can send the same simple shape.
        let raw = String(p.raw ?? '').trim();
        if (!raw) {
          const text = String(p.text ?? '').trim();
          if (!text) throw new Error('queue_task missing raw or text');
          const type = String(p.type ?? 'assistant').trim().toLowerCase();
          const id = `UI-${Date.now().toString(36).slice(-6).toUpperCase()}`;
          const tags = [`[type: ${type}]`];
          if (p.repo) {
            // Security (C2): a control-action repo string flows verbatim into the
            // queued `[repo:]` tag and, later, into `git clone`. Reject anything
            // that isn't an `owner/name` repo or greenfield keyword here, at the
            // control-plane boundary, rather than relying solely on the task-reader
            // backstop — a malicious/relayed producer must not reach the clone.
            // `app:<slug>` is pipeline-only: on any other type it would clone a
            // guaranteed-404 GitHub URL, so it's rejected per-type like task-reader.
            const repo = String(p.repo);
            if (!isValidRepoTag(repo, type)) {
              throw new Error(
                `queue_task: invalid [repo:] value ${JSON.stringify(repo)} for [type: ${type}] — ` +
                  `must be "owner/name" or a greenfield keyword (local|new|greenfield|scratch); ` +
                  `"app:<slug>" (slug: [a-z0-9-]+) is valid only with [type: pipeline]`,
              );
            }
            tags.push(`[repo: ${repo}]`);
          }
          raw = `- [ ] ${id} — ${text}\n      ${tags.join(' ')}`;
        }
        const cur = existsSync(config.queuePath) ? readFileSync(config.queuePath, 'utf8') : '## Active Tasks\n';
        writeFileSync(config.queuePath, insertUnderActiveTasks(cur, raw));
        return 'queued';
      },
      resumeTask: (p) => {
        const taskId = String(p.taskId ?? '');
        if (!taskId) throw new Error('resume_task missing taskId');
        audit('task.resumed', 'control', { taskId });
        return `resumed ${taskId}`;
      },
      pipelineDecision: (p) => {
        const runId = String(p.runId ?? '');
        if (!runId) throw new Error('pipeline_decision missing runId');
        // submitDecision NEVER throws — it returns { ok: false, message } for an
        // invalid verb, a verb illegal at the current gate, a run not at a gate,
        // or a revise/fix with no note. Discarding the result lets drainPendingActions
        // mark the action 'applied' even though nothing was recorded, so a stale or
        // verb-drifted desktop decision silently vanishes. Throw on rejection so the
        // action is marked failed with the validator's message (control.action.failed).
        const res = submitDecision(runId, p.decision as DecisionKind, {
          note: p.note ? String(p.note) : undefined,
          source: 'control',
        });
        if (!res.ok) throw new Error(res.message);
        return `pipeline ${String(p.decision)} on ${runId}`;
      },
    },
    () => Date.now(),
  );
  if (controlApplied > 0) console.log(`[nyx] control actions applied: ${controlApplied}`);

  // Off-hours digest: if this tick is the start of a working window (or a manual
  // override just armed), flush the "what you missed" summary before any new work
  // so the operator's catch-up lands first. Best-effort — never blocks the tick.
  try {
    await maybeFlushDigest();
  } catch (err) {
    console.error('[nyx] maybeFlushDigest threw (unexpected):', (err as Error).message);
  }

  // Type-aware concurrency (Track 3). The blanket "any claude live → exit(0)"
  // guard is gone — it serialized EVERY task type behind one in-flight claude,
  // so a 25-min build starved every digest. Now:
  //   - 'global' — conservative rollback: if ANY claude on the box is live (incl.
  //     a concurrent Iris session), skip ALL spawning this tick. Reproduces the
  //     legacy behavior with one setting, no code revert.
  //   - 'own'/'off' — the two-class scheduler below runs: ISO tasks fan out up to
  //     the cap, ONE GIT task runs under the git single-flight lock.
  // The decision is taken here and consumed by the scheduler loop further down.
  const guard = config.settings.dispatcher.concurrencyGuard;
  const globalGuardBusy = guard === 'global' && hasLiveClaude();
  if (globalGuardBusy) {
    audit('task.skipped.concurrent_claude', 'dispatcher', { mode: guard });
    console.log(`[nyx] concurrent claude detected (${guard}). skipping spawns this tick.`);
  }

  await auditInvalidTagged(config.queuePath);

  // Drain the secrets-rotation inbox before picking a task. Best-effort —
  // ingestInbox never throws, just audits malformed files into .failed/ .
  try {
    const result = ingestInbox();
    if (result.ingested > 0 || result.malformed > 0) {
      console.log(`[nyx] inbox: ingested=${result.ingested} malformed=${result.malformed}`);
    }
  } catch (err) {
    console.error('[nyx] inbox ingest threw (unexpected):', (err as Error).message);
  }

  // Pipeline tick priority 1: resume any run parked at a gate whose operator
  // decision arrived since the last tick. Runs that reach `done` here are
  // reconciled in the queue loop below — their standing task is still picked,
  // sees a terminal run, and gets marked complete. A throw in any single run is
  // driven terminal (see resumeDecidedRunsInTick) rather than swallowed, so a
  // scheduled pipeline task can't re-run a doomed segment every tick.
  let resumedTaskIds = new Set<string>();
  try {
    resumedTaskIds = await resumeDecidedRunsInTick();
    if (resumedTaskIds.size > 0) {
      console.log(`[nyx] pipeline: resumed ${resumedTaskIds.size} decided run(s)`);
    }
  } catch (err) {
    console.error('[nyx] resumeDecidedRunsInTick threw (unexpected):', (err as Error).message);
  }

  // Within-tick state. Both sets are populated as we go.
  const skippedThisTick = new Set<string>();
  // Audit-derived: tasks that already fired in the current slot's wall-clock
  // window (some prior tick this same slot). Slotted tasks in this set are
  // suppressed so a single slot fires each task at most once.
  const window = slotWindow();
  const firedInSlot = tasksFiredInWindow(window.start, window.end);

  // A tick that decomposed an NL request does NOT also execute the resulting
  // tasks — decompose means "queue for review". They run on a later tick (the
  // 5-min daemon, or a manual `nyx tick` / the desktop Tick button).
  if (decomposedThisTick > 0) {
    console.log(`[nyx] decomposed ${decomposedThisTick} request(s); tasks queued — they run on the next tick.`);
  }

  // ── Type-aware scheduler (Track 3) ──
  // The scheduling core lives in tick-scheduler.runTwoClassTick (unit-tested
  // with fakes for peak-concurrency / cap / GIT-doesn't-block-ISO / crash
  // isolation). Here we wire the real implementations. ISO tasks fan out
  // concurrently up to effectiveIsoCap; ≤1 GIT task runs synchronously under the
  // git single-flight lock; a 429 opens a global cooldown and leaves work queued.
  // The concurrency is WITHIN this tick (ISO overlaps the one GIT task). It is
  // NOT cross-tick: the shell lock in nyx-dispatch.sh keeps the next launchd tick
  // from starting while this GIT task is awaited here (see git-task-lock.ts).
  //
  // 'global' guard busy OR an active 429 cooldown → ZERO spawns this tick; the
  // queued tasks simply wait. A resumed pipeline phase (resumeDecidedRunsInTick)
  // already consumed the GIT slot, so we pass gitSlotTaken accordingly.
  const spawningAllowed =
    decomposedThisTick === 0 && !globalGuardBusy && !rateLimitCooldownActive();
  if (decomposedThisTick === 0 && !globalGuardBusy && rateLimitCooldownActive()) {
    console.log('[nyx] rate-limit cooldown active — skipping all spawns this tick.');
  }

  if (spawningAllowed) {
    const result = await runTwoClassTick(
      {
        pickNext: (classFilter) =>
          pickNextTask(readQueue(config.queuePath), {
            firedInSlot,
            skipThisTick: skippedThisTick,
            classFilter,
            // Exclude halted tasks at SELECTION time so a halted high-priority
            // task can't freeze the standing queue — the picker falls through to
            // the next eligible task in the same tick. The in-dispatch re-check in
            // prepareSingleSpawn stays as the race backstop (halt arriving mid-tick).
            isHalted: isTaskHalted,
          }),
        prepareSingleSpawn: (task) => prepareSingleSpawn(task, skippedThisTick),
        markScheduled: (task) => {
          skippedThisTick.add(task.id);
          firedInSlot.add(task.id);
        },
        dispatch: dispatchOne,
        advancePipeline: (task) => advancePipelineTask(task, resumedTaskIds),
        applyOutcome: applyTaskOutcome,
        openCooldown: openRateLimitCooldown,
        // effectiveIsoCap = min(maxConcurrentIso, ceiling - live spawns) so a
        // coder-heavy pipeline phase and the ISO pool share one Max-plan budget.
        effectiveIsoCap: () =>
          Math.max(0, Math.min(config.maxConcurrentIso, config.maxConcurrentClaude - liveOwnClaudeCount())),
        liveGitTaskExists: () => liveGitTaskExists(config.gitTaskLockPath),
        writeGitLock: (taskId) => writeGitLock(config.gitTaskLockPath, taskId),
        removeGitLock: () => removeGitLock(config.gitTaskLockPath),
        isoLaunchJitterMs: config.isoLaunchJitterMs,
        auditPoolDrained: (count) => audit('dispatch.iso_pool.drained', 'dispatcher', { count }),
        auditIsoThrow: (reason) => audit('task.failed', 'dispatcher', { stage: 'iso-drain', failure_log: reason }),
        sleep,
        log: (msg) => console.log(`[nyx] ${msg}`),
      },
      { gitSlotTaken: resumedTaskIds.size > 0 },
    );
    if (result.gitTasksRun >= config.maxChainDepth) {
      audit('dispatch.chain_limit_reached', 'dispatcher', { depth: result.gitTasksRun });
    }
    // A resumed pipeline phase IS work — it just doesn't go through the
    // scheduler's launch path — so it suppresses the idle alert too.
    if (!result.producedWork && resumedTaskIds.size === 0) await maybeIdleOrStaleAlert();
  }
  // When spawning is suppressed (global-guard busy, decompose-only, or a 429
  // cooldown) the tick is deliberately not idle — no idle/stale alert fires.

  await maybeUpdateCheck();

  // Trace→eval→lesson loop FOUNDATION (G-A). Runs at the TAIL of the tick, off
  // the hot path: sample a % of clean terminal runs + 100% of flagged ones, score
  // them with a cheap judge into the off-chain eval_scores table, and DM on a 7d
  // quality regression. Cadence-gated internally; a no-op unless evaluation is
  // enabled. Wrapped so a judge/DB hiccup in the eval layer can never fail a tick
  // that already did its real work.
  try {
    await runEvalLoop();
  } catch (err) {
    console.error('[nyx] eval loop threw (non-fatal):', (err as Error).message);
  }

  // Activity ledger: re-render the narrative projection of the chain to
  // Data/ledger/LEDGER.md so the next brief/digest reads a current view. Cheap
  // and skipped entirely when no new audit row was appended since the last
  // render. The render swallows its own errors internally; the extra try/catch
  // here guarantees a ledger bug can NEVER fail a tick that already did its work.
  try {
    maybeRenderLedgerAtTickEnd();
  } catch (err) {
    console.error('[nyx] ledger render threw (non-fatal):', (err as Error).message);
  }

  await emitHook('tick.after', { slot: slotOf(), pid: process.pid });
  // The heartbeat is written by the shell (`nyx-dispatch.sh`) on `tick exit 0`,
  // not here — exactly one writer. A TS-side write would record a "success" even
  // for a tick whose process later exits non-zero, defeating the watchdog.
  lock.release();
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error('[nyx] fatal:', e.stack ?? e.message);
  audit('task.failed', 'dispatcher', { stage: 'top-level', failure_log: e.stack ?? e.message });
  process.exit(1);
});
