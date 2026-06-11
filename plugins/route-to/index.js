import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DATA = process.env.NYX_DATA_DIR || join(homedir(), 'Nyx', 'Data');

function expand(p) {
  let out = p;
  if (out.startsWith('~/') || out === '~') out = out.replace(/^~/, homedir());
  return out.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, name) => process.env[name] ?? m);
}

export function loadRegistry(path, log) {
  if (!existsSync(path)) {
    log(`registry not found at ${path} — no surfaces registered`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`registry malformed at ${path}: ${err.message} — no surfaces registered`);
    return {};
  }
  const surfaces = (parsed && parsed.surfaces) || {};
  const valid = {};
  const kinds = new Set(['ssh', 'ssh-local', 'icloud', 'telegram']);
  for (const [name, entry] of Object.entries(surfaces)) {
    if (!entry || typeof entry !== 'object' || !kinds.has(entry.kind)) {
      log(`skipping surface '${name}' — missing/unknown kind ${entry && entry.kind}`);
      continue;
    }
    valid[name] = entry;
  }
  return valid;
}

async function run(cmd, args, timeout, transports) {
  try {
    return await (transports.run || defaultRun)(cmd, args, timeout);
  } catch (err) {
    return { code: 1, stderr: String(err && err.message ? err.message : err) };
  }
}

function defaultRun(cmd, args, timeout) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 1, stderr: String(err && err.message ? err.message : err) });
      return;
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeout);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, stderr: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stderr }); });
  });
}

async function deliverSshLocal(entry, path, log, transports) {
  const inbox = expand(entry.inbox || '~/Reading');
  mkdirSync(inbox, { recursive: true });
  const dest = join(inbox, basename(path));
  if (dest !== path) copyFileSync(path, dest);
  const app = entry.open_app;
  const args = app ? ['-a', String(app), dest] : [dest];
  const r = await run('/usr/bin/open', args, 15000, transports);
  if (r.code !== 0) {
    log(`ssh-local open failed (rc=${r.code}) — file is in '${inbox}', open manually`);
  }
}

function remoteInbox(inbox) {
  if (inbox === '~') return '"$HOME"';
  if (inbox.startsWith('~/')) return `"$HOME/${inbox.slice(2).replace(/\/+$/, '')}"`;
  return inbox.replace(/\/+$/, '');
}

function scpDest(inbox, name) {
  let rel = inbox;
  if (rel === '~') return name;
  if (rel.startsWith('~/')) rel = rel.slice(2);
  rel = rel.replace(/\/+$/, '');
  return rel ? `${rel}/${name}` : name;
}

async function deliverSsh(entry, path, log, transports) {
  const address = entry.address;
  if (!address || address.includes('${')) {
    log(`ssh surface has no resolvable address — skipping`);
    return;
  }
  const inbox = entry.inbox || '~/Reading';
  const name = basename(path);
  const shellInbox = remoteInbox(inbox);
  const mkdir = await run('ssh', [address, `mkdir -p ${shellInbox} && test -d ${shellInbox}`], 120000, transports);
  if (mkdir.code !== 0) {
    log(`ssh inbox creation failed on ${address} (rc=${mkdir.code}) — cannot deliver`);
    return;
  }
  const scp = await run('scp', ['-q', path, `${address}:${scpDest(inbox, name)}`], 120000, transports);
  if (scp.code !== 0) {
    log(`ssh scp to ${address} failed (rc=${scp.code}) — file did not land`);
    return;
  }
  const app = entry.open_app;
  const openInner = app ? `open -a '${app}' ${shellInbox}/'${name}'` : `open ${shellInbox}/'${name}'`;
  const open = await run('ssh', [address, openInner], 120000, transports);
  if (open.code !== 0) {
    log(`ssh remote open on ${address} failed (rc=${open.code}) — file is in '${inbox}', open manually`);
  }
}

async function deliverIcloud(entry, path, log) {
  const inbox = expand(
    entry.inbox || '~/Library/Mobile Documents/com~apple~CloudDocs/Nyx-Reading',
  );
  const parent = dirname(inbox.replace(/\/+$/, ''));
  if (!existsSync(parent)) {
    log(`iCloud parent dir missing (${parent}) — sign into iCloud Drive and retry`);
    return;
  }
  try {
    mkdirSync(inbox, { recursive: true });
    copyFileSync(path, join(inbox, basename(path)));
  } catch (err) {
    log(`iCloud copy failed: ${err.message}`);
  }
}

async function deliverTelegram(entry, path, log, transports) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  let chatId = process.env.TELEGRAM_CHAT_ID;
  if (entry.address && !entry.address.includes('${')) chatId = entry.address;
  if (!token || !chatId) {
    log(`telegram missing bot token or chat id — skipping delivery`);
    return;
  }
  let body;
  try {
    body = readFileSync(path);
  } catch (err) {
    log(`telegram could not read artifact: ${err.message}`);
    return;
  }
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', new Blob([body]), basename(path));
  form.append('caption', `From: ${dirname(path)}`);
  const doFetch = transports.fetch || fetch;
  try {
    const resp = await doFetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) log(`telegram sendDocument failed (status ${resp.status})`);
  } catch (err) {
    log(`telegram sendDocument failed: ${err.message}`);
  }
}

export async function deliver(entry, path, log, transports = {}) {
  switch (entry.kind) {
    case 'ssh-local':
      return deliverSshLocal(entry, path, log, transports);
    case 'ssh':
      return deliverSsh(entry, path, log, transports);
    case 'icloud':
      return deliverIcloud(entry, path, log);
    case 'telegram':
      return deliverTelegram(entry, path, log, transports);
    default:
      log(`surface has unknown kind '${entry.kind}' — nothing delivered`);
  }
}

function artifactPath(signal) {
  const p = signal && signal.payload;
  return (p && (p.path || p.file)) || (typeof p === 'string' ? p : undefined);
}

export function registerSinks(ctx, registry, transports = {}) {
  for (const [name, entry] of Object.entries(registry)) {
    ctx.io.sink(name, async (signal) => {
      const path = artifactPath(signal);
      if (!path) {
        ctx.log(`sink '${name}' got a signal with no payload.path — ignoring`);
        return;
      }
      if (!existsSync(path)) {
        ctx.log(`sink '${name}': artifact does not exist (${path}) — skipping`);
        return;
      }
      try {
        await deliver(entry, path, ctx.log, transports);
      } catch (err) {
        ctx.log(`sink '${name}' delivery error (isolated): ${err.message}`);
      }
    });
  }
}

export default {
  setup(ctx) {
    if (ctx.runtime !== 'host') return;
    const path = join(DATA, 'route-to', 'surfaces.json');
    const registry = loadRegistry(path, ctx.log);
    const names = Object.keys(registry);
    if (!names.length) {
      ctx.log('no surfaces registered — set up $NYX_DATA_DIR/route-to/surfaces.json');
      return;
    }
    registerSinks(ctx, registry);
    ctx.log(`registered ${names.length} surface sink(s): ${names.join(', ')}`);
  },
};
