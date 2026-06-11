/**
 * System-wide activity ledger — narrative projection of the audit chain.
 *
 * The hash-chained `system_audit` table is the canonical record of WHAT
 * happened, but it is machine-shaped: 95+ raw event types, JSON payloads, one
 * row per dispatch tick. Briefs/digests previously reconstructed activity from
 * scratch each run. This module projects the chain into ONE human-readable doc
 * (`$NYX_DATA_DIR/ledger/LEDGER.md`) that downstream summarisers read FIRST.
 *
 * Design notes:
 *   - Lifecycle state is NOT hand re-derived here. The run-tree projection
 *     (`projectRunTrees`, src/eval/run-tree.ts) is the single source of truth
 *     for "these events are one run and it ended delivered/failed/halted". This
 *     module groups those trees into operator-facing SECTIONS:
 *       Delivered · In flight · Blocked-needs-operator · Incidents
 *       Observations · Notes
 *   - Each entry is ONE human sentence, prefixed with the `[instanceName]`
 *     actor — the future federation key for a hub-side rollup across instances.
 *     Do NOT collapse the tag into prose; the hub needs the literal token.
 *   - Manual operator notes (the `ledger_notes` table) render ONLY under Notes.
 *     The ledger never dual-writes dispatcher activity into a note — Notes is
 *     hand-authored context, the other sections are the chain projection.
 *   - Rendered text is passed through `redactSecrets` before write so a payload
 *     that captured a token (a failure_log echoing env, a stray PR URL with an
 *     embedded credential) can never land in the on-disk doc.
 *   - File write is atomic via tmp+rename so a brief that opens the doc mid-
 *     render never sees a half-written file.
 *
 * This module is READ-ONLY against the chain — it never inserts into
 * system_audit. The chain stays single-writer. Re-renders are idempotent. The
 * only table it writes is `ledger_notes` (operator notes), via `addNote`.
 *
 * Lifecycle is read from the CHAIN, not from the auxiliary mutable tables.
 * `projectRunTrees` folds `task.*` / `pipeline.*` events into runs, so the
 * optional tables (`task_outcomes` — note the post-taxonomy name —,
 * `composer_normalizations`, `pipeline_runs`) are never queried here and their
 * absence is a non-issue: a fresh install or an instance that never ran a
 * pipeline still renders a valid ledger from the audit rows alone.
 */

import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { readAuditRowsSince, type AuditEvent, type AuditRow } from './audit.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { projectRunTrees, type RunTree } from './eval/run-tree.js';
import { redactSecrets } from './notifier.js';

export const LEDGER_PATH = resolve(config.dataDir, 'ledger', 'LEDGER.md');

const DEFAULT_WINDOW_DAYS = 7;

/** A manual operator note — the only rows this module writes. */
export interface LedgerNote {
  id: number;
  at: string;
  actor: string;
  category: string;
  text: string;
  /** Optional reference (task id, PR url, doc path) the note hangs off of. */
  ref: string | null;
}

// ── ledger_notes table (the one table this module writes) ────────────────────

let notesDb: DatabaseSync | null = null;

/**
 * Test hook — swap the notes DB for an in-memory instance so tests can exercise
 * `addNote`/`getNotesSince` without touching the real nyx.db. Mirrors
 * `_setAuditDb` / `_setComposerDb`. Pass null to clear; the next call lazy-opens
 * the real DB again. Production code never calls this.
 */
export function _setLedgerDb(newDb: DatabaseSync | null): void {
  notesDb = newDb;
}

function notesOpen(): DatabaseSync {
  if (!notesDb) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    notesDb = openDb(config.dbPath);
  }
  notesDb.exec(`
    CREATE TABLE IF NOT EXISTS ledger_notes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at        TEXT    NOT NULL,
      actor     TEXT    NOT NULL,
      category  TEXT    NOT NULL DEFAULT 'note',
      text      TEXT    NOT NULL,
      ref       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_notes_at ON ledger_notes(at);
  `);
  return notesDb;
}

/** Record a manual operator note. Renders under the Notes section only. */
export function addNote(text: string, opts: { category?: string; ref?: string; actor?: string; at?: string } = {}): LedgerNote {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('addNote: text is empty');
  const d = notesOpen();
  const at = opts.at ?? new Date().toISOString();
  const actor = opts.actor ?? config.settings.instanceName;
  const category = (opts.category ?? 'note').trim() || 'note';
  const ref = opts.ref?.trim() ? opts.ref.trim() : null;
  d.prepare(`INSERT INTO ledger_notes (at, actor, category, text, ref) VALUES (?, ?, ?, ?, ?)`).run(
    at,
    actor,
    category,
    trimmed,
    ref,
  );
  const row = d.prepare(`SELECT id FROM ledger_notes ORDER BY id DESC LIMIT 1`).get() as { id: number };
  return { id: row.id, at, actor, category, text: trimmed, ref };
}

