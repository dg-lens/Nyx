/**
 * Remote-actions poller (Tier-1 remote dispatch, v0.8).
 *
 * The operator portal writes rows into the Supabase table
 * `nyx_pending_actions` when an operator clicks "Queue task", "Resume",
 * or "Force tick". The dispatcher pulls those rows at the start of each
 * tick, validates + applies them locally, and writes the result back.
 *
 * Why poll instead of webhook: the dispatcher runs on the operator's
 * machine; exposing it as an HTTP endpoint is more attack surface (Tier 2).
 * Polling against Supabase (which the sync daemon already touches) reuses
 * the existing trust boundary. Latency is bounded by the launchd tick
 * cadence (15 min); good enough for MVP. A faster cadence daemon can be
 * added later if "Force tick" latency becomes a complaint.
 *
 * Schema (created by the portal-side migration, see your portal repo's
 * migrations/0007_nyx_pending_actions.sql):
 *
 *   nyx_pending_actions (
 *     id            uuid pk default gen_random_uuid(),
 *     action        text   in ('queue_task','resume_task','cancel_task','force_tick'),
 *     payload       jsonb  default '{}'::jsonb,
 *     requested_by  text,            -- employee email
 *     requested_at  timestamptz default now(),
 *     status        text   in ('pending','applied','failed','cancelled') default 'pending',
 *     applied_at    timestamptz,
 *     result        text             -- success message or error
 *   )
 *
 * The DB CHECK constraint on `action` is the actual allowlist; payload is
 * validated in code. If a row arrives with malformed payload, we mark it
 * status='failed' and continue with the rest — one bad action never blocks
 * the others.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { audit, resetFailureCount } from './audit.js';
import { config } from './config.js';
import { remoteActionsCircuitOpen } from './notifier.js';
import { submitDecision } from './pipeline/decide.js';
import type { DecisionKind } from './pipeline/types.js';

// ────────────────────────────────────────────────────────────────────────────
// Circuit breaker — suppresses 404 fetches after CIRCUIT_THRESHOLD consecutive
// failures. Once disabled, it stays disabled permanently until the operator
// deletes data/remote-actions-circuit.json. No auto-probe / no auto-reset.
// ────────────────────────────────────────────────────────────────────────────

const CIRCUIT_THRESHOLD = 3;

interface CircuitState {
  consecutive404s: number;
  disabled: boolean;          // true = permanently skip until operator deletes the file
  openedAt: string | null;    // ISO-8601 when circuit tripped; null = closed
  lastFailedAt: string | null; // ISO-8601 of last 404
}

let circuitPath: string = resolve(config.root, 'data', 'remote-actions-circuit.json');

/** Test seam — overrides the circuit-state JSON path (matches _setAuditDb pattern). */
export function _setCircuitPath(p: string): void {
  circuitPath = p;
}

let _supabaseUrlForTest: string | null = null;
let _supabaseKeyForTest: string | null = null;

/** Test seam — bypasses the frozen config so tests can exercise the poller without real Supabase creds. */
export function _setSupabaseConfig(url: string, key: string): void {
  _supabaseUrlForTest = url;
  _supabaseKeyForTest = key;
}

/** Test seam — clears the Supabase override. */
export function _clearSupabaseConfig(): void {
  _supabaseUrlForTest = null;
  _supabaseKeyForTest = null;
}

function readCircuitState(): CircuitState {
  try {
    const raw = JSON.parse(readFileSync(circuitPath, 'utf8')) as Record<string, unknown>;
    // Backward compat: old files have openedAt but no disabled field — treat openedAt set as disabled.
    const disabled = typeof raw.disabled === 'boolean' ? raw.disabled : raw.openedAt != null;
    return {
      consecutive404s: typeof raw.consecutive404s === 'number' ? raw.consecutive404s : 0,
      disabled,
      openedAt: typeof raw.openedAt === 'string' ? raw.openedAt : null,
      lastFailedAt: typeof raw.lastFailedAt === 'string' ? raw.lastFailedAt : null,
    };
  } catch {
    return { consecutive404s: 0, disabled: false, openedAt: null, lastFailedAt: null };
  }
}

