/**
 * Pure scoped-context assembly — the same budget + U-order + scope logic as the
 * Nyx engine, but operating on rows loaded from Postgres (PG-independent so it's
 * unit-testable without a database).
 */
export type Role = 'dispatcher' | 'planner' | 'coder' | 'reviewer' | 'operator' | 'all';

export interface NodeMeta {
  id: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  loc: string[];
  concern: string[];
  load: 'always' | 'entry' | 'match' | 'manual';
  audience: Role[];
  weight: number;
  paths: string[];
  symbols: string[];
  triggers: string[];
  status: string;
  tokens: number;
}

export interface Directive {
  loc: string;
  role: Role;
  paths: string[];
  text: string;
  budget: number;
}

const isAncestor = (anc: string, loc: string): boolean => loc === anc || loc.startsWith(anc + '.');

export interface PackResult {
  ids: string[];
  nodes: NodeMeta[];
  tokens: number;
}

export function assemble(index: NodeMeta[], d: Directive): PackResult {
  const text = (d.text || '').toLowerCase();
  const eligible: NodeMeta[] = [];
  for (const n of index) {
    if (n.status !== 'active') continue;
    const roleOk = n.audience.includes(d.role) || n.audience.includes('all');
    const ancestor = n.loc.some((l) => isAncestor(l, d.loc));
    let hit = false;
    if (n.load === 'always' && ancestor) hit = true;
    else if (n.load === 'entry' && ancestor && roleOk) hit = true;
    else if (n.load === 'match') {
      const pathHit = n.paths.some((p) => d.paths.some((q) => q.includes(p) || p.includes(q)));
      const trigHit = n.triggers.some((t) => text.includes(String(t).toLowerCase()));
      if ((pathHit || trigHit) && roleOk) hit = true;
    }
    if (hit) eligible.push(n);
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
  return { ids: ordered.map((n) => n.id), nodes: ordered, tokens };
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