/** Notes on or after `sinceIso`, newest-first. Absent table → []. */
export function getNotesSince(sinceIso: string): LedgerNote[] {
  let d: DatabaseSync;
  try {
    d = notesOpen();
  } catch {
    return [];
  }
  try {
    const rows = d
      .prepare(`SELECT id, at, actor, category, text, ref FROM ledger_notes WHERE at >= ? ORDER BY id DESC`)
      .all(sinceIso) as Array<{ id: number; at: string; actor: string; category: string; text: string; ref: string | null }>;
    return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, category: r.category, text: r.text, ref: r.ref }));
  } catch {
    // Table missing / malformed → degrade to no notes rather than crash a render.
    return [];
  }
}

// ── render ───────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** ISO timestamp lower bound (inclusive). Default: `windowDays` ago. */
  sinceIso?: string;
  /** Lookback window when `sinceIso` is absent. Default 7. */
  windowDays?: number;
  /** Override `config.systemName` (e.g. for federated rendering). */
  systemName?: string;
  /** Override the actor/instance tag prefix. Default `config.settings.instanceName`. */
  instanceName?: string;
  /** Override the "generated" timestamp; useful for deterministic snapshots. */
  generatedAt?: Date;
  /**
   * Pre-fetched rows (tests). When provided, the audit DB is NOT read; rows
   * are projected as given. Order must be ascending by id.
   */
  rows?: AuditRow[];
  /**
   * Pre-fetched notes (tests). When provided, the notes DB is NOT read.
   */
  notes?: LedgerNote[];
  /**
   * Override output path. Defaults to `LEDGER_PATH`. Used by tests to write to
   * a temp dir; production never sets this.
   */
  outPath?: string;
}

/** The six operator-facing sections, in render order. */
export type LedgerSection =
  | 'Delivered'
  | 'In flight'
  | 'Blocked-needs-operator'
  | 'Incidents'
  | 'Observations'
  | 'Notes';

const SECTION_ORDER: readonly LedgerSection[] = [
  'Delivered',
  'In flight',
  'Blocked-needs-operator',
  'Incidents',
  'Observations',
  'Notes',
];

export interface LedgerEntry {
  /** Sort key: the audit id of the run's terminal (or latest) event. */
  id: number;
  /** ISO timestamp the entry is dated by. */
  at: string;
  /** YYYY-MM-DD in UTC. */
  day: string;
  /** HH:MM:SS in UTC. */
  time: string;
  /** Actor/instance tag rendered in brackets — the federation key. */
  actor: string;
  /** Which section the entry belongs to. */
  section: LedgerSection;
  /** The one-sentence human narrative (sans time + actor prefix). */
  sentence: string;
}

/** Map a run-tree outcome to its ledger section. */
function sectionForOutcome(tree: RunTree): LedgerSection {
  switch (tree.outcome) {
    case 'completed':
      return 'Delivered';
    case 'halted':
      return 'Blocked-needs-operator';
    case 'failed':
    case 'abandoned':
      return 'Incidents';
    case 'in-progress':
      return 'In flight';
    default:
      return 'In flight';
  }
}

function dayOf(at: string): string {
  return at.slice(0, 10);
}

function timeOf(at: string): string {
  return at.slice(11, 19);
}

