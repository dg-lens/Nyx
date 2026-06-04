import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  readQueue,
  slotOf,
  slotWindow,
  SLOTS_PER_DAY,
  MINUTES_PER_SLOT,
} from '@nyx/dispatcher/dist/task-reader.js';
import type { ParsedTask } from '@nyx/dispatcher/dist/types.js';

// ── Config ──────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env['DASHBOARD_PORT'] ?? '8767', 10);
const HOST = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';
const NYX_ROOT = process.env['NYX_REPO_ROOT'] ?? resolve(import.meta.dirname, '..', '..', '..');
const HTML_PATH = resolve(NYX_ROOT, 'nyx-dashboard.html');
const QUEUE_PATH = resolve(NYX_ROOT, 'nyx.md');
const DB_PATH = resolve(NYX_ROOT, 'data', 'nyx.db');
const LOCKFILE = '/tmp/nyx-dispatch.lock';
const FINALIZE_SENTINEL = '/tmp/nyx-finalize-in-progress.json';

// ── JSON helpers ────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isString = typeof body === 'string';
  const payload = isString ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isString ? headers['Content-Type'] ?? 'text/plain' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  send(res, status, { error: message });
}

// ── Audit DB helpers ────────────────────────────────────────────────

interface AuditEvent {
  id: number;
  at: string;
  event: string;
  actor: string;
  payload: Record<string, unknown>;
}

function openDb(): DatabaseSync | null {
  if (!existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  return db;
}

function recentEvents(n: number): AuditEvent[] {
  const db = openDb();
  if (!db) return [];
  try {
    const rows = db
      .prepare(`SELECT id, at, event, actor, payload FROM system_audit ORDER BY id DESC LIMIT ?`)
      .all(n) as Array<{ id: number; at: string; event: string; actor: string; payload: string }>;
    return rows.map(r => ({
      id: r.id,
      at: r.at,
      event: r.event,
      actor: r.actor,
      payload: parseJsonSafe(r.payload),
    }));
  } finally {
    db.close();
  }
}

function parseJsonSafe(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function auditRowCount(): number {
  const db = openDb();
  if (!db) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM system_audit`).get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function lastEventAt(event: string): string | null {
  const db = openDb();
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT at FROM system_audit WHERE event = ? ORDER BY id DESC LIMIT 1`)
      .get(event) as { at: string } | undefined;
    return row?.at ?? null;
  } finally {
    db.close();
  }
}

function successRate24h(): number | null {
  const db = openDb();
  if (!db) return null;
  try {
    const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const c = db
      .prepare(`SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.completed' AND at > ?`)
      .get(dayAgo) as { n: number };
    const f = db
      .prepare(`SELECT COUNT(*) AS n FROM system_audit WHERE event = 'task.failed' AND at > ?`)
      .get(dayAgo) as { n: number };
    const total = c.n + f.n;
    if (total === 0) return null;
    return c.n / total;
  } finally {
    db.close();
  }
}

// Cheap pass-through chain check: read all hashes, recompute, return ok/breakRow.
// Imported logic from dispatcher's audit.verifyChain so the dashboard doesn't take
// a runtime dep on the dispatcher's audit module (which opens the DB read/write).
import { createHash } from 'node:crypto';
const GENESIS = '0'.repeat(64);
function verifyChain(): { ok: boolean; firstBadRowId?: number; totalRows: number } {
  const db = openDb();
  if (!db) return { ok: true, totalRows: 0 };
  try {
    const rows = db
      .prepare(`SELECT id, at, event, actor, payload, row_hash, prev_hash FROM system_audit ORDER BY id ASC`)
      .all() as Array<{ id: number; at: string; event: string; actor: string; payload: string; row_hash: string; prev_hash: string }>;
    let expected = GENESIS;
    for (const r of rows) {
      if (r.prev_hash !== expected) return { ok: false, firstBadRowId: r.id, totalRows: rows.length };
      const h = createHash('sha256').update(`${r.at}\n${r.event}\n${r.actor}\n${r.payload}\n${r.prev_hash}`).digest('hex');
      if (h !== r.row_hash) return { ok: false, firstBadRowId: r.id, totalRows: rows.length };
      expected = r.row_hash;
    }
    return { ok: true, totalRows: rows.length };
  } finally {
    db.close();
  }
}

// ── Task serialization ──────────────────────────────────────────────

interface TaskJson {
  id: string;
  description: string;
  type: ParsedTask['type'];
  model: ParsedTask['model'];
  gates: ParsedTask['gates'];
  priority: ParsedTask['priority'];
  repo?: string;
  output?: string;
  depends?: string[];
  checked: boolean;
  invalidTags: ParsedTask['invalidTags'];
  /** Slot number (0..95) if [slot: N] is set. */
  slot?: number;
  /** Step in slots if [every: K] is set. */
  everySlots?: number;
  /** Human-readable every label, e.g. "3h" or "15m". */
  every?: string;
  /** Set on completed tasks if a completion metadata line was captured. */
  completionLine?: string;
  /** Parsed `[completed: ISO8601]` timestamp, if present. */
  completedAt?: string;
}

