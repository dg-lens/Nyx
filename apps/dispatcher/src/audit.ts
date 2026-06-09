import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';
import { openDb } from './db.js';

export type AuditEvent =
  | 'dispatch.tick'
  | 'dispatch.idle'
  | 'dispatch.stale'
  | 'dispatch.chain_limit_reached'
  | 'dispatch.chain_verified'
  | 'dispatch.update_check'
  | 'dispatch.update_available'
  | 'task.started'
  | 'task.claude.exited'
  // Per-spawn cost/token metering off `claude -p --output-format json` (G-B/P1)
  | 'task.usage.metered'
  // Loop-detector: spawn killed by the stdout-silence watchdog, not wall-clock
  | 'task.claude.stalled'
  | 'task.gate.completed'
  | 'task.committed'
  | 'task.merged'
  | 'task.output.written'
  | 'task.pr.created'
  | 'task.pushed'
  | 'task.production.deploy_required'
  | 'task.completed'
  | 'task.failed'
  | 'task.failure_reset'
  | 'task.rollback'
  | 'task.abandoned'
  | 'task.stale_worktree_cleared'
  | 'task.skipped.in_flight'
  | 'task.skipped.depends_unmet'
  | 'task.skipped.concurrent_claude'
  | 'task.skipped.halt_chain'
  // Type-aware concurrency (Track 3): a GIT task is skipped this tick because
  // another GIT task is mid-flight; the ISO pool / global ceiling is full; or a
  // 429/overload cooldown is active. None of these is a failure.
  | 'task.skipped.git_busy'
  | 'task.skipped.iso_cap'
  | 'task.skipped.rate_limited'
  | 'dispatch.rate_limited'
  | 'dispatch.iso_pool.drained'
  | 'task.tag.invalid'
  | 'task.preflight.failed'
  | 'task.reading_tag.absent'
  | 'task.expects.failed'
  | 'task.expects.prevalidate.failed'
  | 'task.clone.basebranch.assertion_failed'
  | 'task.audit.started'
  | 'task.audit.classified'
  | 'task.audit.autofix.applied'
  | 'task.audit.autofix.succeeded'
  | 'task.audit.autofix.failed'
  | 'task.audit.escalated'
  | 'task.halted_for_review'
  | 'task.resumed'
  | 'task.cancelled'
  | 'assistant.morning_brief'
  | 'assistant.reminder'
  | 'assistant.slack_digest'
  | 'assistant.rotation_check.run'
  | 'assistant.rotation_check.clear'
  | 'analyzer.clone.started'
  | 'analyzer.scan.completed'
  | 'analyzer.pr.created'
  | 'bitwarden.project.registered'
  | 'bitwarden.project.created'
  | 'bitwarden.secret.rotation_logged'
  | 'bitwarden.secret.rotation_updated'
  | 'bitwarden.token.missing'
  | 'inbox.rotation.ingested'
  | 'inbox.rotation.malformed'
  // Ambiguity escalation: agent wrote .nyx/ambiguity.json and exited 0
  | 'task.ambiguity.escalated'
  // Wisdom capture: second claude -p spawn after main task exits 0, before gate
  | 'task.wisdom.captured'
  | 'task.wisdom.skipped'
  // Doc-sweep verifier (finalize-time check that declared doc updates were applied)
  | 'task.doc_sweep.passed'
  | 'task.doc_sweep.failed'
  // Gate-trust (finding G-C): the agent-authored diff touched gate-controlling
  // test-infra files (conftest.py, jest/vitest config, CI workflow, package.json
  // scripts). Flag-for-review only — does NOT fail the task.
  | 'task.gate.test_infra_touched'
  // ── Content-level verifiers + lint gate (P7) ──
  // Pinned-version diff-scoped lint (the long-pending CORTANA-GATE-LINT). HARD
  // signal: a lint failure on the agent's own diff fails the task into audit.
  | 'task.lint.passed'
  | 'task.lint.failed'
  | 'task.lint.skipped'
  // Flaky-test quarantine: the tests stage flipped verdict on the identical tree.
  // The dispatcher halts (quarantine) rather than retrying to green.
  | 'task.gate.flaky_quarantined'
  // Rotten-green: a changed test file asserts nothing / is skip-only / discards
  // its result into a blank-identifier sink. Flag-for-review only (advisory).
  | 'task.test_oracle.rotten_green'
  // Content-judge: an independent haiku read-only spawn scored the diff against
  // the task's acceptance criteria. captured = a verdict was produced; concern =
  // a high-confidence FAIL flagged for review; skipped = non-fatal no-op.
  | 'task.judge.captured'
  | 'task.judge.concern'
  | 'task.judge.skipped'
  // Composer layer (stage 0 — observation only). See apps/dispatcher/src/composer/CLAUDE.md
  | 'task.flight_plan.spawned'
  | 'task.flight_plan.submitted'
  | 'task.flight_plan.missing'
  | 'task.flight_plan.invalid_json'
  | 'task.flight_plan.spawn_failed'
  | 'composer.run.spawned'
  | 'composer.run.completed'
  | 'composer.skipped'
  // Trace→eval→lesson loop FOUNDATION (G-A). Evaluation is a SEPARATE control
  // plane ON TOP of the trace: the audit chain records WHAT happened, these
  // events record that a run was JUDGED (and the drift verdict over time). The
  // eval SCORE itself is NOT hash-chained — it lives in the eval_scores table
  // (like composer_findings), so a re-score never perturbs the ledger. These
  // events are the append-only lifecycle markers around that off-chain scoring.
  | 'eval.online.sampled'
  | 'eval.online.scored'
  | 'eval.online.skipped'
  | 'eval.drift.checked'
  | 'eval.drift.regressed'
  // Pipeline orchestrator (`[type: pipeline]`). Append-only lifecycle record;
  // mutable run state lives in the pipeline_runs table. See
  // moc-nyx-pipeline (Arachne) + apps/dispatcher/src/pipeline/.
  | 'pipeline.run.started'
  | 'pipeline.rejected'
  | 'pipeline.decision.submitted'
  | 'pipeline.stage.advanced'
  | 'pipeline.preview.delivered'
  | 'pipeline.preview.revised'
  | 'pipeline.preview.approved'
  | 'pipeline.executing.started'
  | 'pipeline.coder.started'
  | 'pipeline.coder.finished'
  | 'pipeline.redux.complete'
  | 'pipeline.diagnostic.started'
  | 'pipeline.diagnostic.finished'
  | 'pipeline.diagnostic.fix.verified'
  | 'pipeline.diagnostic.fix.rejected'
  | 'pipeline.deps.installed'
  | 'pipeline.smoke.invalidated'
  | 'pipeline.smoke.completed'
  | 'pipeline.review.delivered'
  | 'pipeline.review.proceed'
  | 'pipeline.review.accept'
  | 'pipeline.review.fix'
  | 'pipeline.review.rollback'
  | 'pipeline.short_circuit'
  | 'pipeline.aborted'
  | 'pipeline.delivered'
  | 'pipeline.failed'
  | 'plugin.loaded'
  | 'plugin.skipped'
  | 'plugin.hook.error'
  | 'plugin.io.error'
  | 'control.action.applied'
  | 'control.action.failed'
  | 'control.decompose.applied'
  | 'control.decompose.failed';

