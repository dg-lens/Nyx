/**
 * The type-aware two-class scheduler core (Track 3), extracted from the tick so
 * its concurrency behavior is unit-testable with injected fakes.
 *
 * Contract, restated:
 *   - ISO-class tasks (analysis/assistant/content) fan out CONCURRENTLY up to
 *     `effectiveIsoCap` and are all drained before the tick returns (ISO
 *     concurrency is strictly intra-tick).
 *   - At most ONE GIT-class task (code/pipeline) runs, SYNCHRONOUSLY, under the
 *     git single-flight lock. It NEVER blocks ISO launches — ISO is launched
 *     first, non-blocking, so the quick digests run while the long build blocks.
 *     (This overlap is WITHIN the tick; cross-tick overlap is intentionally not
 *     achieved — the shell lock serializes tick processes. See git-task-lock.ts.)
 *   - A GIT task is suppressed if the git lock is already held in a live pid, or
 *     a pipeline phase already took the GIT slot this tick (gitSlotTaken).
 *   - A 429/overload on any spawn opens a global cooldown and leaves the task
 *     queued (NOT failed). The cooldown is checked BEFORE any spawn.
 *   - One ISO task crashing must not abort its siblings (Promise.allSettled).
 *   - Completion bookkeeping runs SEQUENTIALLY after the drain (the queue file is
 *     read-modify-written; concurrent writes would race).
 *
 * The host wires the real implementations in `cli/run-once.ts`; tests inject
 * fakes with a controllable per-task latency to assert peak concurrency, cap
 * enforcement, GIT-doesn't-block-ISO, and crash isolation.
 */
import type { ParsedTask, RunOutcome } from './types.js';
import { classOf } from './concurrency.js';

export interface SchedulerDeps {
  /** Pick the next dispatchable task of a class, or null. Re-read each call. */
  pickNext: (classFilter: 'git' | 'iso') => ParsedTask | null;
  /** Shared pre-dispatch gates (halt/inFlight/legacy-3-strike). false = skip. */
  prepareSingleSpawn: (task: ParsedTask) => Promise<boolean>;
  /** Mark a task scheduled so it isn't re-picked this tick. */
  markScheduled: (task: ParsedTask) => void;
  /** Run one task to its RunOutcome (the real dispatchOne). */
  dispatch: (task: ParsedTask) => Promise<RunOutcome>;
  /** Advance one pipeline task this tick (its own reconcile + audit). */
  advancePipeline: (task: ParsedTask) => Promise<void>;
  /** Apply completion/failure bookkeeping for a finished single-spawn task. */
  applyOutcome: (task: ParsedTask, outcome: RunOutcome) => Promise<void>;
  /** Open the global rate-limit cooldown after a 429/overload outcome. */
  openCooldown: (taskId: string, retryAfterMs?: number) => void;
  /** The effective ISO cap right now (folds the global ceiling + live coders). */
  effectiveIsoCap: () => number;
  /** True iff a GIT task is already mid-flight in a live dispatcher pid. */
  liveGitTaskExists: () => boolean;
  writeGitLock: (taskId: string) => void;
  removeGitLock: () => void;
  /** Per-launch jitter in ms (0 disables); awaited between ISO launches. */
  isoLaunchJitterMs: number;
  /** Audit a drained-pool marker + an unexpected ISO-drain throw. */
  auditPoolDrained: (count: number) => void;
  auditIsoThrow: (reason: string) => void;
  /** Optional injection point for the jitter sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface SchedulerResult {
  isoLaunched: number;
  gitTasksRun: number;
  producedWork: boolean;
  /** Peak number of ISO tasks in flight simultaneously — for assertions. */
  peakIso: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run one tick's worth of scheduling. `gitSlotTaken` is true when a resumed
 * pipeline phase earlier in the tick already consumed the GIT slot.
 */
export async function runTwoClassTick(
  deps: SchedulerDeps,
  opts: { gitSlotTaken: boolean },
): Promise<SchedulerResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? (() => {});
  const inFlightIso = new Map<string, Promise<{ task: ParsedTask; outcome: RunOutcome }>>();
  let isoLaunched = 0;
  let gitTasksRun = 0;
  let producedWork = false;
  let gitLaunched = opts.gitSlotTaken;

  // Peak concurrency tracker: a live counter incremented at launch and
  // decremented when a promise settles. Robust to a settle landing during a
  // jitter sleep (Phase A awaits between launches), so the assertion that
  // peakIso never exceeds the cap is honest even under interleaving.
  let liveIso = 0;
  let peakIso = 0;

  // ── Phase A — fill the ISO pool (non-blocking, jittered) ──
  while (inFlightIso.size < deps.effectiveIsoCap()) {
    const iso = deps.pickNext('iso');
    if (!iso) break;
    if (!(await deps.prepareSingleSpawn(iso))) continue;
    deps.markScheduled(iso);
    producedWork = true;
    if (isoLaunched > 0 && deps.isoLaunchJitterMs > 0) {
      await sleep(Math.floor(Math.random() * deps.isoLaunchJitterMs));
    }
    isoLaunched++;
    liveIso++;
    peakIso = Math.max(peakIso, liveIso);
    const p = deps.dispatch(iso).then((outcome) => {
      liveIso--;
      return { task: iso, outcome };
    });
    inFlightIso.set(iso.id, p);
  }

  // ── Phase B — launch at most ONE GIT task, synchronously, under the lock ──
  if (!gitLaunched && !deps.liveGitTaskExists()) {
    const gitT = deps.pickNext('git');
    if (gitT) {
      gitLaunched = true;
      producedWork = true;
      if (gitT.type === 'pipeline') {
        deps.markScheduled(gitT);
        deps.writeGitLock(gitT.id);
        try {
          await deps.advancePipeline(gitT);
          gitTasksRun++;
        } finally {
          deps.removeGitLock();
        }
      } else if (await deps.prepareSingleSpawn(gitT)) {
        deps.markScheduled(gitT);
        deps.writeGitLock(gitT.id);
        let outcome: RunOutcome;
        try {
          outcome = await deps.dispatch(gitT);
        } finally {
          deps.removeGitLock();
        }
        if (outcome.status === 'rate-limited') {
          deps.openCooldown(gitT.id, outcome.retryAfterMs);
          log(`GIT task ${gitT.id} rate-limited — left queued, cooldown opened.`);
        } else {
          gitTasksRun++;
          await deps.applyOutcome(gitT, outcome);
        }
      }
    }
  }

  // ── Phase C — drain the ISO pool; apply outcomes SEQUENTIALLY ──
  if (inFlightIso.size > 0) {
    const settled = await Promise.allSettled([...inFlightIso.values()]);
    deps.auditPoolDrained(inFlightIso.size);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        const { task, outcome } = s.value;
        if (outcome.status === 'rate-limited') {
          deps.openCooldown(task.id, outcome.retryAfterMs);
          log(`ISO task ${task.id} rate-limited — left queued, cooldown opened.`);
        } else {
          await deps.applyOutcome(task, outcome);
        }
      } else {
        const reason = (s.reason as Error)?.stack ?? String(s.reason);
        log(`ISO task threw (unexpected): ${reason}`);
        deps.auditIsoThrow(reason);
      }
    }
  }

  return { isoLaunched, gitTasksRun, producedWork, peakIso };
}

/** Re-exported for callers that want the class split at the scheduler boundary. */
export { classOf };