function everyLabel(stepSlots: number): string {
  const min = stepSlots * MINUTES_PER_SLOT;
  if (min < 60) return `${min}m`;
  if (min % 1440 === 0) return `${min / 1440}d`;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

function extractCompletionMeta(rawLines: string[]): { completionLine?: string; completedAt?: string } {
  for (const line of rawLines) {
    const m = line.match(/\[completed:\s*([^\]]+)\]/);
    if (m) {
      const completedAt = (m[1] ?? '').trim();
      return { completionLine: line.trim(), completedAt };
    }
  }
  return {};
}

function toTaskJson(t: ParsedTask): TaskJson {
  const completion = extractCompletionMeta(t.rawLines);
  return {
    id: t.id,
    description: t.description,
    type: t.type,
    model: t.model,
    gates: t.gates,
    priority: t.priority,
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.output ? { output: t.output } : {}),
    ...(t.depends ? { depends: t.depends } : {}),
    checked: t.checked,
    invalidTags: t.invalidTags,
    ...(typeof t.slot === 'number' ? { slot: t.slot } : {}),
    ...(typeof t.everyStepSlots === 'number' ? { everySlots: t.everyStepSlots, every: everyLabel(t.everyStepSlots) } : {}),
    ...(completion.completionLine ? { completionLine: completion.completionLine } : {}),
    ...(completion.completedAt ? { completedAt: completion.completedAt } : {}),
  };
}

// ── Running-task detection ──────────────────────────────────────────

function lockfilePid(): number | null {
  if (!existsSync(LOCKFILE)) return null;
  try {
    const raw = readFileSync(LOCKFILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === 'EPERM';
  }
}

/**
 * Reconstruct the currently-running task from the audit DB.
 *
 * Strategy: find the most recent `task.started` for which no matching
 * `task.completed` / `task.failed` / `task.abandoned` exists. If the
 * dispatcher's lockfile is held by a live process, this is "running".
 * Otherwise the audit row is stale and we ignore it.
 */
function findRunningTask(): {
  taskId: string;
  type?: string;
  model?: string;
  description?: string;
  startedAt?: string;
  durationMs?: number;
  stages?: Array<{ name: string; status: 'ok' | 'running' | 'pending'; detail?: string }>;
} | null {
  const pid = lockfilePid();
  if (pid == null || !pidAlive(pid)) return null;

  const db = openDb();
  if (!db) return null;
  try {
    const started = db
      .prepare(`SELECT at, payload FROM system_audit WHERE event = 'task.started' ORDER BY id DESC LIMIT 1`)
      .get() as { at: string; payload: string } | undefined;
    if (!started) return null;

    const startedPayload = parseJsonSafe(started.payload);
    const taskId = String(startedPayload['taskId'] ?? '');
    if (!taskId) return null;

    // Has it terminated?
    const term = db
      .prepare(
        `SELECT event FROM system_audit
         WHERE at > ? AND json_extract(payload, '$.taskId') = ?
           AND event IN ('task.completed', 'task.failed', 'task.abandoned')
         LIMIT 1`,
      )
      .get(started.at, taskId);
    if (term) return null;

    // Find stage progress from audit rows since start.
    const sinceStart = db
      .prepare(
        `SELECT event, payload FROM system_audit
         WHERE at >= ? AND json_extract(payload, '$.taskId') = ?
         ORDER BY id ASC`,
      )
      .all(started.at, taskId) as Array<{ event: string; payload: string }>;

    const claudeExited = sinceStart.find(r => r.event === 'task.claude.exited');
    const gateDone = sinceStart.find(r => r.event === 'task.gate.completed');
    const stages: Array<{ name: string; status: 'ok' | 'running' | 'pending'; detail?: string }> = [];
    if (claudeExited) {
      const p = parseJsonSafe(claudeExited.payload);
      const ms = Number(p['durationMs'] ?? 0);
      const exit = p['exitCode'];
      stages.push({ name: 'claude', status: 'ok', detail: `exit ${exit} · ${(ms / 1000).toFixed(0)}s` });
    } else {
      stages.push({ name: 'claude', status: 'running' });
    }
    if (claudeExited) {
      if (gateDone) {
        const p = parseJsonSafe(gateDone.payload);
        const passed = p['passed'] === true;
        stages.push({ name: 'gate', status: passed ? 'ok' : 'pending', detail: passed ? 'passed' : 'failed' });
      } else {
        stages.push({ name: 'gate', status: 'running' });
      }
    }

    return {
      taskId,
      type: String(startedPayload['type'] ?? ''),
      model: String(startedPayload['model'] ?? ''),
      startedAt: started.at,
      durationMs: Date.now() - new Date(started.at).getTime(),
      stages,
    };
  } finally {
    db.close();
  }
}

// ── Endpoints ───────────────────────────────────────────────────────

function handleApiQueue(_req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(QUEUE_PATH)) {
    sendError(res, 404, 'queue file not found');
    return;
  }
  const q = readQueue(QUEUE_PATH);
  send(res, 200, {
    active: q.active.map(toTaskJson),
    completed: q.completed.map(toTaskJson),
  });
}

