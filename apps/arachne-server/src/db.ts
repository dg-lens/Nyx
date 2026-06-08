import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type { NodeMeta } from './assemble.js';

export type Pool = pg.Pool;
export function makePool(connectionString: string): Pool {
  return new pg.Pool({ connectionString });
}

const here = dirname(fileURLToPath(import.meta.url));

/** Apply the idempotent schema (re-run safe). Used by tests + first boot. */
export async function applyMigration(pool: Pool): Promise<void> {
  const sql = readFileSync(join(here, '..', 'migrations', '0001_init.sql'), 'utf8');
  await pool.query(sql);
}

interface Row {
  id: string; kind: string; title: string; summary: string; body: string;
  loc: string[]; concern: string[]; load_tier: NodeMeta['load']; audience: string[];
  weight: number; paths: string[]; symbols: string[]; triggers: string[];
  status: string; tokens: number;
}
function toMeta(r: Row): NodeMeta {
  return {
    id: r.id, kind: r.kind, title: r.title, summary: r.summary, body: r.body,
    loc: r.loc ?? [], concern: r.concern ?? [], load: r.load_tier, audience: (r.audience ?? ['all']) as NodeMeta['audience'],
    weight: r.weight, paths: r.paths ?? [], symbols: r.symbols ?? [], triggers: r.triggers ?? [],
    status: r.status, tokens: r.tokens,
  };
}

/** All active nodes as an in-memory index (assemble/search run in-process — fine
 * at corpus scale; push filtering to SQL when it grows). */
export async function loadActiveNodes(pool: Pool): Promise<NodeMeta[]> {
  const { rows } = await pool.query<Row>(`SELECT * FROM nodes WHERE status = 'active'`);
  return rows.map(toMeta);
}

export async function getNode(pool: Pool, id: string): Promise<NodeMeta | null> {
  const { rows } = await pool.query<Row>(`SELECT * FROM nodes WHERE id = $1`, [id]);
  return rows[0] ? toMeta(rows[0]) : null;
}

export interface WriteInput {
  id: string; kind: string; title: string; summary: string; body: string;
  loc?: string[]; concern?: string[]; load?: string; audience?: string[];
  weight?: number; paths?: string[]; symbols?: string[]; triggers?: string[];
  edges?: Record<string, string[]>;
}

/** Inbound write: upsert a node (provenance platform:<id>, review pending),
 * replace its edges, append a write-log row. Returns the node id. */
export async function writeNode(pool: Pool, n: WriteInput, platform: string): Promise<string> {
  const id = n.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const tokens = Math.max(1, Math.ceil((n.body || '').length / 4));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existed = (await client.query('SELECT 1 FROM nodes WHERE id = $1', [id])).rowCount ?? 0;
    await client.query(
      `INSERT INTO nodes (id, kind, title, summary, body, loc, concern, load_tier, audience, weight,
         paths, symbols, triggers, status, provenance, confidence, review, tokens, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14,'medium','pending',$15, now())
       ON CONFLICT (id) DO UPDATE SET
         kind=EXCLUDED.kind, title=EXCLUDED.title, summary=EXCLUDED.summary, body=EXCLUDED.body,
         loc=EXCLUDED.loc, concern=EXCLUDED.concern, load_tier=EXCLUDED.load_tier, audience=EXCLUDED.audience,
         weight=EXCLUDED.weight, paths=EXCLUDED.paths, symbols=EXCLUDED.symbols, triggers=EXCLUDED.triggers,
         tokens=EXCLUDED.tokens, updated_at=now()`,
      [id, n.kind, n.title, n.summary, n.body ?? '', n.loc ?? [], n.concern ?? [], n.load ?? 'match',
       n.audience ?? ['all'], n.weight ?? 4, n.paths ?? [], n.symbols ?? [], n.triggers ?? [],
       `platform:${platform}`, tokens],
    );
    await client.query('DELETE FROM edges WHERE src_id = $1', [id]);
    for (const [rel, targets] of Object.entries(n.edges ?? {})) {
      for (const t of targets) {
        if (t) await client.query('INSERT INTO edges (src_id, rel, dst_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, rel, t]);
      }
    }
    await client.query('INSERT INTO write_log (node_id, platform, op) VALUES ($1,$2,$3)', [id, platform, existed ? 'update' : 'create']);
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function recordUsage(
  pool: Pool, nodeIds: string[], platform: string, cited: boolean | null, outcome: string | null,
): Promise<void> {
  for (const id of nodeIds) {
    await pool.query('INSERT INTO node_usage (node_id, platform, cited, task_outcome) VALUES ($1,$2,$3,$4)', [id, platform, cited, outcome]);
  }
}
