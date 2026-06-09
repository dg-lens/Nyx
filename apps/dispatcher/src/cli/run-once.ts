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
  verifyChain,
} from '../audit.js';
import { runAudit, MAX_AUDIT_PASSES } from '../audit-runner.js';
import type { FlightPlan } from '../composer/types.js';
import {
  advancePipeline,
  createPipelineRun,
  failPipelineRun,
  getRunByTaskId,
} from '../pipeline/orchestrator.js';
import { runsAwaitingDecision } from '../pipeline/db.js';
import { isAwaiting, isTerminal, type DecisionKind, type PipelineStatus } from '../pipeline/types.js';
import { buildPrevalidateFailureLog, prevalidateExpects } from '../expects-prevalidate.js';
import { config } from '../config.js';
import { liveOwnClaudeCount } from '../claude-registry.js';
import { emitHook, initPlugins } from '../plugins/index.js';
import { drainPendingActions, insertUnderActiveTasks } from '../control/actions.js';
import { listPending, markApplied, markFailed } from '../control/db.js';
import { invokeDecomposer, type DecomposeIntent } from '../decomposer.js';
import { submitDecision } from '../pipeline/decide.js';
import { isValidRepoTag } from '../pipeline/target.js';
import { acquire } from '../lockfile.js';
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
 * NOTE: per-task Bitwarden secret VALUES are fetched inside `buildSpawnInvocation`
 * and never reach this module, so they are NOT redacted here. Fully closing that
 * surface requires `invokeClaude` to return its injected `extraEnv` so the values
 * can be added to this denylist — a task-runner change tracked separately.
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
  return out;
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
    const failureLog = redactClaudeOutput(
      `claude exit ${claudeResult.exitCode}\nstderr:\n${claudeResult.stderr}\nstdout-tail:\n${claudeResult.stdout.slice(-2000)}`,
    );
    audit('task.failed', 'dispatcher', { taskId: task.id, stage: 'claude', failure_log: failureLog });
    await notify.claudeCrashed(task.id, claudeResult.exitCode, redactClaudeOutput(claudeResult.stderr));
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
    handled.add(run.task_id);
    try {
      await advancePipeline(run);
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

  // Decompose any pending decompose_task actions (a natural-language request ->
  // fully-tagged tasks via a sonnet claude -p call) before the generic drain,
  // so the resulting tasks land under ## Active Tasks this same tick. Each is
  // marked applied/failed here, so drainPendingActions (status='pending') skips
  // them.
  const decomposedThisTick = await processDecomposeActions();

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
          if (p.repo) {
            // Security (C2): a control-action repo string flows verbatim into the
            // queued `[repo:]` tag and, later, into `git clone`. Reject anything
            // that isn't an `owner/name` repo or greenfield keyword here, at the
            // control-plane boundary, rather than relying solely on the task-reader
            // backstop — a malicious/relayed producer must not reach the clone.
            const repo = String(p.repo);
            if (!isValidRepoTag(repo)) {
              throw new Error(
                `queue_task: invalid [repo:] value ${JSON.stringify(repo)} — ` +
                  `must be "owner/name" or a greenfield keyword (local|new|greenfield|scratch)`,
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

  const guard = config.settings.dispatcher.concurrencyGuard;
  if (guard !== 'off') {
    const busy = guard === 'own' ? liveOwnClaudeCount() > 0 : hasLiveClaude();
    if (busy) {
      audit('task.skipped.concurrent_claude', 'dispatcher', { mode: guard });
      console.log(`[nyx] concurrent claude detected (${guard}). exit 0.`);
      process.exit(0);
    }
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

  let chainDepth = 0;
  let producedWork = false;

  // A tick that decomposed an NL request does NOT also execute the resulting
  // tasks — decompose means "queue for review". They run on a later tick (the
  // 5-min daemon, or a manual `nyx tick` / the desktop Tick button).
  if (decomposedThisTick > 0) {
    console.log(`[nyx] decomposed ${decomposedThisTick} request(s); tasks queued — they run on the next tick.`);
  }

  while (decomposedThisTick === 0 && chainDepth < config.maxChainDepth) {
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
        const result = await handlePipelineInTick(next, resumedTaskIds);
        if (result.markComplete) {
          const run = getRunByTaskId(next.id);
          const durationMs = run ? Date.now() - run.created_at : 0;
          // A failed/aborted terminal run is marked with the [FAILED] flag so the
          // picker (baseFilter excludes [FAILED]) stops re-selecting it every tick;
          // a done run is marked cleanly.
          markTaskCompleted(config.queuePath, next.id, { durationMs, ...(result.failed ? { failed: true } : {}) });
          // Keep task.completed in the audit chain so stale-alert + slot-window
          // bookkeeping treat a delivered pipeline like any completed task. A
          // failed/aborted run also emits a task.failed row so the operator and
          // stale-alert bookkeeping see the terminal failure.
          if (result.failed) {
            audit('task.failed', 'dispatcher', { taskId: next.id, stage: 'pipeline', failure_log: `pipeline run terminated: ${result.status}` });
          } else {
            audit('task.completed', 'dispatcher', { taskId: next.id, durationMs, type: 'pipeline' });
          }
          console.log(`[nyx] pipeline ${next.id} reconciled (${result.status})`);
        } else {
          console.log(`[nyx] pipeline ${next.id} advanced to ${result.status}`);
        }
      } catch (err) {
        const e = err as Error;
        await failPipelineWithNotice(next.id, e);
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
        : `slot ${slotOf()} (${slotToTime(slotOf())}) fired`;
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

  await maybeUpdateCheck();

  await emitHook('tick.after', { slot: slotOf(), pid: process.pid });
  lock.release();
}

main().catch((err: unknown) => {
  const e = err as Error;
  console.error('[nyx] fatal:', e.stack ?? e.message);
  audit('task.failed', 'dispatcher', { stage: 'top-level', failure_log: e.stack ?? e.message });
  process.exit(1);
});
