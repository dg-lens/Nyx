import { randomBytes } from 'node:crypto';
import { makePool, applyMigration } from './db.js';
import { hashToken } from './auth.js';

/**
 * Platform admin — create the per-platform bearer tokens the relay authenticates.
 * The raw token is printed ONCE; only its sha256 is stored. Put the raw token in
 * Bitwarden and on the consuming instance (its NYX_ARACHNE_TOKEN).
 *
 *   node dist/admin.js add-platform <id> <name> <scope1,scope2,...>
 *   node dist/admin.js list
 *
 * Scopes: read write gate_push gate_review
 */
async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = makePool(url);
  await applyMigration(pool);

  const [cmd, id, name, scopesCsv] = process.argv.slice(2);

  if (cmd === 'add-platform') {
    if (!id || !name) throw new Error('usage: add-platform <id> <name> <scope1,scope2,...>');
    const scopes = (scopesCsv ?? 'read,write').split(',').map((s) => s.trim()).filter(Boolean);
    const token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO platforms (id, name, token_hash, scopes) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, token_hash=EXCLUDED.token_hash, scopes=EXCLUDED.scopes`,
      [id, name, hashToken(token), scopes],
    );
    console.log(`platform '${id}' upserted with scopes [${scopes.join(', ')}]`);
    console.log(`RAW TOKEN (shown once — store in Bitwarden + set as NYX_ARACHNE_TOKEN on ${id}'s box):`);
    console.log(token);
  } else if (cmd === 'list') {
    const { rows } = await pool.query<{ id: string; name: string; scopes: string[] }>(
      'SELECT id, name, scopes FROM platforms ORDER BY id',
    );
    for (const r of rows) console.log(`${r.id}\t${r.name}\t[${(r.scopes ?? []).join(', ')}]`);
  } else {
    console.log('usage: add-platform <id> <name> <scopes-csv> | list');
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch((e: unknown) => {
  console.error('[arachne-admin]', (e as Error).message);
  process.exit(1);
});
