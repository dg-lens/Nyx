import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import {
  memoryDir,
  buildIndex,
  assemble,
  search,
  routeWrite,
} from '../../apps/dispatcher/dist/memory/arachne.js';

const DATA = process.env.NYX_DATA_DIR || join(homedir(), 'Nyx', 'Data');

const stub = (n) => ({ id: n.id, title: n.title, summary: n.summary, loc: n.loc, kind: n.kind, tokens: n.tokens });

function handle(dir, req) {
  if (req.op === 'write') {
    if (!req.node || !req.node.id || !req.node.body) return { ok: false, error: 'write needs node.id + node.body' };
    const r = routeWrite(dir, req.node);
    return { ok: true, action: r.action, wrote: r.file, matchId: r.matchId };
  }
  if (req.op === 'search') return { ok: true, hits: search(buildIndex(dir), req.query || {}).map(stub) };
  if (req.op === 'assemble') {
    const pack = assemble(buildIndex(dir), req.directive || {});
    return { ok: true, ids: pack.ids, tokens: pack.tokens };
  }
  return { ok: false, error: `unknown op: ${req.op}` };
}

function processInbox(dir, log) {
  const inbox = join(dir, '.inbox');
  if (!existsSync(inbox)) {
    mkdirSync(inbox, { recursive: true });
    return 0;
  }
  const done = join(inbox, 'processed');
  mkdirSync(done, { recursive: true });
  let count = 0;
  for (const f of readdirSync(inbox)) {
    if (!f.endsWith('.req.json')) continue;
    const reqPath = join(inbox, f);
    let res;
    try {
      res = handle(dir, JSON.parse(readFileSync(reqPath, 'utf8')));
    } catch (err) {
      res = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    try {
      writeFileSync(join(inbox, f.replace(/\.req\.json$/, '.res.json')), JSON.stringify(res, null, 1));
      renameSync(reqPath, join(done, f));
    } catch (err) {
      log(`response/move failed for ${f}: ${err.message}`);
    }
    count++;
    log(`${f} -> ${res.ok ? 'ok' : 'error: ' + res.error}`);
  }
  return count;
}

export default {
  setup(ctx) {
    const dir = memoryDir(DATA);
    if (ctx.runtime === 'host') {
      ctx.io.source('memory-surface', () => {
        ctx.log(`inbound surface watching ${join(dir, '.inbox')}`);
        const timer = setInterval(() => {
          try {
            processInbox(dir, ctx.log);
          } catch (err) {
            ctx.log(`poll error: ${err.message}`);
          }
        }, 2000);
        return () => clearInterval(timer);
      });
    } else {
      try {
        const n = processInbox(dir, ctx.log);
        if (n) ctx.log(`drained ${n} inbound request(s)`);
      } catch (err) {
        ctx.log(`drain error: ${err.message}`);
      }
    }
  },
};
