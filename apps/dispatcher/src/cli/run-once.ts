import { execSync } from 'node:child_process';
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
  lastSuccessfulTaskAt,
  tasksFiredInWindow,
  verifyChain,
} from '../audit.js';
import { runAudit, MAX_AUDIT_PASSES } from '../audit-runner.js';
import type { FlightPlan } from '../composer/types.js';
import {
  advancePipeline,
  createPipelineRun,
  getRunByTaskId,
  resumeDecidedRuns,
} from '../pipeline/orchestrator.js';
import { isAwaiting, isTerminal, type DecisionKind, type PipelineStatus } from '../pipeline/types.js';
import { buildPrevalidateFailureLog, prevalidateExpects } from '../expects-prevalidate.js';
import { config } from '../config.js';
import { emitHook, initPlugins } from '../plugins/index.js';
import { drainPendingActions, insertUnderActiveTasks } from '../control/actions.js';
import { submitDecision } from '../pipeline/decide.js';
import { acquire } from '../lockfile.js';
import * as notify from '../notifier.js';
import {
  markTaskCompleted,
  pickNextTask,
  readQueue,
  slotOf,
  slotWindow,
  tasksWithInvalidTags,
} from '../task-reader.js';
import { runPreflight } from '../preflight.js';
import { buildPrompt, invokeClaude, invokeWisdomCapture } from '../task-runner.js';
import { WISDOM_FILE, parseWisdomFile, routeWisdomCapture } from '../wisdom-capture.js';
import { countTestsPassed, runGate } from '../test-gate.js';
import {
  finalizeAnalysis,
  finalizeAssistant,
  finalizeCodeExternal,
  finalizeCodeLocal,
  finalizeContent,
} from './finalize.js';
import * as git from '../git-ops.js';
import { ingestInbox } from '../secrets/inbox-ingest.js';
import { handleSpawnProject, isSpawnProjectTask } from '../secrets/spawn-project.js';
import { schedulingOf, type ParsedTask, type RunOutcome } from '../types.js';

const COOLDOWN_MIN = 60 * 60_000;
const STALE_THRESHOLD_HOURS = 24;

