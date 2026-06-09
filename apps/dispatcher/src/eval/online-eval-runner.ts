/**
 * Online-eval + drift orchestration (G-A, the standing [every:]-style check).
 *
 * This is the IMPURE glue that the dispatcher tick calls on a cadence: read the
 * recent run trees off the chain, sample which to score, spawn the judge for
 * each, persist the scores off-chain, then run the drift comparison and DM on
 * regression. Every pure decision (projection, sampling, drift math, parsing)
 * lives in its sibling modules and is unit-tested there; this file only wires
 * them to the DB + spawn + notifier, mirroring maybeUpdateCheck's role.
 *
 * Cadence-gated by the eval.online.sampled / eval.drift.checked audit events so
 * it runs at most once per interval — the same dedup pattern as the daily update
 * check. OFF the hot path by construction: it runs at the TAIL of the tick, after
 * all task dispatch, and a judge crash/timeout is non-fatal (logged + skipped).
 *
 * The whole thing is a no-op unless settings.evaluation.enabled is true, so the
 * foundation ships dark and the operator opts in.
 */
import { audit, lastEventAt, readAuditRowsSince } from '../audit.js';
import { config } from '../config.js';
import * as notify from '../notifier.js';
import { saveEvalScore, scoredCorrelationIds, scoresInWindow } from './db.js';
import { evaluateDrift, formatDriftAlert } from './drift-monitor.js';
import { selectRunsToScore, spawnJudge } from './online-eval.js';
import { projectRunTrees, terminalRuns, type RunTree } from './run-tree.js';

// Score recently-terminal runs at most once per this window. The 5-min tick fires
// often; scoring every tick would re-walk the same runs. One pass/hour keeps the
// judge volume low while staying fresh enough for a 7-day drift signal.
const EVAL_SAMPLE_INTERVAL_MS = 60 * 60_000;
// Run the drift comparison daily — a rolling-7d-vs-baseline signal doesn't move
// minute to minute, and a daily DM cadence matches the WISDOM-AUDIT shape.
const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
// Judge spawn budget — cheap model, single turn, no tools. Generous enough for a
// haiku round-trip, tight enough that a wedged judge can't stall the tick tail.
const JUDGE_TIMEOUT_MS = 90_000;

// Rolling window for the recent quality mean, and the trailing baseline it's
// compared against (the prior 7 days before the recent window).
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60_000;
// Look back this far when projecting run trees for sampling — bounds the chain
// scan so the sampler doesn't re-read all history every cadence.
const SAMPLE_LOOKBACK_MS = 2 * 60 * 60_000;

interface EvalDeps {
  now: number;
  /** Injected in tests so the judge isn't actually spawned. */
  judge?: (run: RunTree) => Promise<{ score: number; rationale: string | null } | null>;
}

/**
 * Tail-of-tick entry point. Returns silently when evaluation is disabled.
 * Composes the sample pass and the drift pass, each independently cadence-gated.
 */
export async function runEvalLoop(deps: EvalDeps = { now: Date.now() }): Promise<void> {
  if (!config.settings.evaluation.enabled) return;
  await runSamplePass(deps);
  await runDriftPass(deps);
}

async function runSamplePass(deps: EvalDeps): Promise<void> {
  const last = lastEventAt('eval.online.sampled');
  if (last && deps.now - new Date(last).getTime() < EVAL_SAMPLE_INTERVAL_MS) return;

  const sinceIso = new Date(deps.now - SAMPLE_LOOKBACK_MS).toISOString();
  const trees = terminalRuns(projectRunTrees(readAuditRowsSince(sinceIso)));
  const alreadyScored = scoredCorrelationIds(new Date(deps.now - RECENT_WINDOW_MS - BASELINE_WINDOW_MS).toISOString());
  const selected = selectRunsToScore(trees, config.settings.evaluation.sampleRate, alreadyScored);

  audit('eval.online.sampled', 'dispatcher', { candidates: trees.length, selected: selected.length });
  if (selected.length === 0) return;

  const judge =
    deps.judge ??
    ((run: RunTree) =>
      spawnJudge(run, {
        model: config.settings.evaluation.judgeModel,
        timeoutMs: JUDGE_TIMEOUT_MS,
        env: process.env,
      }));

  let scored = 0;
  for (const { run, reason } of selected) {
    let verdict: { score: number; rationale: string | null } | null;
    try {
      verdict = await judge(run);
    } catch {
      // A judge spawn must never throw into the tick tail.
      verdict = null;
    }
    if (!verdict) {
      audit('eval.online.skipped', 'dispatcher', { correlationId: run.correlationId, reason: 'judge-unavailable' });
      continue;
    }
    saveEvalScore({
      correlationId: run.correlationId,
      taskType: run.taskType ?? 'unknown',
      score: verdict.score,
      reason,
      judgeModel: config.settings.evaluation.judgeModel,
      rationale: verdict.rationale,
    });
    audit('eval.online.scored', 'dispatcher', {
      correlationId: run.correlationId,
      taskType: run.taskType ?? 'unknown',
      score: verdict.score,
      reason,
    });
    scored++;
  }
  if (scored > 0) console.log(`[nyx] online-eval: scored ${scored}/${selected.length} run(s)`);
}

async function runDriftPass(deps: EvalDeps): Promise<void> {
  const last = lastEventAt('eval.drift.checked');
  if (last && deps.now - new Date(last).getTime() < DRIFT_CHECK_INTERVAL_MS) return;

  const recentStart = new Date(deps.now - RECENT_WINDOW_MS).toISOString();
  const nowIso = new Date(deps.now).toISOString();
  const baselineStart = new Date(deps.now - RECENT_WINDOW_MS - BASELINE_WINDOW_MS).toISOString();

  // Discover which task types have scores in either window — drift is per-type.
  const recentRows = readAuditRowsSince(recentStart);
  const types = new Set<string>();
  for (const row of recentRows) {
    if (row.event !== 'eval.online.scored') continue;
    const p = typeof row.payload === 'string' ? safeParse(row.payload) : (row.payload as Record<string, unknown>);
    const t = p?.['taskType'];
    if (typeof t === 'string' && t) types.add(t);
  }

  let regressions = 0;
  for (const taskType of types) {
    const recent = scoresInWindow(taskType, recentStart, nowIso);
    const baseline = scoresInWindow(taskType, baselineStart, recentStart);
    const verdict = evaluateDrift(taskType, recent, baseline);
    if (verdict.regressed) {
      regressions++;
      audit('eval.drift.regressed', 'dispatcher', {
        taskType,
        delta: verdict.delta,
        recentMean: verdict.recentMean,
        baselineMean: verdict.baselineMean,
        recentCount: verdict.recentCount,
        baselineCount: verdict.baselineCount,
      });
      await notify.dm(formatDriftAlert(verdict));
    }
  }
  audit('eval.drift.checked', 'dispatcher', { types: types.size, regressions });
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(s);
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
