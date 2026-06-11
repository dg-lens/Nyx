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
 *   - One line per meaningful audit row, grouped by UTC day. Each line carries
 *     `[actor]` verbatim from the chain — that tag is the seed for a future
 *     hub-side rollup across federated instances. Do NOT collapse it into a
 *     prose subject; the hub needs the literal token.
 *   - Noisy housekeeping events (`dispatch.tick`, `dispatch.idle`, chain
 *     verifications, update checks) are rolled up into one per-day summary line
 *     so the doc stays readable across long horizons.
 *   - File write is atomic via tmp+rename so a brief that opens the doc mid-
 *     render never sees a half-written file.
 *
 * This module is READ-ONLY against the chain — it never inserts. The chain
 * stays single-writer. Re-renders are idempotent.
 */

import { mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { readAuditRowsSince, type AuditEvent, type AuditRow } from './audit.js';
import { config } from './config.js';

export const LEDGER_PATH = resolve(config.dataDir, 'ledger', 'LEDGER.md');

const DEFAULT_WINDOW_DAYS = 7;

const ROLLUP_EVENTS: ReadonlySet<AuditEvent> = new Set<AuditEvent>([
  'dispatch.tick',
  'dispatch.idle',
  'dispatch.stale',
  'dispatch.chain_verified',
  'dispatch.update_check',
]);

const ROLLUP_LABEL: Partial<Record<AuditEvent, string>> = {
  'dispatch.tick': 'tick',
  'dispatch.idle': 'idle',
  'dispatch.stale': 'stale',
  'dispatch.chain_verified': 'chain-verified',
  'dispatch.update_check': 'update-check',
};

export interface RenderOptions {
  /** ISO timestamp lower bound (inclusive). Default: `windowDays` ago. */
  sinceIso?: string;
  /** Lookback window when `sinceIso` is absent. Default 7. */
  windowDays?: number;
  /** Override `config.systemName` (e.g. for federated rendering). */
  systemName?: string;
  /** Override the "generated" timestamp; useful for deterministic snapshots. */
  generatedAt?: Date;
  /**
   * Pre-fetched rows (tests). When provided, the audit DB is NOT read; rows
   * are projected as given. Order must be ascending by id.
   */
  rows?: AuditRow[];
  /**
   * Override output path. Defaults to `LEDGER_PATH`. Used by tests to write to
   * a temp dir; production never sets this.
   */
  outPath?: string;
}

export interface LedgerEntry {
  id: number;
  at: string;
  actor: string;
  event: AuditEvent;
  /** YYYY-MM-DD in UTC. */
  day: string;
  /** HH:MM:SS in UTC. */
  time: string;
  /** Human-readable narrative; the renderer prepends time + `[actor]`. */
  narrative: string;
  /** True when this row is rolled up into a per-day summary instead of inline. */
  rollup: boolean;
}

/** Parse the JSON payload string off an AuditRow; tolerates malformed JSON. */
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

function dayOf(at: string): string {
  return at.slice(0, 10);
}

function timeOf(at: string): string {
  return at.slice(11, 19);
}

function str(p: Record<string, unknown>, k: string): string | undefined {
  const v = p[k];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(p: Record<string, unknown>, k: string): number | undefined {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function durStr(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  return `${m.toFixed(1)}m`;
}

/**
 * Project one audit row to a one-line narrative. The renderer prepends the
 * timestamp + `[actor]` tag; this returns the verb-phrase that follows. Unknown
 * event types fall back to a generic `<event> <taskId?>` form rather than
 * dropping the row — the ledger is the catch-all narrative; nothing vanishes.
 */
export function narrativeFor(event: AuditEvent, payload: Record<string, unknown>): string {
  const id = str(payload, 'taskId');
  const idTag = id ? ` ${id}` : '';
  switch (event) {
    case 'task.started': {
      const type = str(payload, 'type') ?? 'task';
      const model = str(payload, 'model') ?? 'unknown';
      return `started${idTag} (${type}, ${model})`;
    }
    case 'task.completed': {
      const url = str(payload, 'prUrl');
      const dur = durStr(num(payload, 'durationMs'));
      const tail = url ? ` → ${url}` : '';
      const durTag = dur ? ` in ${dur}` : '';
      return `completed${idTag}${durTag}${tail}`;
    }
    case 'task.failed': {
      const stage = str(payload, 'stage');
      const reason = str(payload, 'failure_log');
      const stageTag = stage ? ` at ${stage}` : '';
      const reasonTag = reason ? ` — ${reason.split('\n')[0]!.slice(0, 200)}` : '';
      return `failed${idTag}${stageTag}${reasonTag}`;
    }
    case 'task.committed':
      return `committed${idTag}${str(payload, 'source') === 'prior-attempt' ? ' (prior-attempt)' : ''}`;
    case 'task.merged':
      return `merged${idTag}${str(payload, 'branch') ? ` (branch ${str(payload, 'branch')})` : ''}`;
    case 'task.pr.created':
      return `opened PR${idTag} → ${str(payload, 'prUrl') ?? '(no URL)'}`;
    case 'task.pushed': {
      const mode = str(payload, 'mode') ?? 'pr';
      const repo = str(payload, 'repo') ?? '?';
      const url = str(payload, 'branchUrl');
      return `pushed${idTag} (${mode} → ${repo})${url ? ` → ${url}` : ''}`;
    }
    case 'task.gate.completed':
      return `gate passed${idTag}`;
    case 'task.rollback':
      return `rolled back${idTag} (${str(payload, 'reason') ?? 'unknown reason'})`;
    case 'task.abandoned':
      return `abandoned${idTag} (3-strike)`;
    case 'task.halted_for_review':
      return `halted${idTag} for review (${str(payload, 'reason') ?? 'review needed'})`;
    case 'task.resumed':
      return `resumed${idTag}`;
    case 'task.cancelled':
      return `cancelled${idTag}`;
    case 'task.output.written':
      return `wrote output${idTag} → ${str(payload, 'path') ?? '(no path)'}`;
    case 'task.audit.started':
      return `audit pass started${idTag}`;
    case 'task.audit.classified':
      return `audit classified${idTag} → ${str(payload, 'classification') ?? str(payload, 'category') ?? 'unknown'}`;
    case 'task.audit.autofix.applied':
      return `audit autofix applied${idTag}`;
    case 'task.audit.autofix.succeeded':
      return `audit autofix succeeded${idTag}`;
    case 'task.audit.autofix.failed':
      return `audit autofix failed${idTag}`;
    case 'task.audit.escalated':
      return `audit escalated${idTag}`;
    case 'task.production.deploy_required': {
      const targets = payload['deployTargets'];
      const tStr = Array.isArray(targets) && targets.length > 0 ? ` → ${targets.join(', ')}` : '';
      return `deploy required${idTag}${tStr}`;
    }
    case 'task.ambiguity.escalated':
      return `ambiguity escalated${idTag} → ${str(payload, 'ambiguity_file') ?? '(no file)'}`;
    case 'task.wisdom.captured':
      return `wisdom captured${idTag}`;
    case 'task.wisdom.skipped':
      return `wisdom skipped${idTag}${str(payload, 'reason') ? ` (${str(payload, 'reason')})` : ''}`;
    case 'task.judge.captured':
      return `content-judge captured${idTag}`;
    case 'task.judge.concern':
      return `content-judge concern${idTag}`;
    case 'task.lint.passed':
      return `lint passed${idTag}`;
    case 'task.lint.failed':
      return `lint failed${idTag}`;
    case 'task.lint.skipped':
      return `lint skipped${idTag}`;
    case 'task.gate.flaky_quarantined':
      return `flaky test quarantined${idTag}`;
    case 'task.gate.test_infra_touched':
      return `gate-trust flagged${idTag} (test-infra touched)`;
    case 'task.test_oracle.rotten_green':
      return `rotten-green test detected${idTag}`;
    case 'task.usage.metered': {
      const cost = num(payload, 'costUsd');
      return `metered${idTag}${cost != null ? ` ($${cost.toFixed(4)})` : ''}`;
    }
    case 'task.skipped.in_flight':
    case 'task.skipped.depends_unmet':
    case 'task.skipped.concurrent_claude':
    case 'task.skipped.halt_chain':
    case 'task.skipped.git_busy':
    case 'task.skipped.iso_cap':
    case 'task.skipped.rate_limited': {
      const kind = event.slice('task.skipped.'.length);
      return `skipped${idTag} (${kind})`;
    }
    case 'task.claude.exited': {
      const code = num(payload, 'exitCode');
      return `claude exited${idTag}${code != null ? ` (code ${code})` : ''}`;
    }
    case 'task.claude.stalled':
      return `claude stalled${idTag} (silence watchdog)`;
    case 'task.failure_reset':
      return `failure clock reset${idTag} (${str(payload, 'reason') ?? 'manual'})`;
    case 'task.preflight.failed':
      return `preflight failed${idTag} (${str(payload, 'failure_log')?.split('\n')[0] ?? 'preflight check'})`;
    case 'task.expects.failed':
      return `expects failed${idTag}`;
    case 'task.expects.prevalidate.failed':
      return `expects prevalidate failed${idTag}`;
    case 'task.reading_tag.absent':
      return `[reading:] tag absent${idTag}`;
    case 'task.tag.invalid':
      return `invalid tag${idTag}`;
    case 'task.stale_worktree_cleared':
      return `stale worktree cleared${idTag}`;
    case 'task.clone.basebranch.assertion_failed':
      return `clone base-branch assertion failed${idTag}`;
    case 'task.mcp.breaker_opened':
      return `MCP breaker opened (${str(payload, 'server') ?? '?'})`;
    case 'task.mcp.breaker_closed':
      return `MCP breaker closed (${str(payload, 'server') ?? '?'})`;
    case 'task.mcp.servers_withheld':
      return `MCP servers withheld${idTag}`;
    case 'task.mcp.policy_decision':
      return `MCP policy decision${idTag}`;
    case 'task.mcp.auth_stale':
      return `MCP auth stale (${str(payload, 'server') ?? '?'})`;
    case 'task.mcp.auth_failure':
      return `MCP auth failure${idTag}`;
    case 'task.doc_sweep.passed':
      return `doc-sweep passed${idTag}`;
    case 'task.doc_sweep.failed':
      return `doc-sweep failed${idTag}`;
    case 'assistant.morning_brief':
      return `morning brief delivered`;
    case 'assistant.slack_digest':
      return `slack digest delivered`;
    case 'assistant.reminder':
      return `reminder delivered${idTag}`;
    case 'assistant.rotation_check.run':
      return `rotation check run`;
    case 'assistant.rotation_check.clear':
      return `rotation check clear`;
    case 'notification.digest.batched':
      return `notification batched (${str(payload, 'category') ?? 'unknown'})`;
    case 'notification.digest.flushed':
      return `notification digest flushed (${num(payload, 'count') ?? 0} items)`;
    case 'bitwarden.project.registered':
      return `bitwarden project registered (${str(payload, 'project') ?? str(payload, 'name') ?? '?'})`;
    case 'bitwarden.project.created':
      return `bitwarden project created (${str(payload, 'project') ?? str(payload, 'name') ?? '?'})`;
    case 'bitwarden.secret.rotation_logged':
      return `bitwarden rotation logged`;
    case 'bitwarden.secret.rotation_updated':
      return `bitwarden rotation updated`;
    case 'bitwarden.token.missing':
      return `bitwarden token missing${idTag}`;
    case 'inbox.rotation.ingested':
      return `rotation event ingested`;
    case 'inbox.rotation.malformed':
      return `rotation event malformed`;
    case 'pipeline.run.started':
      return `pipeline run started${idTag}`;
    case 'pipeline.stage.advanced':
      return `pipeline stage advanced${idTag} → ${str(payload, 'to') ?? str(payload, 'stage') ?? '?'}`;
    case 'pipeline.preview.delivered':
      return `pipeline preview delivered${idTag}`;
    case 'pipeline.preview.approved':
      return `pipeline preview approved${idTag}`;
    case 'pipeline.preview.revised':
      return `pipeline preview revised${idTag}`;
    case 'pipeline.decision.submitted':
      return `pipeline decision submitted${idTag} (${str(payload, 'kind') ?? '?'})`;
    case 'pipeline.executing.started':
      return `pipeline execution started${idTag}`;
    case 'pipeline.coder.started':
      return `pipeline coder started${idTag}`;
    case 'pipeline.coder.finished':
      return `pipeline coder finished${idTag}`;
    case 'pipeline.redux.complete':
      return `pipeline redux complete${idTag}`;
    case 'pipeline.diagnostic.started':
      return `pipeline diagnostic started${idTag}`;
    case 'pipeline.diagnostic.finished':
      return `pipeline diagnostic finished${idTag}`;
    case 'pipeline.review.delivered':
      return `pipeline review delivered${idTag}`;
    case 'pipeline.review.accept':
      return `pipeline accepted${idTag}`;
    case 'pipeline.review.proceed':
      return `pipeline proceeded${idTag}`;
    case 'pipeline.review.fix':
      return `pipeline review → fix${idTag}`;
    case 'pipeline.review.rollback':
      return `pipeline rollback${idTag}`;
    case 'pipeline.delivered':
      return `pipeline delivered${idTag}`;
    case 'pipeline.failed':
      return `pipeline failed${idTag}`;
    case 'pipeline.aborted':
      return `pipeline aborted${idTag}`;
    case 'pipeline.short_circuit':
      return `pipeline short-circuited${idTag}`;
    case 'pipeline.rejected':
      return `pipeline rejected${idTag}`;
    case 'pipeline.deps.installed':
      return `pipeline deps installed${idTag}`;
    case 'composer.run.spawned':
      return `composer run spawned${idTag}`;
    case 'composer.run.completed':
      return `composer run completed${idTag}`;
    case 'composer.normalize.completed':
      return `composer normalize completed${idTag}`;
    case 'composer.normalize.skipped':
      return `composer normalize skipped${idTag}`;
    case 'composer.skipped':
      return `composer skipped${idTag}`;
    case 'eval.online.sampled':
      return `eval sampled (${num(payload, 'selected') ?? 0}/${num(payload, 'candidates') ?? 0})`;
    case 'eval.online.scored':
      return `eval scored${idTag}`;
    case 'eval.drift.regressed':
      return `eval drift regression detected`;
    case 'eval.drift.checked':
      return `eval drift checked (${num(payload, 'regressions') ?? 0} regression(s))`;
    case 'dispatch.chain_limit_reached':
      return `chain limit reached`;
    case 'dispatch.update_available':
      return `update available (${str(payload, 'version') ?? '?'})`;
    case 'dispatch.iso_pool.drained':
      return `ISO pool drained`;
    case 'dispatch.rate_limited':
      return `rate limited (cooldown ${durStr(num(payload, 'cooldownMs'))})`;
    case 'tick.gap_detected':
      return `tick gap detected (${num(payload, 'gapMinutes') ?? '?'}m)`;
    case 'plugin.loaded':
      return `plugin loaded (${str(payload, 'name') ?? '?'})`;
    case 'plugin.skipped':
      return `plugin skipped (${str(payload, 'name') ?? '?'})`;
    case 'plugin.hook.error':
      return `plugin hook error (${str(payload, 'hook') ?? '?'} / ${str(payload, 'plugin') ?? '?'})`;
    case 'plugin.io.error':
      return `plugin io error (${str(payload, 'where') ?? '?'})`;
    case 'control.action.applied':
      return `control action applied (${str(payload, 'action') ?? '?'})`;
    case 'control.action.failed':
      return `control action failed (${str(payload, 'action') ?? '?'})`;
    case 'control.decompose.applied':
      return `control decompose applied${idTag}`;
    case 'control.decompose.failed':
      return `control decompose failed${idTag}`;
    case 'analyzer.clone.started':
      return `analyzer clone started`;
    case 'analyzer.scan.completed':
      return `analyzer scan completed`;
    case 'analyzer.pr.created':
      return `analyzer PR opened → ${str(payload, 'prUrl') ?? '(no URL)'}`;
    default:
      return id ? `${event}${idTag}` : event;
  }
}

/**
 * Project rows → ledger entries. Order is preserved (ascending audit id), so
 * grouping by day is a stable single pass.
 */
export function projectRows(rows: AuditRow[]): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    const payload = parsePayload(r);
    const rollup = ROLLUP_EVENTS.has(r.event);
    out.push({
      id: r.id,
      at: r.at,
      actor: r.actor,
      event: r.event,
      day: dayOf(r.at),
      time: timeOf(r.at),
      narrative: narrativeFor(r.event, payload),
      rollup,
    });
  }
  return out;
}

/** Compose the final markdown body. Exported for test inspection. */
export function renderMarkdown(entries: LedgerEntry[], opts: RenderOptions = {}): string {
  const systemName = opts.systemName ?? config.systemName;
  const generatedAt = (opts.generatedAt ?? new Date()).toISOString();
  const lines: string[] = [];
  lines.push(`# ${systemName} — Activity Ledger`);
  lines.push('');
  lines.push(`_Generated ${generatedAt} from system_audit (${entries.length} row${entries.length === 1 ? '' : 's'})._`);
  lines.push('');
  lines.push(
    `Narrative projection of the hash-chained audit ledger. Inline entries are meaningful activity; per-day rollups summarise the dispatcher's housekeeping ticks. Every line carries an \`[actor]\` tag for federated rollup.`,
  );
  lines.push('');

  if (entries.length === 0) {
    lines.push('_No activity in window._');
    lines.push('');
    return lines.join('\n');
  }

  const byDay = groupByDay(entries);
  // Newest day first — what the brief wants to see at the top.
  const days = Array.from(byDay.keys()).sort().reverse();
  for (const day of days) {
    const dayEntries = byDay.get(day)!;
    lines.push(`## ${day}`);
    lines.push('');
    const inline = dayEntries.filter((e) => !e.rollup);
    const rolled = dayEntries.filter((e) => e.rollup);
    for (const e of inline) {
      lines.push(`- \`${e.time}\` **[${e.actor}]** ${e.narrative}`);
    }
    if (rolled.length > 0) {
      if (inline.length > 0) lines.push('');
      lines.push(`- _rollup:_ ${summariseRollups(rolled)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function groupByDay(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const m = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    const bucket = m.get(e.day);
    if (bucket) bucket.push(e);
    else m.set(e.day, [e]);
  }
  return m;
}

function summariseRollups(entries: LedgerEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const label = ROLLUP_LABEL[e.event] ?? e.event;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [label, n] of counts) parts.push(`${n} ${label}`);
  return parts.join(', ');
}

/**
 * Compose the full ledger doc and atomically write it to `outPath`. tmp+rename
 * guarantees that a brief reading the doc concurrently never sees a half-write.
 */
export function writeLedger(opts: RenderOptions = {}): { path: string; entries: number; bytes: number } {
  const path = opts.outPath ?? LEDGER_PATH;
  const rows = opts.rows ?? readAuditRowsSince(defaultSinceIso(opts));
  const entries = projectRows(rows);
  const body = renderMarkdown(entries, opts);
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
  return { path, entries: entries.length, bytes: Buffer.byteLength(body, 'utf8') };
}

function defaultSinceIso(opts: RenderOptions): string {
  if (opts.sinceIso) return opts.sinceIso;
  const days = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const ms = (opts.generatedAt ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}
