import { createHash } from 'node:crypto';
import type { Pool } from './db.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface Platform {
  id: string;
  name: string;
  scopes: string[];
}

/** Resolve a bearer token to a platform via token_hash, or null. Raw tokens live
 * in Bitwarden; only the sha256 is stored. */
export async function verifyToken(pool: Pool, token: string | undefined): Promise<Platform | null> {
  if (!token) return null;
  const { rows } = await pool.query<{ id: string; name: string; scopes: string[] }>(
    'SELECT id, name, scopes FROM platforms WHERE token_hash = $1',
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}
