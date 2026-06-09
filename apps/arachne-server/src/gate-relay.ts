import type { Pool } from './db.js';

export interface GateInput {
  id: string;
  reviewer: string;
  run_id: string;
  task_id?: string;
  repo?: string;
  gate_kind: 'preview' | 'review';
  summary?: string;
  options?: string[];
}

export interface Gate {
  id: string;
  origin: string;
  reviewer: string;
  run_id: string;
  task_id: string;
  repo: string | null;
  gate_kind: string;
  summary: string;
  options: string[];
  status: string;
  decision: string | null;
  note: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export const PREVIEW_VERBS = ['go', 'revise', 'abort'];
export const REVIEW_VERBS = ['accept', 'proceed', 'fix', 'rollback', 'abort'];

/** Verbs that require an explanatory note. */
export const NOTE_REQUIRED = new Set(['revise', 'fix']);

/** Default allowed verbs for a gate kind when the pusher omits options. */
export function defaultOptions(kind: string): string[] {
  return kind === 'preview' ? [...PREVIEW_VERBS] : [...REVIEW_VERBS];
}

/** Validate a decision against a gate's allowed options + note requirement.
 * Pure — unit-tested without a DB. */
export function validateDecision(
  options: string[],
  decision: string,
  note: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!options.includes(decision)) {
    return { ok: false, error: `decision '${decision}' not allowed; options: ${options.join(', ')}` };
  }
  if (NOTE_REQUIRED.has(decision) && !(note && note.trim())) {
    return { ok: false, error: `decision '${decision}' requires a note` };
  }
  return { ok: true };
}

function toGate(r: Record<string, unknown>): Gate {
  return {
    id: r['id'] as string,
    origin: r['origin'] as string,
    reviewer: r['reviewer'] as string,
    run_id: r['run_id'] as string,
    task_id: (r['task_id'] as string) ?? '',
    repo: (r['repo'] as string) ?? null,
    gate_kind: r['gate_kind'] as string,
    summary: (r['summary'] as string) ?? '',
    options: (r['options'] as string[]) ?? [],
    status: r['status'] as string,
    decision: (r['decision'] as string) ?? null,
    note: (r['note'] as string) ?? null,
    decided_by: (r['decided_by'] as string) ?? null,
    created_at: String(r['created_at']),
    decided_at: r['decided_at'] ? String(r['decided_at']) : null,
  };
}

/** Origin pushes a gate brief. Upsert by (origin, id) so a re-push (retry) is
 * idempotent and never clobbers a decision already made — AND so one gate_push
 * platform can never absorb/hijack another origin's gate id (M9: cross-origin
 * squat). `origin` is the AUTHENTICATED platform identity (server passes
 * platform.id, not a client param), so a foreign-origin row keyed on the same
 * id is rejected rather than silently retargeted. */
export async function pushGate(
  pool: Pool, g: GateInput, origin: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string; code: number }> {
  const options = g.options && g.options.length ? g.options : defaultOptions(g.gate_kind);
  // A pre-existing row under this id owned by a DIFFERENT origin must never be
  // touched. The ON CONFLICT WHERE below already refuses to mutate it, but we
  // return an explicit error instead of a silent no-op so the caller learns the
  // id is squatted rather than believing its push landed.
  const existing = await pool.query(`SELECT origin FROM gates WHERE id = $1`, [g.id]);
  const owner = existing.rows[0] ? (existing.rows[0] as { origin: string }).origin : null;
  if (owner !== null && owner !== origin) {
    return { ok: false, error: 'gate id belongs to another origin', code: 409 };
  }
  await pool.query(
    `INSERT INTO gates (id, origin, reviewer, run_id, task_id, repo, gate_kind, summary, options, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')
     ON CONFLICT (id) DO UPDATE SET
       summary = EXCLUDED.summary, options = EXCLUDED.options
       WHERE gates.status = 'open' AND gates.origin = EXCLUDED.origin`,
    [g.id, origin, g.reviewer, g.run_id, g.task_id ?? '', g.repo ?? null, g.gate_kind, g.summary ?? '', options],
  );
  return { ok: true, id: g.id };
}

/** Reviewer inbox: open gates assigned to this reviewer. */
export async function inboxGates(pool: Pool, reviewer: string): Promise<Gate[]> {
  const { rows } = await pool.query(
    `SELECT * FROM gates WHERE reviewer = $1 AND status = 'open' ORDER BY created_at ASC`,
    [reviewer],
  );
  return rows.map(toGate);
}

/** Reviewer decides. Only the assigned reviewer may decide, only while open. */
export async function decideGate(
  pool: Pool, id: string, reviewer: string, decision: string, note: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string; code: number }> {
  const { rows } = await pool.query(`SELECT * FROM gates WHERE id = $1`, [id]);
  const gate = rows[0] ? toGate(rows[0]) : null;
  if (!gate) return { ok: false, error: 'no such gate', code: 404 };
  if (gate.reviewer !== reviewer) return { ok: false, error: 'not your gate to review', code: 403 };
  if (gate.status !== 'open') return { ok: false, error: `gate is '${gate.status}', not open`, code: 409 };
  const v = validateDecision(gate.options, decision, note);
  if (!v.ok) return { ok: false, error: v.error, code: 400 };
  await pool.query(
    `UPDATE gates SET status='decided', decision=$2, note=$3, decided_by=$4, decided_at=now() WHERE id=$1`,
    [id, decision, note ?? null, reviewer],
  );
  return { ok: true };
}

/** Origin poll: decided-but-unconsumed gates owned by this origin. */
export async function decidedGates(pool: Pool, origin: string): Promise<Gate[]> {
  const { rows } = await pool.query(
    `SELECT * FROM gates WHERE origin = $1 AND status = 'decided' ORDER BY decided_at ASC`,
    [origin],
  );
  return rows.map(toGate);
}

/** Origin marks a decided gate consumed after applying it locally. */
export async function consumeGate(pool: Pool, id: string, origin: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE gates SET status='consumed', consumed_at=now() WHERE id=$1 AND origin=$2 AND status='decided'`,
    [id, origin],
  );
  return (rowCount ?? 0) > 0;
}

export async function getGate(pool: Pool, id: string): Promise<Gate | null> {
  const { rows } = await pool.query(`SELECT * FROM gates WHERE id = $1`, [id]);
  return rows[0] ? toGate(rows[0]) : null;
}