function handleApiAudit(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const n = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('n') ?? '80', 10) || 80));
  const events = recentEvents(n);
  send(res, 200, { events });
}

function handleApiStatus(_req: IncomingMessage, res: ServerResponse): void {
  // launchctl state — best-effort via process check; reading the plist file is
  // not enough since `unload` removes the entry without changing the file.
  const launchdLoaded = (() => {
    try {
      const { execSync } = require('node:child_process') as typeof import('node:child_process');
      const out = execSync('launchctl list', { encoding: 'utf8' });
      return /nyx\.dispatcher/i.test(out);
    } catch {
      return false;
    }
  })();

  const chain = verifyChain();
  const lastTickRaw = lastEventAt('dispatch.tick');
  const lastTickAgo = lastTickRaw
    ? (() => {
        const dt = (Date.now() - new Date(lastTickRaw).getTime()) / 1000;
        if (dt < 60) return `${Math.round(dt)}s`;
        if (dt < 3600) return `${Math.round(dt / 60)}m`;
        return `${Math.round(dt / 3600)}h`;
      })()
    : null;

  send(res, 200, {
    launchdLoaded,
    chainOk: chain.ok,
    ...(chain.firstBadRowId ? { chainBrokenAtRow: chain.firstBadRowId } : {}),
    auditRowCount: chain.totalRows,
    lastTickAt: lastTickRaw,
    lastTickAgo,
    lastSuccessAt: lastEventAt('task.completed'),
    successRate24h: successRate24h(),
    currentSlot: slotOf(),
    slotsPerDay: SLOTS_PER_DAY,
    minutesPerSlot: MINUTES_PER_SLOT,
    maxChainDepth: Number.parseInt(process.env['MAX_CHAIN_DEPTH'] ?? '2', 10),
    finalizeSentinelPresent: existsSync(FINALIZE_SENTINEL),
  });
}

function handleApiRunning(_req: IncomingMessage, res: ServerResponse): void {
  const running = findRunningTask();
  if (!running) {
    send(res, 200, null);
    return;
  }
  // Attach description from the queue if we can find it.
  try {
    const q = readQueue(QUEUE_PATH);
    const t = q.active.find(t => t.id === running.taskId);
    if (t) {
      (running as { description?: string }).description = t.description;
    }
  } catch { /* ignore */ }
  send(res, 200, running);
}

function handleApiHealth(_req: IncomingMessage, res: ServerResponse): void {
  send(res, 200, {
    ok: true,
    port: PORT,
    queuePathExists: existsSync(QUEUE_PATH),
    dbPathExists: existsSync(DB_PATH),
    htmlPathExists: existsSync(HTML_PATH),
  });
}

function serveHtml(_req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(HTML_PATH)) {
    sendError(res, 500, `dashboard HTML not found at ${HTML_PATH}`);
    return;
  }
  const html = readFileSync(HTML_PATH);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

// ── Router ──────────────────────────────────────────────────────────

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/api/queue': handleApiQueue,
  '/api/audit': handleApiAudit,
  '/api/status': handleApiStatus,
  '/api/running': handleApiRunning,
  '/api/health': handleApiHealth,
  '/': serveHtml,
};

export function startServer(): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const handler = ROUTES[url.pathname];
    if (!handler) {
      sendError(res, 404, 'not found');
      return;
    }
    try {
      handler(req, res);
    } catch (err) {
      const e = err as Error;
      console.error('[dashboard] handler error:', e.stack ?? e.message);
      sendError(res, 500, e.message);
    }
  });

  server.listen(PORT, HOST, () => {
    const url = `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}/`;
    console.log(`[nyx-dashboard] listening on ${url}`);
    console.log(`[nyx-dashboard] serving ${HTML_PATH}`);
    console.log(`[nyx-dashboard] reading queue: ${QUEUE_PATH}`);
    console.log(`[nyx-dashboard] reading audit: ${DB_PATH}`);
  });

  const shutdown = (sig: string) => {
    console.log(`[nyx-dashboard] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