function writeCircuitState(state: CircuitState): void {
  mkdirSync(dirname(circuitPath), { recursive: true });
  const tmp = `${circuitPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, circuitPath);
}

function clearCircuitState(): void {
  if (existsSync(circuitPath)) {
    try { unlinkSync(circuitPath); } catch { /* ignore */ }
  }
}

const KNOWN_ACTIONS = new Set([
  'queue_task',
  'resume_task',
  'cancel_task',
  'force_tick',
  // Pipeline gate decision (portal "go/revise/abort/proceed/fix/rollback").
  // NOTE: the portal-side CHECK constraint on nyx_pending_actions.action
  // must be extended to include 'pipeline_decision' (a portal migration) before
  // the portal can write these rows. This code-side allowlist is ready for them.
  'pipeline_decision',
]);

const DECISION_KINDS = new Set<DecisionKind>(['go', 'revise', 'abort', 'proceed', 'fix', 'rollback']);

interface PendingActionRow {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  requested_by: string | null;
  requested_at: string;
  status: string;
}

interface QueueTaskPayload {
  task_id: string;
  description: string;
  type: 'code' | 'content' | 'analysis' | 'assistant';
  model?: 'opus' | 'sonnet' | 'haiku';
  gate?: string;
  repo?: string;
  output?: string;
  depends?: string[];
  priority?: 'high' | 'normal' | 'low';
  slot?: number;
  every?: string;
  bw_project?: string;
  env_vars?: string[];
  expects?: string[];
}

/** Entry point: process every pending row. Returns the number applied. */
export async function processRemoteActions(): Promise<number> {
  // Normalize here too so the test seam (_setSupabaseConfig) can exercise this path
  // with raw Supabase dashboard URLs that include the /rest/v1 suffix.
  const supabaseUrl = (_supabaseUrlForTest ?? config.supabaseUrl)
    .replace(/\/+$/, '')
    .replace(/\/rest\/v\d+$/, '');
  const supabaseServiceKey = _supabaseKeyForTest ?? config.supabaseServiceKey;
  if (!supabaseUrl || !supabaseServiceKey) {
    // No Supabase config — remote dispatch isn't wired. No-op, no error.
    return 0;
  }

  const circuitState = readCircuitState();

  // Circuit permanently disabled — skip until operator deletes data/remote-actions-circuit.json.
  if (circuitState.disabled) {
    audit('remote.actions.circuit_skipped', 'remote-actions', {
      consecutive404s: circuitState.consecutive404s,
      openedAt: circuitState.openedAt,
      disabled: true,
    });
    return 0;
  }

  let rows: PendingActionRow[];
  try {
    rows = await fetchPending(supabaseUrl, supabaseServiceKey);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      const newConsecutive = circuitState.consecutive404s + 1;
      const now = new Date().toISOString();

      audit('remote.actions.fetch.not_found', 'remote-actions', {
        consecutive404s: newConsecutive,
      });

      if (newConsecutive >= CIRCUIT_THRESHOLD) {
        writeCircuitState({ consecutive404s: newConsecutive, disabled: true, openedAt: now, lastFailedAt: now });
        audit('remote.actions.circuit_open', 'remote-actions', { consecutive404s: newConsecutive });
        await remoteActionsCircuitOpen(newConsecutive);
      } else {
        writeCircuitState({ consecutive404s: newConsecutive, disabled: false, openedAt: null, lastFailedAt: now });
      }
      return 0;
    }

    // Non-404 HTTP error or network failure — existing path, circuit state untouched.
    audit('remote.actions.fetch.failed', 'remote-actions', {
      reason: (err as Error).message,
    });
    return 0;
  }

  // Successful fetch — clear any sub-threshold 404 counter.
  if (circuitState.consecutive404s > 0) {
    clearCircuitState();
  }

  if (rows.length === 0) return 0;

  audit('remote.actions.batch.started', 'remote-actions', { count: rows.length });

  let appliedCount = 0;
  for (const row of rows) {
    try {
      const result = await applyOne(row);
      await markAction(row.id, 'applied', result, supabaseUrl, supabaseServiceKey);
      audit('remote.actions.applied', 'remote-actions', {
        actionId: row.id,
        action: row.action,
        requested_by: row.requested_by,
        result,
      });
      appliedCount++;
    } catch (err) {
      const reason = (err as Error).message;
      await markAction(row.id, 'failed', reason, supabaseUrl, supabaseServiceKey).catch(() => {});
      audit('remote.actions.failed', 'remote-actions', {
        actionId: row.id,
        action: row.action,
        requested_by: row.requested_by,
        reason,
      });
    }
  }
  return appliedCount;
}

// ────────────────────────────────────────────────────────────────────────────
// Action handlers
// ────────────────────────────────────────────────────────────────────────────

async function applyOne(row: PendingActionRow): Promise<string> {
  if (!KNOWN_ACTIONS.has(row.action)) {
    throw new Error(`unknown action: ${row.action}`);
  }
  switch (row.action) {
    case 'queue_task':
      return applyQueueTask(row.payload as Partial<QueueTaskPayload>, row.requested_by);
    case 'resume_task':
      return applyResumeTask(row.payload, row.requested_by);
    case 'cancel_task':
      return applyCancelTask(row.payload, row.requested_by);
    case 'pipeline_decision':
      return applyPipelineDecision(row.payload, row.requested_by);
    case 'force_tick':
      // No-op — we're already in a tick. Just acknowledge.
      return 'noop: dispatcher tick already in progress';
    default:
      throw new Error(`no handler for action: ${row.action}`);
  }
}

function applyQueueTask(
  payload: Partial<QueueTaskPayload>,
  requestedBy: string | null,
): string {
  const taskId = payload.task_id?.trim();
  if (!taskId) throw new Error('queue_task: missing task_id');
  if (!/^[A-Z][A-Z0-9-]+$/.test(taskId)) {
    throw new Error(`queue_task: task_id ${JSON.stringify(taskId)} must be SHOUTING-KEBAB`);
  }
  const description = payload.description?.trim();
  if (!description) throw new Error('queue_task: missing description');
  const type = payload.type;
  if (!type || !['code', 'content', 'analysis', 'assistant'].includes(type)) {
    throw new Error(`queue_task: invalid type ${JSON.stringify(type)}`);
  }

  const current = readFileSync(config.queuePath, 'utf8');
  if (new RegExp(`^- \\[[ x]\\]\\s+${taskId}\\s`, 'm').test(current)) {
    return `task ${taskId} already in queue — nothing inserted`;
  }

  const block = renderTaskBlock(payload as QueueTaskPayload, requestedBy);
  const next = appendTaskBlock(current, block);
  // Atomic write: tmp + rename, matching the convention in CLAUDE.md.
  const tmp = `${config.queuePath}.tmp`;
  writeFileSync(tmp, next, 'utf8');
  renameSync(tmp, config.queuePath);
  return `task ${taskId} queued`;
}

function renderTaskBlock(p: QueueTaskPayload, requestedBy: string | null): string {
  const lines: string[] = [];
  lines.push(`- [ ] ${p.task_id} — ${p.description}`);
  const tagBits: string[] = [];
  tagBits.push(`[type: ${p.type}]`);
  if (p.model) tagBits.push(`[model: ${p.model}]`);
  if (p.gate) tagBits.push(`[gate: ${p.gate}]`);
  if (p.priority) tagBits.push(`[priority: ${p.priority}]`);
  lines.push(`      ${tagBits.join(' ')}`);

  const secondLineBits: string[] = [];
  if (p.repo) secondLineBits.push(`[repo: ${p.repo}]`);
  if (p.output) secondLineBits.push(`[output: ${p.output}]`);
  if (p.bw_project) secondLineBits.push(`[bw-project: ${p.bw_project}]`);
  if (typeof p.slot === 'number') secondLineBits.push(`[slot: ${p.slot}]`);
  if (p.every) secondLineBits.push(`[every: ${p.every}]`);
  if (p.depends && p.depends.length > 0) secondLineBits.push(`[depends: ${p.depends.join(', ')}]`);
  if (secondLineBits.length > 0) lines.push(`      ${secondLineBits.join(' ')}`);

  const thirdLineBits: string[] = [];
  if (p.env_vars && p.env_vars.length > 0) thirdLineBits.push(`[env: ${p.env_vars.join(', ')}]`);
  if (p.expects && p.expects.length > 0) thirdLineBits.push(`[expects: ${p.expects.join(', ')}]`);
  if (thirdLineBits.length > 0) lines.push(`      ${thirdLineBits.join(' ')}`);

  if (requestedBy) {
    lines.push(`      <!-- queued via portal by ${requestedBy} at ${new Date().toISOString()} -->`);
  }

  return lines.join('\n');
}

function appendTaskBlock(current: string, block: string): string {
  // Insert immediately before the `## Completed` header if present so the
  // task lands at the bottom of Active. Otherwise append to end.
  const completedMatch = current.match(/^## Completed/m);
  if (completedMatch) {
    const idx = completedMatch.index!;
    return `${current.slice(0, idx).trimEnd()}\n\n${block}\n\n${current.slice(idx)}`;
  }
  return `${current.trimEnd()}\n\n${block}\n`;
}

function applyResumeTask(payload: Record<string, unknown>, _requestedBy: string | null): string {
  const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
  if (!taskId) throw new Error('resume_task: missing task_id');
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  resetFailureCount(taskId, note || 'resumed via portal (no note)');
  audit('task.resumed', 'remote-actions', {
    taskId,
    note: note || null,
    source: 'portal',
  });
  return `task ${taskId} resumed${note ? ` (note: ${note.slice(0, 80)})` : ''}`;
}

function applyCancelTask(payload: Record<string, unknown>, _requestedBy: string | null): string {
  const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
  if (!taskId) throw new Error('cancel_task: missing task_id');
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  resetFailureCount(taskId, `cancelled via portal: ${reason || 'no reason given'}`);
  audit('task.cancelled', 'remote-actions', {
    taskId,
    reason: reason || null,
    source: 'portal',
  });
  return `task ${taskId} cancelled${reason ? ` (reason: ${reason.slice(0, 80)})` : ''}`;
}

/**
 * Pipeline gate decision from the portal. Payload: `{ run_id, kind, note? }`.
 * Routes through the same `submitDecision` chokepoint the CLI uses, so portal +
 * CLI reject identical illegal decisions. A rejected decision throws → the row
 * marks status='failed' with the reason, surfacing back to the portal.
 */
function applyPipelineDecision(payload: Record<string, unknown>, _requestedBy: string | null): string {
  const runId = typeof payload.run_id === 'string' ? payload.run_id.trim() : '';
  if (!runId) throw new Error('pipeline_decision: missing run_id');
  const kind = typeof payload.kind === 'string' ? payload.kind.trim() : '';
  if (!DECISION_KINDS.has(kind as DecisionKind)) {
    throw new Error(`pipeline_decision: invalid kind ${JSON.stringify(kind)}`);
  }
  const note = typeof payload.note === 'string' ? payload.note : '';
  const result = submitDecision(runId, kind as DecisionKind, { note, source: 'portal' });
  if (!result.ok) throw new Error(`pipeline_decision: ${result.message}`);
  return result.message;
}

// ────────────────────────────────────────────────────────────────────────────
// Supabase REST plumbing (direct, no SDK — matches apps/sync style)
// ────────────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`fetchPending: ${status} ${statusText}`);
  }
}

function authHeaders(key: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

async function fetchPending(url: string, key: string): Promise<PendingActionRow[]> {
  const res = await fetch(
    `${url}/rest/v1/nyx_pending_actions?status=eq.pending&order=requested_at.asc&limit=50`,
    { method: 'GET', headers: authHeaders(key) },
  );
  if (!res.ok) {
    throw new HttpError(res.status, res.statusText);
  }
  const data = (await res.json()) as PendingActionRow[];
  return data;
}

async function markAction(
  id: string,
  status: 'applied' | 'failed' | 'cancelled',
  result: string,
  url: string,
  key: string,
): Promise<void> {
  const res = await fetch(
    `${url}/rest/v1/nyx_pending_actions?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { ...authHeaders(key), Prefer: 'return=minimal' },
      body: JSON.stringify({
        status,
        applied_at: new Date().toISOString(),
        result: result.slice(0, 2000),
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`markAction(${id}): ${res.status} ${res.statusText}`);
  }
}
