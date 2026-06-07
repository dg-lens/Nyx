/**
 * Arachne — the scoped-context memory engine (the MCP function, reworked into Nyx core).
 *
 * Pure logic over the markdown+frontmatter vault at <dataDir>/memory. Consumed by the
 * `memory` plugin (tick: assemble + inject) and the `memory-surface` plugin (host: inbound
 * write/query). Spec: <dataDir>/memory/ARACHNE.md.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type Role = 'dispatcher' | 'planner' | 'coder' | 'reviewer' | 'operator' | 'all';

export interface NodeMeta {
  id: string;
  kind: string;
  title: string;
  summary: string;
  loc: string[];
  concern: string[];
  load: 'always' | 'entry' | 'match' | 'manual';
  audience: Role[];
  weight: number;
  paths: string[];
  symbols: string[];
  triggers: string[];
  edges: Record<string, unknown>;
  status: string;
  provenance: string;
  confidence: string;
  tokens: number;
  body: string;
  file: string;
}

export interface Directive {
  loc: string;
  role: Role;
  paths: string[];
  text: string;
  budget: number;
}

const arr = (v: unknown): string[] =>
  v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

export function memoryDir(dataDir: string): string {
  return join(dataDir, 'memory');
}

/** owner/name or self → an Arachne loc path, refined by touched paths when possible. */
export function deriveLoc(repo: string | null | undefined, paths: string[] = []): string {
  let base: string;
  if (!repo || /\/?nyx$/i.test(repo) || repo === 'dg-lens/Nyx') base = 'stack.nyx';
  else if (repo.includes('/')) base = 'stack.' + repo.split('/')[1];
  else base = 'stack.' + repo;
  if (base === 'stack.nyx') {
    const p = paths.join(' ');
    for (const seg of ['pipeline', 'composer', 'secrets', 'desktop']) {
      if (p.includes(`/${seg}/`) || p.includes(`${seg}.ts`)) return `stack.nyx.${seg}`;
    }
    if (p.includes('cli/') || p.includes('run-once') || p.includes('task-runner')) return 'stack.nyx.dispatch';
  }
  return base;
}

function parseNode(file: string): NodeMeta | null {
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = parseYaml(text.slice(3, end)) as Record<string, unknown>;
  const body = text.slice(end + 4).trim();
  if (!fm || !fm['id']) return null;
  return {
    id: String(fm['id']),
    kind: String(fm['kind'] ?? 'reference'),
    title: String(fm['title'] ?? ''),
    summary: String(fm['summary'] ?? ''),
    loc: arr(fm['loc']),
    concern: arr(fm['concern']),
    load: (fm['load'] as NodeMeta['load']) ?? 'manual',
    audience: (arr(fm['audience']) as Role[]).length ? (arr(fm['audience']) as Role[]) : ['all'],
    weight: Number(fm['weight'] ?? 0),
    paths: arr(fm['paths']),
    symbols: arr(fm['symbols']),
    triggers: arr(fm['triggers']),
    edges: (fm['edges'] as Record<string, unknown>) ?? {},
    status: String(fm['status'] ?? 'active'),
    provenance: String(fm['provenance'] ?? 'unknown'),
    confidence: String(fm['confidence'] ?? 'medium'),
    tokens: Math.max(1, Math.ceil(body.length / 4)),
    body,
    file,
  };
}

export function buildIndex(dir: string): NodeMeta[] {
  const out: NodeMeta[] = [];
  for (const sub of ['nodes', 'moc']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.md')) continue;
      try {
        const n = parseNode(join(d, f));
        if (n) out.push(n);
      } catch {
        /* skip malformed node — never fatal */
      }
    }
  }
  return out;
}

const isAncestor = (anc: string, loc: string): boolean => loc === anc || loc.startsWith(anc + '.');

export interface PackResult {
  nodes: NodeMeta[];
  ids: string[];
  tokens: number;
  reasons: Record<string, string>;
}

