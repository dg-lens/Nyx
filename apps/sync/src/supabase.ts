import { config } from './config.js';

/**
 * Minimal Supabase REST client — just enough surface to upsert audit rows,
 * insert queue snapshots, and update the dispatcher_status singleton.
 *
 * Why not the @supabase/supabase-js SDK? The SDK pulls in node-fetch and a
 * realtime websocket client we don't use here. Direct REST keeps the dependency
 * tree minimal and the failure modes obvious.
 */

const COMMON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  // Anything from the sync daemon goes in as service_role, bypassing RLS.
  apikey: '',
  Authorization: '',
};

function initHeaders(): Record<string, string> {
  COMMON_HEADERS['apikey'] = config.supabaseServiceKey;
  COMMON_HEADERS['Authorization'] = `Bearer ${config.supabaseServiceKey}`;
  return COMMON_HEADERS;
}

async function request(path: string, init: RequestInit & { prefer?: string }): Promise<Response> {
  const headers = { ...initHeaders(), ...(init.headers as Record<string, string> | undefined) };
  if (init.prefer) headers['Prefer'] = init.prefer;
  const res = await fetch(`${config.supabaseUrl}/rest/v1${path}`, { ...init, headers });
  return res;
}

async function expectOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '<unreadable>');
  throw new Error(`Supabase ${context} failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`);
}

export interface AuditRowToSync {
  id: number;
  at: string;
  event: string;
  actor: string;
  payload: unknown;
  row_hash: string;
  prev_hash: string;
}

/**
 * Upsert audit rows by `id`. Idempotent — re-running the same batch is a no-op.
 * Returns the number of rows the server confirms.
 */
export async function pushAuditRows(rows: AuditRowToSync[]): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await request(`/system_audit?on_conflict=id`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(
      rows.map(r => ({
        ...r,
        // Local payload is JSON-stringified text; Supabase wants real jsonb.
        // The audit module already parses payload to an object when querying,
        // but the SQLite text storage is what we read from. We pass through whatever's there.
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
      })),
    ),
  });
  await expectOk(res, 'pushAuditRows');
  return rows.length;
}

export interface QueueSnapshotPayload {
  active: unknown[];
  completed: unknown[];
}

/** Insert a new queue snapshot. Returns the new row's id (for logging only). */
export async function pushQueueSnapshot(snap: QueueSnapshotPayload): Promise<number | null> {
  const res = await request(`/queue_snapshot`, {
    method: 'POST',
    prefer: 'return=representation',
    body: JSON.stringify({ active: snap.active, completed: snap.completed }),
  });
  await expectOk(res, 'pushQueueSnapshot');
  const body = (await res.json()) as Array<{ id: number }>;
  return body[0]?.id ?? null;
}

export interface DispatcherStatusUpdate {
  last_tick_at: string | null;
  last_success_at: string | null;
  audit_row_count: number;
  chain_ok: boolean;
  success_rate_24h: number | null;
  current_slot: number;
  notes?: Record<string, unknown>;
}

/**
 * Upsert the singleton dispatcher_status row (id = 1).
 * Returns `true` on success so the caller's retry wrapper can distinguish
 * "completed normally" (truthy) from "exhausted retries" (null).
 */
export async function pushDispatcherStatus(s: DispatcherStatusUpdate): Promise<true> {
  const res = await request(`/dispatcher_status?on_conflict=id`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      id: 1,
      updated_at: new Date().toISOString(),
      last_tick_at: s.last_tick_at,
      last_success_at: s.last_success_at,
      audit_row_count: s.audit_row_count,
      chain_ok: s.chain_ok,
      success_rate_24h: s.success_rate_24h,
      current_slot: s.current_slot,
      notes: s.notes ?? {},
    }),
  });
  await expectOk(res, 'pushDispatcherStatus');
  return true;
}

/** Health check — used at startup to fail fast if Supabase credentials are wrong. */
export async function ping(): Promise<{ ok: true; sampleCount: number } | { ok: false; reason: string }> {
  try {
    const res = await request(`/system_audit?select=id&limit=1`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      return { ok: false, reason: `${res.status} ${res.statusText}: ${body.slice(0, 200)}` };
    }
    const rows = (await res.json()) as Array<{ id: number }>;
    return { ok: true, sampleCount: rows.length };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
