import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { makeHandler } from '../src/server.ts';
import { pushGate, decideGate, getGate } from '../src/gate-relay.ts';
import { hashToken } from '../src/auth.ts';
import type { Pool } from '../src/db.ts';

// A minimal in-memory stand-in for pg.Pool covering only the queries the authz
// paths touch (platform lookup by token_hash, the gates upsert/select). Lets the
// scope-denial + cross-origin tests run with no Postgres so the default suite
// stays green on a box without a database.
interface FakePlatform { id: string; name: string; scopes: string[]; token: string }
interface FakeGate {
  id: string; origin: string; reviewer: string; run_id: string; task_id: string;
  repo: string | null; gate_kind: string; summary: string; options: string[];
  status: string; decision: string | null; note: string | null; decided_by: string | null;
  created_at: string; decided_at: string | null;
}

function makeFakePool(platforms: FakePlatform[]): Pool {
  const gates = new Map<string, FakeGate>();
  const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
  const query = async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const q = norm(sql);
    if (q.startsWith('SELECT id, name, scopes FROM platforms WHERE token_hash')) {
      const p = platforms.find((x) => hashToken(x.token) === params[0]);
      return { rows: p ? [{ id: p.id, name: p.name, scopes: p.scopes }] : [], rowCount: p ? 1 : 0 };
    }
    if (q.startsWith('SELECT * FROM nodes WHERE id')) {
      return { rows: [], rowCount: 0 };
    }
    if (q.startsWith('SELECT origin FROM gates WHERE id')) {
      const g = gates.get(params[0] as string);
      return { rows: g ? [{ origin: g.origin }] : [], rowCount: g ? 1 : 0 };
    }
    if (q.startsWith('SELECT * FROM gates WHERE id')) {
      const g = gates.get(params[0] as string);
      return { rows: g ? [{ ...g }] : [], rowCount: g ? 1 : 0 };
    }
    if (q.startsWith('INSERT INTO gates')) {
      const [id, origin, reviewer, run_id, task_id, repo, gate_kind, summary, options] = params as [
        string, string, string, string, string, string | null, string, string, string[],
      ];
      const existing = gates.get(id);
      if (!existing) {
        gates.set(id, {
          id, origin, reviewer, run_id, task_id, repo, gate_kind, summary, options,
          status: 'open', decision: null, note: null, decided_by: null,
          created_at: new Date().toISOString(), decided_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      // ON CONFLICT (id) DO UPDATE ... WHERE gates.status='open' AND gates.origin=EXCLUDED.origin
      if (existing.status === 'open' && existing.origin === origin) {
        existing.summary = summary; existing.options = options;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (q.startsWith("UPDATE gates SET status='decided'")) {
      const g = gates.get(params[0] as string);
      if (g) { g.status = 'decided'; g.decision = params[1] as string; g.note = (params[2] as string) ?? null; g.decided_by = params[3] as string; g.decided_at = new Date().toISOString(); }
      return { rows: [], rowCount: g ? 1 : 0 };
    }
    throw new Error(`fake pool: unhandled query: ${q}`);
  };
  return { query } as unknown as Pool;
}

// A throwaway ServerResponse capturing status + JSON body.
function fakeRes(): ServerResponse & { _code: number; _body: unknown } {
  const r = {
    _code: 0, _body: undefined as unknown,
    writeHead(code: number) { this._code = code; return this; },
    end(s?: string) { this._body = s ? JSON.parse(s) : undefined; return this; },
  };
  return r as unknown as ServerResponse & { _code: number; _body: unknown };
}
function fakeReq(method: string, url: string, token?: string, body?: unknown): IncomingMessage {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const req = {
    method, url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    on(ev: string, cb: (arg?: unknown) => void) { handlers[ev] = cb; return this; },
  } as unknown as IncomingMessage;
  queueMicrotask(() => {
    if (body !== undefined) handlers['data']?.(Buffer.from(JSON.stringify(body)));
    handlers['end']?.();
  });
  return req;
}

const TOK = { read: 't-read', writeOnly: 't-writeonly', pushOnly: 't-pushonly', reviewOnly: 't-reviewonly' };

function poolWithPlatforms(): Pool {
  return makeFakePool([
    { id: 'reader', name: 'Reader', scopes: ['read'], token: TOK.read },
    { id: 'writer', name: 'WriteOnly', scopes: ['write'], token: TOK.writeOnly },
    { id: 'pusher', name: 'PushOnly', scopes: ['gate_push'], token: TOK.pushOnly },
    { id: 'reviewer', name: 'ReviewOnly', scopes: ['gate_review'], token: TOK.reviewOnly },
  ]);
}

async function call(pool: Pool, method: string, url: string, token?: string, body?: unknown) {
  const handler = makeHandler(pool);
  const res = fakeRes();
  await handler(fakeReq(method, url, token, body), res);
  return res;
}

describe('M8 — read scope enforced on every read route', () => {
  test('a platform without read (gate_push only) is 403 on /pack, /search, /node/:id', async () => {
    const pool = poolWithPlatforms();
    const pack = await call(pool, 'POST', '/pack', TOK.pushOnly, { loc: 'stack.nyx' });
    assert.equal(pack._code, 403);
    assert.deepEqual(pack._body, { error: 'no read scope' });

    const search = await call(pool, 'POST', '/search', TOK.reviewOnly, { text: 'x' });
    assert.equal(search._code, 403);

    const node = await call(pool, 'GET', '/node/some-id', TOK.pushOnly);
    assert.equal(node._code, 403);
    assert.deepEqual(node._body, { error: 'no read scope' });
  });

  test('write implies read — a write-only platform may call read routes', async () => {
    const pool = poolWithPlatforms();
    const node = await call(pool, 'GET', '/node/missing-id', TOK.writeOnly);
    // passes the scope gate (would be 403 if read were denied); 404 = route ran.
    assert.equal(node._code, 404);
    assert.deepEqual(node._body, { error: 'not found' });
  });

  test('an unauthenticated request is 401 before any scope check', async () => {
    const pool = poolWithPlatforms();
    const r = await call(pool, 'POST', '/pack', undefined, { loc: 'stack' });
    assert.equal(r._code, 401);
  });
});

describe('M9 — cross-origin gate isolation', () => {
  test('pushGate refuses to touch a gate id owned by another origin', async () => {
    const pool = poolWithPlatforms();
    // Origin A legitimately pushes gate X.
    const a = await pushGate(pool, { id: 'gate-X', reviewer: 'rev', run_id: 'r1', gate_kind: 'preview' }, 'platform-A');
    assert.deepEqual(a, { ok: true, id: 'gate-X' });

    // Origin B tries to squat the same id — must be rejected, not absorbed.
    const b = await pushGate(pool, { id: 'gate-X', reviewer: 'platform-B', run_id: 'evil', gate_kind: 'preview' }, 'platform-B');
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.code, 409);

    // A's gate is untouched: origin + reviewer still A's.
    const g = await getGate(pool, 'gate-X');
    assert.equal(g?.origin, 'platform-A');
    assert.equal(g?.reviewer, 'rev');
  });

  test('pre-squat attempt by B cannot redirect A: B inserts first, A is then refused but B never sees A run_id', async () => {
    const pool = poolWithPlatforms();
    // B pre-inserts the id A will use.
    const first = await pushGate(pool, { id: 'gate-Y', reviewer: 'platform-B', run_id: 'b-run', gate_kind: 'preview' }, 'platform-B');
    assert.deepEqual(first, { ok: true, id: 'gate-Y' });

    // A pushes the same id; squat owner is B, so A's push is refused (no silent retarget).
    const a = await pushGate(pool, { id: 'gate-Y', reviewer: 'rev-A', run_id: 'a-run', gate_kind: 'preview' }, 'platform-A');
    assert.equal(a.ok, false);

    // The stored row remains B's own gate — A's run_id never leaked into it.
    const g = await getGate(pool, 'gate-Y');
    assert.equal(g?.origin, 'platform-B');
    assert.equal(g?.run_id, 'b-run');
  });

  test('same-origin re-push (retry) is idempotent and updates summary', async () => {
    const pool = poolWithPlatforms();
    await pushGate(pool, { id: 'gate-Z', reviewer: 'rev', run_id: 'r', gate_kind: 'preview', summary: 'first' }, 'platform-A');
    const again = await pushGate(pool, { id: 'gate-Z', reviewer: 'rev', run_id: 'r', gate_kind: 'preview', summary: 'second' }, 'platform-A');
    assert.deepEqual(again, { ok: true, id: 'gate-Z' });
    const g = await getGate(pool, 'gate-Z');
    assert.equal(g?.summary, 'second');
  });

  test('a decided gate is not clobbered by a re-push from its own origin', async () => {
    const pool = poolWithPlatforms();
    await pushGate(pool, { id: 'gate-D', reviewer: 'rev', run_id: 'r', gate_kind: 'preview', summary: 'orig' }, 'platform-A');
    const dec = await decideGate(pool, 'gate-D', 'rev', 'go', undefined);
    assert.deepEqual(dec, { ok: true });
    // Re-push: ON CONFLICT WHERE status='open' is false now, so summary stays.
    await pushGate(pool, { id: 'gate-D', reviewer: 'rev', run_id: 'r', gate_kind: 'preview', summary: 'overwrite' }, 'platform-A');
    const g = await getGate(pool, 'gate-D');
    assert.equal(g?.status, 'decided');
    assert.equal(g?.summary, 'orig');
  });
});
