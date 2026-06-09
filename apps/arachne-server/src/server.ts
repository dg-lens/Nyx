import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assemble, search, type Directive, type SearchQuery } from './assemble.js';
import { makePool, applyMigration, loadActiveNodes, getNode, writeNode, recordUsage, type Pool, type WriteInput } from './db.js';
import { bearer, verifyToken, type Platform } from './auth.js';
import {
  pushGate, inboxGates, decideGate, decidedGates, consumeGate, getGate, type GateInput,
} from './gate-relay.js';

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
      // write implies read: a platform trusted to mutate the corpus can read it,
      // and the default provisioning is {read,write}. Encoded explicitly so a
      // read-less, write-only grant is never silently treated as read-capable.
      const canRead = platform.scopes.includes('read') || canWrite;

      if (method === 'POST' && path === '/pack') {
        if (!canRead) return send(res, 403, { error: 'no read scope' });
        const d = (await readBody(req)) as Directive | null;
        if (!d || typeof d.loc !== 'string') return send(res, 400, { error: 'pack needs {loc, role, paths, text, budget}' });
        const index = await loadActiveNodes(pool);
        const pack = assemble(index, { loc: d.loc, role: d.role ?? 'all', paths: d.paths ?? [], text: d.text ?? '', budget: d.budget ?? 1800 });
        await recordUsage(pool, pack.ids, platform.id, null, null).catch(() => {});
        return send(res, 200, pack);
      }

      if (method === 'POST' && path === '/search') {
        if (!canRead) return send(res, 403, { error: 'no read scope' });
        const q = (await readBody(req)) as SearchQuery | null;
        const index = await loadActiveNodes(pool);
        return send(res, 200, { hits: search(index, q ?? {}) });
      }

      if (method === 'GET' && path.startsWith('/node/')) {
        if (!canRead) return send(res, 403, { error: 'no read scope' });
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

      // --- gate relay (remote pipeline-gate review) ---
      const canPush = platform.scopes.includes('gate_push');
      const canReview = platform.scopes.includes('gate_review');

      // Origin pushes a gate brief.
      if (method === 'POST' && path === '/gate') {
        if (!canPush) return send(res, 403, { error: 'no gate_push scope' });
        const g = (await readBody(req)) as GateInput | null;
        if (!g || !g.id || !g.reviewer || !g.run_id || (g.gate_kind !== 'preview' && g.gate_kind !== 'review')) {
          return send(res, 400, { error: 'gate needs {id, reviewer, run_id, gate_kind: preview|review}' });
        }
        const r = await pushGate(pool, g, platform.id);
        return r.ok ? send(res, 200, { ok: true, id: r.id }) : send(res, r.code, { error: r.error });
      }

      // Reviewer inbox: open gates assigned to me.
      if (method === 'GET' && path === '/gate/inbox') {
        if (!canReview) return send(res, 403, { error: 'no gate_review scope' });
        return send(res, 200, { gates: await inboxGates(pool, platform.id) });
      }

      // Origin poll: my decided-but-unconsumed gates.
      if (method === 'GET' && path === '/gate/decided') {
        if (!canPush) return send(res, 403, { error: 'no gate_push scope' });
        return send(res, 200, { gates: await decidedGates(pool, platform.id) });
      }

      // Reviewer decides.
      if (method === 'POST' && /^\/gate\/[^/]+\/decision$/.test(path)) {
        if (!canReview) return send(res, 403, { error: 'no gate_review scope' });
        const id = decodeURIComponent(path.split('/')[2] ?? '');
        const b = (await readBody(req)) as { decision?: string; note?: string } | null;
        if (!b || !b.decision) return send(res, 400, { error: 'decision required' });
        const r = await decideGate(pool, id, platform.id, b.decision, b.note);
        return r.ok ? send(res, 200, { ok: true }) : send(res, r.code, { error: r.error });
      }

      // Origin marks a decided gate consumed after applying it.
      if (method === 'POST' && /^\/gate\/[^/]+\/consume$/.test(path)) {
        if (!canPush) return send(res, 403, { error: 'no gate_push scope' });
        const id = decodeURIComponent(path.split('/')[2] ?? '');
        const ok = await consumeGate(pool, id, platform.id);
        return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not a decided gate you own' });
      }

      // Either party reads one gate.
      if (method === 'GET' && path.startsWith('/gate/')) {
        const id = decodeURIComponent(path.slice('/gate/'.length));
        const gate = await getGate(pool, id);
        if (!gate) return send(res, 404, { error: 'not found' });
        if (gate.origin !== platform.id && gate.reviewer !== platform.id) {
          return send(res, 403, { error: 'not a party to this gate' });
        }
        return send(res, 200, gate);
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