/**
 * Detect a live `claude` CLI process that isn't us.
 *
 * Strict: only counts processes whose argv[0] basename is exactly "claude",
 * OR `node`/`tsx` invocations whose argv[1] basename is "claude" (or ends in
 * `claude.js`). Substring matches on "claude" elsewhere in the command line
 * are ignored.
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
      // Exclude the Nyx dispatcher's own processes AND the operator's
      // interactive Claude Code session(s). Case-insensitive on the latter
      // because the new claude-code path on macOS is
      // /Users/<u>/Library/Application Support/Claude/claude-code/<ver>/claude.app/...
      // (lowercase claude.app), while the older /Applications/Claude.app/...
      // GUI had a capital C. Both should be excluded; only the spawned
      // `claude` CLI for an in-flight Nyx task should trigger the live
      // detection.
      const cmdLower = cmd.toLowerCase();
      if (
        cmd.includes('nyx-dispatch.sh') ||
        cmd.includes('run-once') ||
        cmdLower.includes('claude.app') ||
        cmdLower.includes('claude-code/')
      ) {
        continue;
      }

      const tokens = cmd.split(/\s+/);
      const t0 = basename(tokens[0] ?? '');
      if (t0 === 'claude') return true;
      if ((t0 === 'node' || t0 === 'tsx') && tokens[1]) {
        const t1 = basename(tokens[1] ?? '');
        if (t1 === 'claude' || t1.endsWith('claude.js')) return true;
      }
    }
    return false;
  } catch {
    return false;
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
    if (result.status === 'ambiguity-escalated') {
      audit('task.ambiguity.escalated', 'dispatcher', { taskId: task.id, ambiguity_file: AMBIGUITY_FILE });
      void notify.taskAmbiguityEscalated(task.id, result.report);
      return haltTask(task, workingDir, startedAt, {
        operatorReport: result.report,
        pattern: 'aesthetic-ambiguity',
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
    });
    if (auditOutcome.kind === 'autofix_applied') {
      audit('task.audit.autofix.succeeded', 'dispatcher', {
        taskId: task.id,
        pattern: auditOutcome.pattern,
      });
      // Loop back — re-run Claude + gate + finalize against the fixed working dir.
      continue;
    }
    // 'escalated_to_halt' or 'audit_failed' — both halt the chain.
    const report =
      auditOutcome.kind === 'escalated_to_halt'
        ? auditOutcome.operatorReport
        : `Audit phase errored: ${auditOutcome.reason}`;
    return haltTask(task, workingDir, startedAt, {
      operatorReport: report,
      pattern: auditOutcome.kind === 'escalated_to_halt' ? auditOutcome.pattern : undefined,
    });
  }

  // Unreachable in practice — the loop always returns. Safety net.
  return { taskId: task.id, status: 'failed', durationMs: Date.now() - startedAt, failureLog: 'attempt loop exited unexpectedly' };
}

/** Create the working dir appropriate for this task type. Pure helper. */
function createWorkingDir(task: ParsedTask, opts: { reuseExisting?: boolean }): git.WorkingDir {
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
  | { status: 'failed-recoverable'; failureLog: string }
  | { status: 'ambiguity-escalated'; report: string };

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
    return { status: 'failed-recoverable', failureLog };
  }

  const claudeResult = await invokeClaude(
    task,
    workingDir.path,
    opts.flightPlan ? { flightPlan: opts.flightPlan } : {},
  );
  audit('task.claude.exited', 'dispatcher', {
    taskId: task.id,
    exitCode: claudeResult.exitCode,
    durationMs: claudeResult.durationMs,
  });

  if (claudeResult.exitCode !== 0) {
    const failureLog = `claude exit ${claudeResult.exitCode}\nstderr:\n${claudeResult.stderr}\nstdout-tail:\n${claudeResult.stdout.slice(-2000)}`;
    audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'claude', failure_log: failureLog });
    await notify.claudeCrashed(task.id, claudeResult.exitCode, claudeResult.stderr);
    return { status: 'failed-recoverable', failureLog };
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
  // the capture to the appropriate tier doc (T4/T2/T3/Personality) or no-ops
  // for None. Non-fatal: any failure here is logged and skipped; it never blocks
  // dispatch or gate execution.
  if (task.type === 'code') {
    try {
      const wisdomResult = await invokeWisdomCapture(task, workingDir.path);
      const wisdom = wisdomResult.exitCode === 0
        ? parseWisdomFile(workingDir.path)
        : null;
      if (wisdom) {
        const { fileModified } = routeWisdomCapture(wisdom, task.id, workingDir.path);
        audit('task.wisdom.captured', 'dispatcher', {
          taskId: task.id,
          target: wisdom.target,
          ...(fileModified ? { fileModified } : {}),
        });
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
      // Always clean up NYX_WISDOM.md from the working dir so it doesn't
      // get committed to external repos or Nyx local as part of the task diff.
      const wfPath = resolve(workingDir.path, WISDOM_FILE);
      if (existsSync(wfPath)) {
        try { rmSync(wfPath); } catch { /* swallow */ }
      }
    }
  }

  const gate = runGate(task, workingDir.path);
  audit('task.gate.completed', 'dispatcher', {
    taskId: task.id,
    passed: gate.passed,
    stages: gate.stages.map(s => ({ name: s.name, passed: s.passed, durationMs: s.durationMs })),
  });
  if (!gate.passed) {
    audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'gate', failure_log: gate.failureLog });
    const lastStage = gate.stages[gate.stages.length - 1]?.name ?? 'gate';
    await notify.taskFailed(task.id, lastStage, gate.failureLog);
    return { status: 'failed-recoverable', failureLog: gate.failureLog };
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
      return { status: 'failed-recoverable', failureLog };
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
    return { status: 'failed-recoverable', failureLog: fl };
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
  info: { operatorReport: string; pattern?: string },
): RunOutcome {
  audit('task.halted_for_review', 'dispatcher', {
    taskId: task.id,
    pattern: info.pattern,
    operator_report: info.operatorReport,
    working_dir: workingDir.path,
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
 * Route a `[type: pipeline]` task through the stateful orchestrator. Find-or-
 * create its run, advance it as far as it goes this tick (autonomous segments
 * run synchronously, pausing only at a gate), and report whether the standing
 * task should now be marked complete.
 *
 * Runs parked at a gate with no decision are left untouched — `resumeDecidedRuns`
 * (tick priority 1) advances them once the operator answers. Terminal runs are
 * reconciled: a `done` run whose standing task is still `[ ]` gets marked.
 *
 * Pipeline tasks deliberately bypass the inFlight/3-strike machinery the single-
 * spawn path uses — the run's own state table + the resume scan handle
 * continuation across ticks. (Internal coder sub-tasks DO use worktree/inFlight,
 * but that's inside the executing segment, added in a later build step.)
 */
async function handlePipelineInTick(
  task: ParsedTask,
): Promise<{ status: PipelineStatus; markComplete: boolean }> {
  const isStanding = task.slot == null && task.everyStepSlots == null;
  const existing = getRunByTaskId(task.id);

  if (existing && isTerminal(existing.status)) {
    // A prior tick (or the resume scan) already finished this run. Reconcile the
    // queue: a delivered run still sitting as `[ ]` in Active gets marked done.
    return { status: existing.status, markComplete: existing.status === 'done' && isStanding && !task.checked };
  }
  if (existing && isAwaiting(existing.status) && !existing.operator_decision) {
    // Still waiting on the operator. Don't advance; don't mark.
    return { status: existing.status, markComplete: false };
  }

  const run = existing ?? createPipelineRun(task);
  const final = await advancePipeline(run);
  return { status: final.status, markComplete: final.status === 'done' && isStanding };
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

async function auditInvalidTagged(queuePath: string): Promise<void> {
  const queue = readQueue(queuePath);
  const flagged = tasksWithInvalidTags(queue);
  for (const t of flagged) {
    audit('task.tag.invalid', 'dispatcher', { taskId: t.id, invalidTags: t.invalidTags });
    await notify.dm(`⚠️ Task ${t.id} has invalid tags: ${t.invalidTags.map(x => `${x.tag}=${x.raw}`).join(', ')}. Skipping until fixed.`);
  }
}

async function main(): Promise<void> {
  const lock = acquire(config.lockfilePath);
  if (!lock) {
    console.log('[nyx] another dispatcher is running. exit 0.');
    process.exit(0);
  }

  audit('dispatch.tick', 'dispatcher', { pid: process.pid, slot: slotOf() });

  const chain = verifyChain();
  if (!chain.ok) {
    const msg = `audit chain broken at row ${chain.firstBadRowId} (${chain.reason}). refusing to start.`;
    console.error(`[nyx] ${msg}`);
    await notify.dm(`🚨 ${msg}`);
    lock.release();
    process.exit(2);
  }
  audit('dispatch.chain_verified', 'dispatcher', { rows: chain.totalRows });

  await initPlugins();
  await emitHook('tick.before', { slot: slotOf(), pid: process.pid });

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
          const type = String(p.type ?? 'assistant').trim();
          const id = `UI-${Date.now().toString(36).slice(-6).toUpperCase()}`;
          const tags = [`[type: ${type}]`];
          if (p.repo) tags.push(`[repo: ${String(p.repo)}]`);
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
        submitDecision(runId, p.decision as DecisionKind, {
          note: p.note ? String(p.note) : undefined,
          source: 'control',
        });
        return `pipeline ${String(p.decision)} on ${runId}`;
      },
    },
    () => Date.now(),
  );
  if (controlApplied > 0) console.log(`[nyx] control actions applied: ${controlApplied}`);

  if (hasLiveClaude()) {
    audit('task.skipped.concurrent_claude', 'dispatcher', {});
    console.log('[nyx] concurrent claude detected. exit 0.');
    process.exit(0);
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
  // sees a terminal run, and gets marked complete. Dormant in the step-1
  // skeleton (gates auto-approve inline, so no run persists awaiting across
  // ticks); wired now so step-2 real gates resume for free.
  try {
    const resumed = await resumeDecidedRuns();
    if (resumed.length > 0) {
      console.log(`[nyx] pipeline: resumed ${resumed.length} decided run(s)`);
    }
  } catch (err) {
    console.error('[nyx] resumeDecidedRuns threw (unexpected):', (err as Error).message);
  }

  // Within-tick state. Both sets are populated as we go.
  const skippedThisTick = new Set<string>();
  // Audit-derived: tasks that already fired in the current slot's wall-clock
  // window (some prior tick this same slot). Slotted tasks in this set are
  // suppressed so a single slot fires each task at most once.
  const window = slotWindow();
  const firedInSlot = tasksFiredInWindow(window.start, window.end);

  let chainDepth = 0;
  let producedWork = false;

  while (chainDepth < config.maxChainDepth) {
    const queue = readQueue(config.queuePath);
    const next = pickNextTask(queue, { firedInSlot, skipThisTick: skippedThisTick });
    if (!next) {
      if (!producedWork) await maybeIdleOrStaleAlert();
      break;
    }

    // Halt-check runs BEFORE inFlight. If inFlight runs first on a halted task,
    // it sees a working dir whose sentinel PID is dead (the halting process
    // exited) and wipes the dir as "stale_cleared" — destroying the preserved
    // state the operator needs to salvage. Checking halt status first lets us
    // skip without touching the dir at all.
    if (isTaskHalted(next.id)) {
      audit('task.skipped.halt_chain', 'dispatcher', { taskId: next.id });
      skippedThisTick.add(next.id);
      continue;
    }

    // ── Pipeline redirect ──
    // [type: pipeline] tasks route into the stateful orchestrator instead of the
    // single-spawn dispatchOne path. Bypasses inFlight/3-strike: the pipeline_runs
    // table + the resume scan above own continuation across ticks.
    if (next.type === 'pipeline') {
      skippedThisTick.add(next.id);   // one advance per task per tick
      firedInSlot.add(next.id);
      producedWork = true;
      try {
        const result = await handlePipelineInTick(next);
        if (result.markComplete) {
          const run = getRunByTaskId(next.id);
          const durationMs = run ? Date.now() - run.created_at : 0;
          markTaskCompleted(config.queuePath, next.id, { durationMs });
          // Keep task.completed in the audit chain so stale-alert + slot-window
          // bookkeeping treat a delivered pipeline like any completed task.
          audit('task.completed', 'dispatcher', { taskId: next.id, durationMs, type: 'pipeline' });
          console.log(`[nyx] pipeline ${next.id} delivered (${result.status})`);
        } else {
          console.log(`[nyx] pipeline ${next.id} advanced to ${result.status}`);
        }
      } catch (err) {
        const e = err as Error;
        audit('pipeline.failed', 'pipeline', { taskId: next.id, error: e.stack ?? e.message });
        console.error(`[nyx] pipeline ${next.id} threw:`, e.stack ?? e.message);
      }
      chainDepth++;
      if (!config.autoChain) break;
      continue;
    }

    const flightStatus = git.inFlight(next.id);
    if (flightStatus === 'live') {
      audit('task.skipped.in_flight', 'dispatcher', { taskId: next.id });
      skippedThisTick.add(next.id);
      continue;
    }
    if (flightStatus === 'stale_cleared') {
      audit('task.stale_worktree_cleared', 'dispatcher', { taskId: next.id });
      // Fall through to normal dispatch — the ghost dir has been cleaned up.
    }

    const isStanding = next.slot == null && next.everyStepSlots == null;

    // v0.7: 3-strike abandonment is replaced by the audit-on-fail pipeline.
    // Audit cap (MAX_AUDIT_PASSES) inside dispatchOne handles re-attempts;
    // anything that gets past it emits task.halted_for_review which is filtered
    // above. The only legacy path: pre-v0.7 task.failed events accumulated
    // without an audit row. Drain those by treating ≥3 raw failures as halted.
    const failCount = failureCountForTask(next.id);
    if (failCount >= 3) {
      audit('task.halted_for_review', 'dispatcher', {
        taskId: next.id,
        pattern: 'legacy-3-strike',
        operator_report: `Task accumulated ${failCount} failures before v0.7 audit pipeline existed. Inspect the audit history, then \`nyx resume ${next.id}\`.`,
      });
      await notify.taskAbandoned(next.id, `${failCount} prior failures`);
      skippedThisTick.add(next.id);
      continue;
    }

    const outcome = await dispatchOne(next);
    producedWork = true;
    skippedThisTick.add(next.id);   // never re-pick within this tick
    firedInSlot.add(next.id);       // never re-fire within this slot window

    if (outcome.status === 'completed') {
      if (isStanding) {
        markTaskCompleted(config.queuePath, next.id, {
          durationMs: outcome.durationMs,
          ...(outcome.testsPassed != null ? { testsPassed: outcome.testsPassed } : {}),
          ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}),
          ...(outcome.outputPath ? { outputPath: outcome.outputPath } : {}),
        });
      }
      // Slot-bound: queue file is unchanged. Audit log is the only record.
      const mins = Math.max(1, Math.round(outcome.durationMs / 60_000));
      const gateSum = outcome.testsPassed != null ? `${outcome.testsPassed} tests passed` : 'gate ok';
      const fin = outcome.prUrl
        ? `PR: ${outcome.prUrl}`
        : outcome.outputPath
        ? `output: ${outcome.outputPath}`
        : isStanding
        ? 'merged to main'
        : `slot ${slotOf()} fired`;
      audit('task.completed', 'dispatcher', { taskId: next.id, durationMs: outcome.durationMs });
      await notify.taskCompleted(next.id, mins, gateSum, fin);
    } else {
      // Failure path. dispatchOne audits task.failed for setup/claude/gate
      // failures, but finalize-stage failures (e.g. `gh pr create` returned
      // no URL, content task produced no artifacts) only return status:failed
      // without emitting an audit. Backstop here: if the outcome carries a
      // failureLog AND there's no recent task.failed row for this taskId,
      // emit one. Always notify Slack so the operator sees the dead end.
      if (outcome.failureLog) {
        const recentFailAt = lastEventAt('task.failed');
        // If the most recent task.failed is older than this dispatch's start,
        // dispatchOne never emitted one — this is a finalize-stage failure.
        const isFresh = recentFailAt
          ? new Date(recentFailAt).getTime() >= Date.now() - outcome.durationMs - 1000
          : false;
        if (!isFresh) {
          audit('task.failed', 'dispatcher', {
            taskId: next.id,
            stage: 'finalize',
            failure_log: outcome.failureLog,
            durationMs: outcome.durationMs,
          });
          await notify.taskFailed(next.id, 'finalize', outcome.failureLog);
        }
      }
      // v0.6.3: external-clone cleanup on finalize-stage failures.
      // v0.8.x update: ONLY tear down if the audit pipeline did NOT halt the
      // task. When audit halts a task, the operator needs the preserved
      // working dir to inspect the failure state and either fix it in place
      // or understand what diagnostic info the agent had. Cleanup runs
      // unconditionally on nyx-resume (which always wipes the dir).
      //
      // Pre-v0.7 the "every subsequent tick skips it via inFlight()" comment
      // was the worry — but the halt-chain filter in pickNextTask now blocks
      // re-dispatch separately. If the operator never resumes, the dir
      // remains until they intervene; that's the design.
      if (!isTaskHalted(next.id)) {
        const cloneDir = `${config.cloneRootPrefix}${next.id}`;
        if (existsSync(cloneDir)) {
          try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
      // Standing tasks stay [ ] in Active for the next tick to retry. If the
      // audit halted, halt-chain filter in pickNextTask blocks re-dispatch
      // until nyx-resume.
      if (!config.autoChain) break;
    }

    chainDepth++;
    if (!config.autoChain) break;
  }

  if (chainDepth >= config.maxChainDepth) {
    audit('dispatch.chain_limit_reached', 'dispatcher', { depth: chainDepth });
  }

  await emitHook('tick.after', { slot: slotOf(), pid: process.pid });
  lock.release();
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error('[nyx] fatal:', e.stack ?? e.message);
  audit('task.failed', 'dispatcher', { stage: 'top-level', failure_log: e.stack ?? e.message });
  process.exit(1);
});