/** The hot path: smallest correct scoped pack for a directive, budgeted + U-ordered. */
export function assemble(index: NodeMeta[], d: Directive): PackResult {
  const text = (d.text || '').toLowerCase();
  const reasons: Record<string, string> = {};
  const eligible: NodeMeta[] = [];
  for (const n of index) {
    if (n.status !== 'active') continue;
    const roleOk = n.audience.includes(d.role) || n.audience.includes('all');
    const ancestor = n.loc.some((l) => isAncestor(l, d.loc));
    let hit: string | null = null;
    if (n.load === 'always' && ancestor) hit = 'always';
    else if (n.load === 'entry' && ancestor && roleOk) hit = 'entry';
    else if (n.load === 'match') {
      const pathHit = n.paths.some((p) => d.paths.some((q) => q.includes(p) || p.includes(q)));
      const trigHit = n.triggers.some((t) => text.includes(String(t).toLowerCase()));
      if ((pathHit || trigHit) && roleOk) hit = pathHit ? 'match:path' : 'match:trigger';
    }
    if (hit) {
      reasons[n.id] = hit;
      eligible.push(n);
    }
  }
  eligible.sort((a, b) => b.weight - a.weight);
  const kept: NodeMeta[] = [];
  let tokens = 0;
  for (const n of eligible) {
    if (tokens + n.tokens <= d.budget) {
      kept.push(n);
      tokens += n.tokens;
    }
  }
  const head = kept.filter((_, i) => i % 2 === 0);
  const tail = kept.filter((_, i) => i % 2 === 1).reverse();
  const ordered = [...head, ...tail];
  return { nodes: ordered, ids: ordered.map((n) => n.id), tokens, reasons };
}

/** Render an assembled pack into the injected `## MEMORY` block. */
export function renderPack(pack: PackResult): string {
  if (pack.nodes.length === 0) return '';
  const L = ['', '## MEMORY (Arachne — scoped invariants & lessons for this task)', ''];
  for (const n of pack.nodes) {
    L.push(`### ${n.id} — ${n.title}`, n.body, '');
  }
  L.push(`_(${pack.nodes.length} nodes, ~${pack.tokens} tokens. Honor these; record durable lessons via the memory surface.)_`);
  return L.join('\n');
}

export interface SearchQuery {
  text?: string;
  loc?: string;
  kind?: string;
  limit?: number;
}

export function search(index: NodeMeta[], q: SearchQuery): NodeMeta[] {
  const text = (q.text || '').toLowerCase();
  const hits = index.filter((n) => {
    if (n.status !== 'active') return false;
    if (q.kind && n.kind !== q.kind) return false;
    if (q.loc && !n.loc.some((l) => isAncestor(l, q.loc!) || isAncestor(q.loc!, l))) return false;
    if (text) {
      const hay = (n.id + ' ' + n.title + ' ' + n.summary + ' ' + n.triggers.join(' ')).toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
  hits.sort((a, b) => b.weight - a.weight);
  return hits.slice(0, q.limit ?? 20);
}

export interface WriteInput {
  id: string;
  kind: string;
  title: string;
  summary: string;
  loc?: string[];
  concern?: string[];
  load?: string;
  audience?: string[];
  weight?: number;
  paths?: string[];
  triggers?: string[];
  body: string;
}

/** Inbound write: append a leaf as agent-provenance, pending review. Returns the file path. */
export function writeNode(dir: string, n: WriteInput): string {
  const nodesDir = join(dir, 'nodes');
  mkdirSync(nodesDir, { recursive: true });
  const safeId = n.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const fm: Record<string, unknown> = {
    id: safeId,
    kind: n.kind,
    title: n.title,
    summary: n.summary,
    loc: n.loc ?? ['stack'],
    ...(n.concern ? { concern: n.concern } : {}),
    load: n.load ?? 'match',
    audience: n.audience ?? ['all'],
    weight: n.weight ?? 4,
    ...(n.paths ? { paths: n.paths } : {}),
    ...(n.triggers ? { triggers: n.triggers } : {}),
    provenance: 'agent',
    confidence: 'medium',
    status: 'active',
    review: 'pending',
    created: today,
    updated: today,
  };
  const lines = Object.entries(fm).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? '[' + v.map(String).join(', ') + ']' : JSON.stringify(v).replace(/^"|"$/g, '')}`,
  );
  const out = `---\n${lines.join('\n')}\n---\n\n${n.body.trim()}\n`;
  const path = resolve(nodesDir, `${safeId}.md`);
  writeFileSync(path, out, 'utf8');
  return path;
}

export function nodeCount(dir: string): number {
  return buildIndex(dir).length;
}

export { basename };