function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strOf(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function durStr(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  return `${m.toFixed(1)}m`;
}

/** First non-empty payload value for `key` across a run's events, scanning newest-first. */
function latestField(tree: RunTree, key: string): unknown {
  for (let i = tree.events.length - 1; i >= 0; i -= 1) {
    const v = tree.events[i]!.payload[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** PR URL surfaced by any pr.created / pushed event in the run. */
function prUrlOf(tree: RunTree): string | undefined {
  for (let i = tree.events.length - 1; i >= 0; i -= 1) {
    const p = tree.events[i]!.payload;
    const url = strOf(p, 'prUrl') ?? strOf(p, 'branchUrl');
    if (url) return url;
  }
  return undefined;
}

/** Total run duration in ms — explicit durationMs if present, else end−start. */
function durationMsOf(tree: RunTree): number | undefined {
  const explicit = latestField(tree, 'durationMs');
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  const start = Date.parse(tree.startedAt);
  const end = Date.parse(tree.endedAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  return undefined;
}

/** The judge score (0..100 confidence or 0..1) recorded for this run, if any. */
function judgeScoreOf(tree: RunTree): string | undefined {
  for (let i = tree.events.length - 1; i >= 0; i -= 1) {
    const ev = tree.events[i]!;
    if (ev.event === 'task.judge.captured' || ev.event === 'task.judge.concern' || ev.event === 'eval.online.scored') {
      const p = ev.payload;
      const score = num(p, 'score') ?? num(p, 'confidence');
      const verdict = strOf(p, 'verdict');
      if (score != null) {
        // 0..1 eval scores get a percent; 0..100 confidence stays as-is.
        const pretty = score <= 1 ? `${Math.round(score * 100)}%` : `${score}`;
        return verdict ? `${verdict} ${pretty}` : pretty;
      }
      if (verdict) return verdict;
    }
  }
  return undefined;
}

/** The task TYPE label, e.g. "code"/"pipeline". */
function typeLabel(tree: RunTree): string {
  if (tree.isPipeline) return 'pipeline';
  return tree.taskType ?? 'task';
}

/**
 * Compose the one-sentence narrative for a run, weaving in the meaningful
 * payload fields (PR URL, duration, cost, judge score). The renderer prepends
 * the time + `[actor]`; this returns just the sentence.
 */
export function sentenceForRun(tree: RunTree): string {
  const id = tree.correlationId;
  const kind = typeLabel(tree);
  const dur = durStr(durationMsOf(tree));
  const cost = tree.estimatedCostUsd;
  const url = prUrlOf(tree);
  const judge = judgeScoreOf(tree);

  const tail: string[] = [];
  if (url) tail.push(url);
  if (dur) tail.push(`in ${dur}`);
  if (cost != null && cost > 0) tail.push(`$${cost.toFixed(4)}`);
  if (judge) tail.push(`judge ${judge}`);
  const tailStr = tail.length > 0 ? ` (${tail.join(', ')})` : '';

  switch (tree.outcome) {
    case 'completed':
      return `${id} (${kind}) delivered${tailStr}`;
    case 'halted': {
      const reason = haltReasonOf(tree);
      const r = reason ? ` — ${reason}` : ' — needs operator review';
      return `${id} (${kind}) halted${r}${tailStr}`;
    }
    case 'failed': {
      const stage = stageOf(tree);
      const stageTag = stage ? ` at ${stage}` : '';
      return `${id} (${kind}) failed${stageTag}${tailStr}`;
    }
    case 'abandoned':
      return `${id} (${kind}) abandoned after repeated failures${tailStr}`;
    case 'in-progress':
      return `${id} (${kind}) in flight${tailStr}`;
    default:
      return `${id} (${kind})${tailStr}`;
  }
}

/**
 * The halt reason off the run's last halt event itself. haltTask emits
 * `pattern` (e.g. `audit-cap`); `reason` is the legacy fallback. Must NOT use
 * latestField('reason') across the whole run — the halt event carries no
 * `reason` key, so that picks up an unrelated event's reason (a wisdom-skip,
 * a classifier detail) and renders it as the halt cause.
 */
function haltReasonOf(tree: RunTree): string | undefined {
  for (let i = tree.events.length - 1; i >= 0; i -= 1) {
    const ev = tree.events[i]!;
    if (ev.event === 'task.halted_for_review') {
      return strOf(ev.payload, 'pattern') ?? strOf(ev.payload, 'reason');
    }
  }
  return undefined;
}

/** The failure stage off the run's last task.failed event, if any. */
function stageOf(tree: RunTree): string | undefined {
  for (let i = tree.events.length - 1; i >= 0; i -= 1) {
    const ev = tree.events[i]!;
    if (ev.event === 'task.failed') return strOf(ev.payload, 'stage');
  }
  return undefined;
}

// ── observation events (system-level, not part of any run) ───────────────────

/** System-level signals that belong under Observations rather than a run. */
const OBSERVATION_EVENTS: ReadonlySet<AuditEvent> = new Set<AuditEvent>([
  'dispatch.rate_limited',
  'dispatch.iso_pool.drained',
  'dispatch.chain_limit_reached',
  'dispatch.update_available',
  'tick.gap_detected',
  'eval.drift.regressed',
  'task.mcp.breaker_opened',
  'task.mcp.breaker_closed',
  'task.production.deploy_required',
]);

function observationSentence(event: AuditEvent, p: Record<string, unknown>): string {
  switch (event) {
    case 'dispatch.rate_limited':
      return `rate limited (cooldown ${durStr(num(p, 'cooldownMs'))})`;
    case 'dispatch.iso_pool.drained':
      return `ISO pool drained (${num(p, 'count') ?? 0})`;
    case 'dispatch.chain_limit_reached':
      return `dispatch chain limit reached (depth ${num(p, 'depth') ?? '?'})`;
    case 'dispatch.update_available':
      return `update available (${strOf(p, 'version') ?? '?'})`;
    case 'tick.gap_detected':
      return `tick gap detected (${num(p, 'gap_minutes') ?? '?'}m outage recovered)`;
    case 'eval.drift.regressed':
      return `eval drift regression detected`;
    case 'task.mcp.breaker_opened':
      return `MCP breaker opened (${strOf(p, 'server') ?? '?'})`;
    case 'task.mcp.breaker_closed':
      return `MCP breaker closed (${strOf(p, 'server') ?? '?'})`;
    case 'task.production.deploy_required': {
      const id = strOf(p, 'taskId');
      const targets = p['deployTargets'];
      const tStr = Array.isArray(targets) && targets.length > 0 ? ` → ${targets.join(', ')}` : '';
      return `deploy required${id ? ` (${id})` : ''}${tStr}`;
    }
    default:
      return event;
  }
}

// ── projection ───────────────────────────────────────────────────────────────

export interface ProjectedLedger {
  entries: LedgerEntry[];
  /** Count of audit rows considered (for the header). */
  rowCount: number;
}

/**
 * Project audit rows + operator notes into categorised ledger entries.
 * Lifecycle state comes from `projectRunTrees` — this never re-derives it. The
 * actor prefix is the resolved instance name (the federation key), NOT the raw
 * per-row `actor` (which is an internal subsystem label).
 */
export function projectLedger(rows: AuditRow[], notes: LedgerNote[], actor: string): ProjectedLedger {
  const entries: LedgerEntry[] = [];

  // 1. Runs → Delivered / In flight / Blocked / Incidents.
  const trees = projectRunTrees(rows);
  for (const tree of trees) {
    const at = tree.endedAt;
    entries.push({
      id: lastEventId(tree),
      at,
      day: dayOf(at),
      time: timeOf(at),
      actor,
      section: sectionForOutcome(tree),
      sentence: sentenceForRun(tree),
    });
  }

  // 2. System-level observation events (not part of any run).
  for (const r of rows) {
    if (!OBSERVATION_EVENTS.has(r.event)) continue;
    const payload = parsePayload(r);
    entries.push({
      id: r.id,
      at: r.at,
      day: dayOf(r.at),
      time: timeOf(r.at),
      actor,
      section: 'Observations',
      sentence: observationSentence(r.event, payload),
    });
  }

  // 3. Manual operator notes → Notes (verbatim text + its own author tag).
  for (const n of notes) {
    const catTag = n.category && n.category !== 'note' ? `[${n.category}] ` : '';
    const refTag = n.ref ? ` (${n.ref})` : '';
    entries.push({
      id: n.id,
      at: n.at,
      day: dayOf(n.at),
      time: timeOf(n.at),
      actor: n.actor,
      section: 'Notes',
      sentence: `${catTag}${n.text}${refTag}`,
    });
  }

  return { entries, rowCount: rows.length };
}

function lastEventId(tree: RunTree): number {
  return tree.events.length > 0 ? tree.events[tree.events.length - 1]!.id : 0;
}

function parsePayload(row: AuditRow): Record<string, unknown> {
  if (row.payload && typeof row.payload === 'object') return row.payload as Record<string, unknown>;
  if (typeof row.payload !== 'string') return {};
  try {
    const v = JSON.parse(row.payload) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Render the categorised entries to markdown: grouped by UTC day (newest first),
 * each day split into the six sections (a section is omitted when empty). The
 * result is NOT yet redacted — `writeLedgerFile` redacts before write so tests
 * can inspect the raw structure too.
 */
export function renderLedger(projected: ProjectedLedger, opts: RenderOptions = {}): string {
  const systemName = opts.systemName ?? config.systemName;
  const generatedAt = (opts.generatedAt ?? new Date()).toISOString();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const { entries, rowCount } = projected;

  const lines: string[] = [];
  lines.push(`# ${systemName} — Activity Ledger`);
  lines.push('');
  lines.push(
    `_Generated view — do not edit. Rendered ${generatedAt} from system_audit ` +
      `(${rowCount} row${rowCount === 1 ? '' : 's'}, ${opts.sinceIso ? `since ${opts.sinceIso}` : `${windowDays}-day window`})._`,
  );
  lines.push('');
  lines.push(
    `Narrative projection of the hash-chained audit ledger, grouped by day then by ` +
      `lifecycle. Every line carries an \`[actor]\` tag for federated rollup.`,
  );
  lines.push('');

  if (entries.length === 0) {
    lines.push('_No activity in window._');
    lines.push('');
    return lines.join('\n');
  }

  const byDay = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const bucket = byDay.get(e.day);
    if (bucket) bucket.push(e);
    else byDay.set(e.day, [e]);
  }
  const days = Array.from(byDay.keys()).sort().reverse();

  for (const day of days) {
    lines.push(`## ${day}`);
    lines.push('');
    const dayEntries = byDay.get(day)!;
    for (const section of SECTION_ORDER) {
      const inSection = dayEntries
        .filter((e) => e.section === section)
        .sort((a, b) => a.id - b.id);
      if (inSection.length === 0) continue;
      lines.push(`### ${section}`);
      lines.push('');
      for (const e of inSection) {
        lines.push(`- \`${e.time}\` **[${e.actor}]** ${e.sentence}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Compose the full ledger doc and atomically write it to `outPath`. The body is
 * passed through `redactSecrets` before write so a captured token can never land
 * on disk. tmp+rename guarantees a concurrent reader never sees a half-write.
 */
export function writeLedgerFile(opts: RenderOptions = {}): { path: string; entries: number; bytes: number } {
  const path = opts.outPath ?? LEDGER_PATH;
  const since = defaultSinceIso(opts);
  const rows = opts.rows ?? readAuditRowsSince(since);
  const notes = opts.notes ?? getNotesSince(since);
  const actor = opts.instanceName ?? config.settings.instanceName;
  const projected = projectLedger(rows, notes, actor);
  const body = redactSecrets(renderLedger(projected, opts));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
  return { path, entries: projected.entries.length, bytes: Buffer.byteLength(body, 'utf8') };
}

function defaultSinceIso(opts: RenderOptions): string {
  if (opts.sinceIso) return opts.sinceIso;
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const ms = (opts.generatedAt ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

// ── end-of-tick hook ─────────────────────────────────────────────────────────

/**
 * In-process memo of the highest system_audit id the ledger has already
 * rendered. The end-of-tick hook skips the render entirely when no new audit
 * row has been appended since the last one — a cheap `max(id)` check keeps an
 * idle tick from re-writing an unchanged doc. Persisted in-process: a fresh
 * dispatcher process renders once (memo starts null) then memoizes for the
 * remainder of its life. Rendering can NEVER fail or materially slow a tick, so
 * `maybeRenderLedgerAtTickEnd` swallows everything.
 */
let lastRenderedAuditId: number | null = null;

/** Reset the in-process memo (tests). */
export function _resetLedgerRenderMemo(): void {
  lastRenderedAuditId = null;
}

function maxAuditId(rows: AuditRow[]): number {
  let max = 0;
  for (const r of rows) if (r.id > max) max = r.id;
  return max;
}

/**
 * End-of-tick ledger render. Called from run-once.ts main() alongside the other
 * tail-of-tick work (maybeFlushDigest / runEvalLoop). Best-effort: any failure
 * is swallowed so a render bug can never fail a tick that already did real work.
 * Skips the write when no audit row was appended since the last render.
 *
 * Returns true when a render was performed, false when skipped (no new rows) or
 * swallowed an error — the caller ignores it; the boolean is for tests.
 */
export function maybeRenderLedgerAtTickEnd(opts: RenderOptions = {}): boolean {
  try {
    const since = defaultSinceIso(opts);
    const rows = opts.rows ?? readAuditRowsSince(since);
    const maxId = maxAuditId(rows);
    // Skip when nothing newer than the last render exists in the window.
    if (lastRenderedAuditId !== null && maxId <= lastRenderedAuditId) return false;
    const notes = opts.notes ?? getNotesSince(since);
    const actor = opts.instanceName ?? config.settings.instanceName;
    const projected = projectLedger(rows, notes, actor);
    const body = redactSecrets(renderLedger(projected, opts));
    const path = opts.outPath ?? LEDGER_PATH;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
    lastRenderedAuditId = maxId;
    return true;
  } catch {
    // Rendering NEVER fails a tick. Swallow everything.
    return false;
  }
}
