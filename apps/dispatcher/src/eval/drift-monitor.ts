/**
 * Drift monitor (G-A, stage EVAL → the Klarna-trap closer).
 *
 * The throughput-green trap: every monitor Nyx runs today measures plumbing
 * (did the gate pass, did it ship) — none of them catch "Nyx got QUIETLY worse"
 * (a model swap, a template edit, MCP degradation that still exits 0). The
 * drift monitor is the one signal that does: it compares the ROLLING 7-day mean
 * quality score per task-type against a trailing BASELINE window, and DMs the
 * operator when the recent mean regresses past a threshold.
 *
 * The threshold math is PURE and lives here (tested directly). The cadence /
 * DB-read / DM wiring lives in the dispatcher tick (maybeDriftCheck), mirroring
 * maybeUpdateCheck — gated by the eval.drift.checked audit event so it runs at
 * most once per interval.
 *
 * Report DELTAS vs a fixed baseline, never absolute scores (the research lesson:
 * absolute pass rates inflate and mislead; the WoW delta is the honest signal).
 */

export interface DriftWindow {
  /** Recent window mean (the rolling 7d) and its sample count. */
  recentMean: number;
  recentCount: number;
  /** The trailing baseline mean it's compared against, and its count. */
  baselineMean: number;
  baselineCount: number;
}

export interface DriftVerdict {
  taskType: string;
  regressed: boolean;
  /** recentMean - baselineMean (negative = quality dropped). */
  delta: number;
  recentMean: number;
  baselineMean: number;
  recentCount: number;
  baselineCount: number;
  /** Why no verdict could be drawn, when regressed is false for a non-quality
   * reason (too few samples to compare). null when a real comparison ran. */
  insufficientReason: string | null;
}

export interface DriftThresholds {
  /** Minimum drop (baseline - recent) that counts as a regression. */
  minDelta: number;
  /** Minimum samples required in EACH window before a verdict is trusted. Too
   * few and one bad run swings the mean — don't cry wolf on n=1. */
  minSamples: number;
}

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
  // A 0.10 (10pp on a 0..1 scale) sustained drop in the rolling mean is the
  // alert floor — conservative enough that ordinary judge noise doesn't trip it,
  // tight enough to catch a real degradation within a week.
  minDelta: 0.1,
  minSamples: 5,
};

function mean(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Decide whether a task-type's recent window regressed vs its baseline. PURE:
 * the caller supplies the two score arrays (recent + baseline) read from
 * eval_scores. A regression requires BOTH windows to have enough samples AND the
 * recent mean to be at least `minDelta` below the baseline mean. Below the
 * sample floor we never flag — an under-powered window is "insufficient", not
 * "regressed".
 */
export function evaluateDrift(
  taskType: string,
  recentScores: number[],
  baselineScores: number[],
  thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS,
): DriftVerdict {
  const recentMean = mean(recentScores);
  const baselineMean = mean(baselineScores);
  const delta = recentMean - baselineMean;

  if (recentScores.length < thresholds.minSamples || baselineScores.length < thresholds.minSamples) {
    return {
      taskType,
      regressed: false,
      delta,
      recentMean,
      baselineMean,
      recentCount: recentScores.length,
      baselineCount: baselineScores.length,
      insufficientReason: `need ≥${thresholds.minSamples} samples per window (recent=${recentScores.length}, baseline=${baselineScores.length})`,
    };
  }

  const drop = baselineMean - recentMean;
  // A tiny epsilon so a drop sitting exactly ON the threshold reliably flags
  // despite IEEE-754 noise in the mean subtraction (e.g. 1 - 0.9 === 0.0999…8,
  // which is microscopically under a 0.1 floor). The eval signal is coarse — a
  // sub-1e-9 wobble must not decide whether the operator gets paged.
  const EPSILON = 1e-9;
  return {
    taskType,
    regressed: drop >= thresholds.minDelta - EPSILON,
    delta,
    recentMean,
    baselineMean,
    recentCount: recentScores.length,
    baselineCount: baselineScores.length,
    insufficientReason: null,
  };
}

/** Human-readable one-liner for the operator DM. Deltas, not absolutes. */
export function formatDriftAlert(v: DriftVerdict): string {
  const pct = (n: number): string => (n * 100).toFixed(1);
  return (
    `⚠️ Quality drift — ${v.taskType}: rolling 7d mean ${pct(v.recentMean)}% ` +
    `vs baseline ${pct(v.baselineMean)}% (Δ ${v.delta >= 0 ? '+' : ''}${pct(v.delta)}pp; ` +
    `n=${v.recentCount}/${v.baselineCount}). Nyx may be getting quietly worse — inspect recent runs.`
  );
}