export interface AuditRow {
  id: number;
  at: string;
  event: AuditEvent;
  actor: string;
  payload: unknown;
  row_hash: string;
  prev_hash: string;
}

const GENESIS_HASH = '0'.repeat(64);

let db: DatabaseSync | null = null;
let insertStmt: StatementSync | null = null;
let lastHashStmt: StatementSync | null = null;
let failCountStmt: StatementSync | null = null;
let lastSuccessStmt: StatementSync | null = null;
let lastEventStmt: StatementSync | null = null;
let completedInWindowStmt: StatementSync | null = null;
let firedInWindowStmt: StatementSync | null = null;

/**
 * Test hook. Swap the audit DB for an in-memory instance so tests can call
 * audit() without touching the real nyx.db (which may be locked by a
 * live sync daemon). Pass null to clear; subsequent calls will lazy-open
 * the real DB again. Production code never calls this.
 */
export function _setAuditDb(newDb: DatabaseSync | null): void {
  db = newDb;
  insertStmt = null;
  lastHashStmt = null;
  failCountStmt = null;
  lastSuccessStmt = null;
  lastEventStmt = null;
  completedInWindowStmt = null;
  firedInWindowStmt = null;
}

function open(): DatabaseSync {
  if (db && insertStmt) return db;
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = openDb(config.dbPath);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_audit (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      row_hash  TEXT    NOT NULL,
      prev_hash TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_system_audit_event ON system_audit(event);
    CREATE INDEX IF NOT EXISTS idx_system_audit_at    ON system_audit(at);
    CREATE TABLE IF NOT EXISTS system_audit_chainpoint (
      id        INTEGER PRIMARY KEY CHECK (id = 0),
      last_id   INTEGER NOT NULL,
      last_hash TEXT    NOT NULL
    );
  `);
  // last_full_at records the wall-clock of the most recent full fromGenesis
  // walk, so the per-tick path can force one daily (M11 — a tampered checkpoint
  // can't hide a sub-checkpoint chain break from a periodic full re-hash).
  // Idempotent: ALTER throws if the column already exists, which is the steady
  // state, so swallow it.
  try {
    db.exec(`ALTER TABLE system_audit_chainpoint ADD COLUMN last_full_at TEXT`);
  } catch {
    /* column already present */
  }
  insertStmt = db.prepare(
    `INSERT INTO system_audit (at, event, actor, payload, row_hash, prev_hash) VALUES (?, ?, ?, ?, ?, ?)`
  );
  lastHashStmt = db.prepare(`SELECT row_hash FROM system_audit ORDER BY id DESC LIMIT 1`);
  failCountStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.failed' AND json_extract(payload, '$.taskId') = ?`
  );
  lastSuccessStmt = db.prepare(`SELECT at FROM system_audit WHERE event = 'task.completed' ORDER BY id DESC LIMIT 1`);
  lastEventStmt = db.prepare(`SELECT at FROM system_audit WHERE event = ? ORDER BY id DESC LIMIT 1`);
  completedInWindowStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM system_audit
     WHERE event = 'task.completed'
       AND json_extract(payload, '$.taskId') = ?
       AND at >= ? AND at < ?`
  );
  firedInWindowStmt = db.prepare(
    `SELECT DISTINCT json_extract(payload, '$.taskId') AS taskId FROM system_audit
     WHERE event IN ('task.completed', 'task.failed')
       AND at >= ? AND at < ?
       AND json_extract(payload, '$.taskId') IS NOT NULL`
  );
  return db;
}

function hashRow(at: string, event: string, actor: string, payload: string, prevHash: string): string {
  return createHash('sha256')
    .update(`${at}\n${event}\n${actor}\n${payload}\n${prevHash}`)
    .digest('hex');
}

/**
 * Append an audit row inside an IMMEDIATE transaction so the prev_hash read
 * and the row insert are atomic against any concurrent writer (including a
 * second dispatcher process that escaped the lockfile, or future tooling).
 */
export function audit(event: AuditEvent, actor: string, payload: Record<string, unknown> = {}): void {
  const d = open();
  const at = new Date().toISOString();
  const payloadJson = JSON.stringify(payload);
  d.exec('BEGIN IMMEDIATE');
  try {
    const prevRow = lastHashStmt!.get() as { row_hash: string } | undefined;
    const prev = prevRow?.row_hash ?? GENESIS_HASH;
    const rowHash = hashRow(at, event, actor, payloadJson, prev);
    insertStmt!.run(at, event, actor, payloadJson, rowHash, prev);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Effective failure count for a task — counts only `task.failed` events
 * AFTER the most recent `task.failure_reset` event for the same taskId.
 *
 * The hash chain is append-only, so we don't delete past failures. Instead,
 * an operator (or automation) emits a `task.failure_reset` event when a
 * task's failure mode has been remediated; everything before that timestamp
 * stops counting toward the 3-strike abandon limit. Audit history stays intact.
 */
export function failureCountForTask(taskId: string): number {
  const d = open();
  const reset = d
    .prepare(
      `SELECT at FROM system_audit
       WHERE event = 'task.failure_reset'
         AND json_extract(payload, '$.taskId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { at: string } | undefined;
  if (reset) {
    const row = d
      .prepare(
        `SELECT COUNT(*) AS n FROM system_audit
         WHERE event = 'task.failed'
           AND json_extract(payload, '$.taskId') = ?
           AND at > ?`,
      )
      .get(taskId, reset.at) as { n: number };
    return row.n;
  }
  const row = failCountStmt!.get(taskId) as { n: number };
  return row.n;
}

/**
 * Reset the failure clock for a task. Emits an audit row; subsequent calls
 * to `failureCountForTask(taskId)` ignore failures before this point.
 */
export function resetFailureCount(taskId: string, reason: string): void {
  audit('task.failure_reset', 'admin', { taskId, reason });
}

export function lastSuccessfulTaskAt(): string | null {
  open();
  const row = lastSuccessStmt!.get() as { at: string } | undefined;
  return row?.at ?? null;
}

export function lastEventAt(event: AuditEvent): string | null {
  open();
  const row = lastEventStmt!.get(event) as { at: string } | undefined;
  return row?.at ?? null;
}

/** Parsed payload of the most recent occurrence of `event`, or null. Used to
 * dedupe repeat notifications (e.g. don't re-DM the same pending update sha). */
export function lastEventPayload(event: AuditEvent): Record<string, unknown> | null {
  const d = open();
  const row = d
    .prepare(`SELECT payload FROM system_audit WHERE event = ? ORDER BY id DESC LIMIT 1`)
    .get(event) as { payload: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * How many audit passes have already run on `taskId` since the last
 * `task.failure_reset` (or since the beginning of time if no reset). Used by
 * the audit-runner to enforce MAX_AUDIT_PASSES.
 */
export function auditPassCountForTask(taskId: string): number {
  const d = open();
  const reset = d
    .prepare(
      `SELECT at FROM system_audit
       WHERE event = 'task.failure_reset'
         AND json_extract(payload, '$.taskId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { at: string } | undefined;
  const sql = reset
    ? `SELECT COUNT(*) AS n FROM system_audit
       WHERE event = 'task.audit.started'
         AND json_extract(payload, '$.taskId') = ?
         AND at > ?`
    : `SELECT COUNT(*) AS n FROM system_audit
       WHERE event = 'task.audit.started'
         AND json_extract(payload, '$.taskId') = ?`;
  const row = reset
    ? (d.prepare(sql).get(taskId, reset.at) as { n: number })
    : (d.prepare(sql).get(taskId) as { n: number });
  return row.n;
}

/**
 * Is `taskId` currently halted for operator review? True when the most recent
 * lifecycle row for the task is `task.halted_for_review` and no subsequent
 * `task.resumed` has cleared it.
 */
export function isTaskHalted(taskId: string): boolean {
  const d = open();
  const row = d
    .prepare(
      `SELECT event FROM system_audit
       WHERE json_extract(payload, '$.taskId') = ?
         AND event IN ('task.halted_for_review', 'task.resumed', 'task.completed', 'task.failure_reset')
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as { event: string } | undefined;
  return row?.event === 'task.halted_for_review';
}

/**
 * Was `taskId` already completed within [start, end)? Used to dedup slot-bound
 * tasks within their slot window so a single 15-minute slot fires each task
 * at most once even if launchd ticks twice (clock skew, DST edges).
 */
export function completedInWindow(taskId: string, start: Date, end: Date): boolean {
  open();
  const row = completedInWindowStmt!.get(taskId, start.toISOString(), end.toISOString()) as { n: number };
  return row.n > 0;
}

/**
 * IDs of all tasks that already completed OR failed in [start, end). Used to
 * skip slot-bound tasks that already had their shot this slot — including ones
 * that failed, so we don't loop on a flaky slotted task within one window.
 */
export function tasksFiredInWindow(start: Date, end: Date): Set<string> {
  open();
  const rows = firedInWindowStmt!.all(start.toISOString(), end.toISOString()) as Array<{ taskId: string | null }>;
  const out = new Set<string>();
  for (const r of rows) if (r.taskId) out.add(r.taskId);
  return out;
}

/**
 * Read raw audit rows for the run-tree projection / eval sampling. The chain
 * stays the canonical immutable ledger — this is a READ-ONLY window over it,
 * never a second write path. `sinceIso` bounds the scan to recent history so the
 * online-eval sampler doesn't re-walk the whole table every cadence. Rows come
 * back ascending by id (the chain order) so the projection can fold them in one
 * pass. The payload is returned as the raw JSON string; the projection parses it
 * (a malformed payload there must not crash a DB accessor).
 */
export function readAuditRowsSince(sinceIso: string): AuditRow[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT id, at, event, actor, payload, row_hash, prev_hash FROM system_audit
       WHERE at >= ? ORDER BY id ASC`,
    )
    .all(sinceIso) as Array<{
    id: number;
    at: string;
    event: string;
    actor: string;
    payload: string;
    row_hash: string;
    prev_hash: string;
  }>;
  return rows.map((r) => ({ ...r, event: r.event as AuditEvent, payload: r.payload }));
}

export interface ChainVerification {
  ok: boolean;
  totalRows: number;
  firstBadRowId?: number;
  reason?: string;
}

/**
 * Walk the audit table forward, recomputing each row's hash and bailing on the
 * first mismatch. Used at every dispatch tick as an integrity check.
 *
 * The audit table is append-only and grows without bound, so re-hashing every
 * row on every 5-minute tick is O(n) work that scales with history. By default
 * this verifies incrementally: a `(last_id, last_hash)` checkpoint in
 * `system_audit_chainpoint` anchors the prev-hash, and only rows newer than the
 * checkpoint are re-hashed. On success the checkpoint advances to the last row,
 * so the next tick only touches rows appended since. `totalRows` is still the
 * full row count, preserving the `dispatch.chain_verified` payload semantics.
 *
 * Pass `fromGenesis: true` to force a full walk from the genesis hash and ignore
 * the checkpoint (the `nyx audit --chain` integrity command). A full walk that
 * passes also refreshes the checkpoint and stamps `last_full_at` (default: real
 * wall-clock; `now` overrides it so tests can drive the periodic schedule).
 */
export function verifyChain(opts: { fromGenesis?: boolean; now?: number } = {}): ChainVerification {
  const d = open();

  let expectedPrev = GENESIS_HASH;
  let startAfterId = 0;
  let verifiedBefore = 0;

  if (!opts.fromGenesis) {
    const cp = d
      .prepare(`SELECT last_id, last_hash FROM system_audit_chainpoint WHERE id = 0`)
      .get() as { last_id: number; last_hash: string } | undefined;
    if (cp) {
      expectedPrev = cp.last_hash;
      startAfterId = cp.last_id;
      verifiedBefore = cp.last_id;
    }
  }

  const rows = d
    .prepare(`SELECT id, at, event, actor, payload, row_hash, prev_hash FROM system_audit WHERE id > ? ORDER BY id ASC`)
    .all(startAfterId) as Array<{ id: number; at: string; event: string; actor: string; payload: string; row_hash: string; prev_hash: string }>;

  const totalRows = verifiedBefore + rows.length;

  let lastId = startAfterId;
  let lastHash = expectedPrev;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, totalRows, firstBadRowId: row.id, reason: 'prev_hash mismatch' };
    }
    const recomputed = hashRow(row.at, row.event, row.actor, row.payload, row.prev_hash);
    if (recomputed !== row.row_hash) {
      return { ok: false, totalRows, firstBadRowId: row.id, reason: 'row_hash mismatch' };
    }
    expectedPrev = row.row_hash;
    lastId = row.id;
    lastHash = row.row_hash;
  }

  // A full fromGenesis walk that passes re-establishes trust in every row, so
  // it stamps last_full_at even when no new rows were appended (lastId may equal
  // startAfterId on an idle chain). The incremental path only advances on growth.
  if (opts.fromGenesis) {
    d.prepare(
      `INSERT INTO system_audit_chainpoint (id, last_id, last_hash, last_full_at) VALUES (0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash, last_full_at = excluded.last_full_at`,
    ).run(lastId, lastHash, new Date(opts.now ?? Date.now()).toISOString());
  } else if (lastId > startAfterId) {
    d.prepare(
      `INSERT INTO system_audit_chainpoint (id, last_id, last_hash) VALUES (0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_id = excluded.last_id, last_hash = excluded.last_hash`,
    ).run(lastId, lastHash);
  }

  return { ok: true, totalRows };
}

const FULL_VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Per-tick chain verification with a periodic full re-hash (M11). The default
 * incremental `verifyChain()` trusts the `system_audit_chainpoint` row as its
 * prev-hash anchor and only re-hashes rows newer than it — so anyone who can
 * write nyx.db could alter a row at id ≤ last_id AND bump the checkpoint past
 * it, and the routine check would pass while hiding the tamper. Forcing a full
 * fromGenesis walk at least once per `FULL_VERIFY_INTERVAL_MS` re-hashes the
 * entire chain, so a sub-checkpoint tamper cannot stay hidden longer than that
 * window. `forceFull` overrides the interval (used by tests / a manual trigger).
 *
 * The interval read is the chainpoint's `last_full_at`; a missing/never-set
 * value (fresh DB) forces an immediate full walk. The returned `wasFull` lets
 * the caller record which mode ran in the audit payload.
 */
export function verifyChainPeriodic(opts: { forceFull?: boolean; now?: number } = {}): ChainVerification & { wasFull: boolean } {
  const d = open();
  const now = opts.now ?? Date.now();
  const cp = d
    .prepare(`SELECT last_full_at FROM system_audit_chainpoint WHERE id = 0`)
    .get() as { last_full_at: string | null } | undefined;
  const lastFullMs = cp?.last_full_at ? Date.parse(cp.last_full_at) : Number.NaN;
  const due = Number.isNaN(lastFullMs) || now - lastFullMs >= FULL_VERIFY_INTERVAL_MS;
  const fromGenesis = opts.forceFull === true || due;
  const result = verifyChain({ fromGenesis, now });
  return { ...result, wasFull: fromGenesis };
}
