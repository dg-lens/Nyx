import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assemble, search, type Directive, type SearchQuery } from './assemble.js';
import { makePool, applyMigration, loadActiveNodes, getNode, writeNode, recordUsage, type Pool, type WriteInput } from './db.js';
import { bearer, verifyToken, type Platform } from './auth.js';

function send(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); if (raw.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

/** The request handler (testable without binding a port). */
export function makeHandler(pool: Pool) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (path === '/health') return send(res, 200, { ok: true });

      const platform: Platform | null = await verifyToken(pool, bearer(req.headers['authorization']));
      if (!platform) return send(res, 401, { error: 'unauthorized' });
      const canWrite = platform.scopes.includes('write');

      if (method === 'POST' && path === '/pack') {
        const d = (await readBody(req)) as Directive | null;
        if (!d || typeof d.loc !== 'string') return send(res, 400, { error: 'pack needs {loc, role, paths, text, budget}' });
        const index = await loadActiveNodes(pool);
        const pack = assemble(index, { loc: d.loc, role: d.role ?? 'all', paths: d.paths ?? [], text: d.text ?? '', budget: d.budget ?? 1800 });
        await recordUsage(pool, pack.ids, platform.id, null, null).catch(() => {});
        return send(res, 200, pack);
      }

      if (method === 'POST' && path === '/search') {
        const q = (await readBody(req)) as SearchQuery | null;
        const index = await loadActiveNodes(pool);
        return send(res, 200, { hits: search(index, q ?? {}) });
      }

      if (method === 'GET' && path.startsWith('/node/')) {
        const node = await getNode(pool, decodeURIComponent(path.slice('/node/'.length)));
        return node ? send(res, 200, node) : send(res, 404, { error: 'not found' });
      }

      if (method === 'POST' && path === '/node') {
        if (!canWrite) return send(res, 403, { error: 'no write scope' });
        const n = (await readBody(req)) as WriteInput | null;
        if (!n || !n.id || !n.body) return send(res, 400, { error: 'node needs id + body' });
        const id = await writeNode(pool, n, platform.id);
        return send(res, 200, { ok: true, id });
      }

      if (method === 'POST' && path === '/usage') {
        const b = (await readBody(req)) as { node_ids?: string[]; cited?: boolean; outcome?: string } | null;
        await recordUsage(pool, b?.node_ids ?? [], platform.id, b?.cited ?? null, b?.outcome ?? null);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'no such route' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  };
}

export async function start(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = makePool(url);
  await applyMigration(pool);
  const port = Number(process.env['PORT'] ?? 8088);
  createServer(makeHandler(pool)).listen(port, () => console.log(`[arachne] listening on :${port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((e: unknown) => { console.error('[arachne] fatal:', (e as Error).message); process.exit(1); });
}
