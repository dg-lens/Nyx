/**
 * Run-tree projection over the flat audit chain (G-A, stage TRACE).
 *
 * The hash chain is a flat, append-only event log: every `task.*` / `pipeline.*`
 * row carries a `taskId` (and pipeline rows a `runId`) in its payload, but the
 * causal structure — "these N events belong to ONE run, in this order, and the
 * run ended fixed/failed/halted" — is implicit. Evaluation needs the structure,
 * not the firehose: you cannot score "was this outcome good" without first
 * grouping the events into the run they describe. This module is the projection
 * that recovers that tree. It is PURE: it takes audit rows in and returns the
 * grouped trees out, so it is trivially testable and never touches the DB (the
 * caller hands it `readAuditRowsSince(...)`).
 *
 * Bridge-don't-merge: this does NOT replace the chain or write anything. It is a
 * read-only lens. The correlation id is the `taskId` already minted once at
 * dispatch (the convergent practice in the research: promote the id you already
 * have rather than invent a parallel trace_id).
 */
import type { AuditRow } from '../audit.js';

/** The terminal disposition of a run, derived from its last lifecycle event. */
export type RunOutcomeKind = 'completed' | 'failed' | 'halted' | 'abandoned' | 'in-progress';

export interface RunEvent {
  id: number;
  at: string;
  event: string;
  actor: string;
  payload: Record<string, unknown>;
}

export interface RunTree {
  /** The correlation id — `taskId` for single-spawn tasks, the pipeline `runId`
   * grouped under its driving task for pipeline runs. */
  correlationId: string;
  /** True when this tree was assembled from `pipeline.*` events (a multi-phase
   * run) vs a single-spawn task. Pipeline runs get 100%-sampled when flagged. */
  isPipeline: boolean;
  events: RunEvent[];
  /** Derived from the last lifecycle event in the run. */
  outcome: RunOutcomeKind;
  startedAt: string;
  endedAt: string;
  /** True when the run hit ANY of the flagged signals (halt, failure, audit
   * routing, stall, exit-124). Flagged runs are 100%-sampled by the online eval —
   * the Klarna-trap closer samples clean runs but NEVER skips a known-bad one. */
  flagged: boolean;
  /** Total estimated cost folded from any `task.usage.metered` rows in the run
   * (null when none were metered — Max-plan OAuth or metering off). */
  estimatedCostUsd: number | null;
  /** The task TYPE (code/analysis/assistant/content/pipeline) when an event
   * carried it; drift baselines are computed per task-type. */
  taskType: string | null;
}

/** Events whose presence marks a run as flagged (already-known-bad → always score). */
const FLAGGED_EVENTS = new Set<string>([
  'task.halted_for_review',
  'task.audit.started',
  'task.audit.escalated',
  'task.claude.stalled',
  'task.ambiguity.escalated',
  'task.expects.failed',
  'task.doc_sweep.failed',
  'pipeline.failed',
  'pipeline.diagnostic.fix.rejected',
]);

/** Events that close a run, mapped to the outcome they imply. Order matters only
 * in that the LAST such event in id order wins (a run that failed then was
 * resumed+completed ends `completed`). */
const TERMINAL_OUTCOME: Record<string, RunOutcomeKind> = {
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.abandoned': 'abandoned',
  'task.halted_for_review': 'halted',
  'pipeline.delivered': 'completed',
  'pipeline.failed': 'failed',
  'pipeline.aborted': 'abandoned',
};

function asRecord(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
  if (typeof payload === 'string') {
    try {
      const p = JSON.parse(payload);
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Pull the correlation id out of a row's payload. Pipeline rows key on `runId`;
 * everything else on `taskId`. A pipeline run is driven by a standing task, so
 * the same physical run can surface under both ids across its lifetime — we key
 * pipeline events on `runId` (stable across phases) and task events on `taskId`,
 * and a pipeline run's driving `taskId` events are folded in by the `runId`
 * carried in the pipeline rows. Returns null for rows that belong to no run
 * (e.g. `dispatch.tick`).
 */
function correlationIdOf(event: string, payload: Record<string, unknown>): { id: string; isPipeline: boolean } | null {
  if (event.startsWith('pipeline.')) {
    const runId = payload['runId'];
    if (typeof runId === 'string' && runId) return { id: runId, isPipeline: true };
    // A pipeline row without a runId can't be grouped — skip it rather than
    // misattribute it to a task tree.
    return null;
  }
  const taskId = payload['taskId'];
  if (typeof taskId === 'string' && taskId) return { id: taskId, isPipeline: false };
  return null;
}

/**
 * Project a flat slice of audit rows into per-run trees, keyed by correlation
 * id. Rows are expected ascending by id (the chain order). Each tree's events
 * preserve that order, so `outcome` is the last terminal event seen and the
 * start/end timestamps bracket the run. Rows that carry no correlation id are
 * dropped (system-level ticks, idle markers — not part of any run).
 */
export function projectRunTrees(rows: AuditRow[]): RunTree[] {
  const byId = new Map<string, RunTree>();

  for (const row of rows) {
    const payload = asRecord(row.payload);
    const corr = correlationIdOf(row.event, payload);
    if (!corr) continue;

    let tree = byId.get(corr.id);
    if (!tree) {
      tree = {
        correlationId: corr.id,
        isPipeline: corr.isPipeline,
        events: [],
        outcome: 'in-progress',
        startedAt: row.at,
        endedAt: row.at,
        flagged: false,
        estimatedCostUsd: null,
        taskType: null,
      };
      byId.set(corr.id, tree);
    }
    // A run keyed by runId stays a pipeline run even if a later task-keyed row
    // (impossible by keying, but defensive) flips through — once pipeline, always.
    tree.isPipeline = tree.isPipeline || corr.isPipeline;

    tree.events.push({ id: row.id, at: row.at, event: row.event, actor: row.actor, payload });
    tree.endedAt = row.at;

    if (FLAGGED_EVENTS.has(row.event)) tree.flagged = true;

    const terminal = TERMINAL_OUTCOME[row.event];
    if (terminal) tree.outcome = terminal;

    if (row.event === 'task.usage.metered') {
      const cost = payload['estimated_cost_usd'];
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        tree.estimatedCostUsd = (tree.estimatedCostUsd ?? 0) + cost;
      }
    }

    if (tree.taskType == null) {
      const t = payload['type'];
      if (typeof t === 'string' && t) tree.taskType = t;
    }
  }

  // A pipeline run that delivered without a `type` field in any payload is still
  // a pipeline run for baseline grouping.
  for (const tree of byId.values()) {
    if (tree.taskType == null && tree.isPipeline) tree.taskType = 'pipeline';
  }

  return [...byId.values()];
}

/** Convenience: only the runs that reached a terminal outcome (the eval/drift
 * layers score completed runs; in-progress ones are scored on a later cadence). */
export function terminalRuns(trees: RunTree[]): RunTree[] {
  return trees.filter((t) => t.outcome !== 'in-progress');
}
