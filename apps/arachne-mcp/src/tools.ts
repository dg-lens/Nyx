import {
  assemble,
  classifyWrite,
  deriveLoc,
  isInjectable,
  orderBodySections,
  relevanceScore,
  renderPack,
  sanitizeBody,
  search,
  writeNode,
  type Directive,
  type NodeMeta,
  type Role,
  type SearchQuery,
  type WriteInput,
} from '@nyx/dispatcher/dist/memory/arachne.js';
import { IndexCache, validateVault, type ValidationResult } from './vault.js';

const ROLES: Role[] = ['dispatcher', 'planner', 'coder', 'reviewer', 'operator', 'all'];
const asRole = (v: string | undefined): Role => (v && (ROLES as string[]).includes(v) ? (v as Role) : 'all');

export interface PackArgs {
  paths?: string[];
  triggers?: string[];
  repo?: string;
  audience?: string;
  budget?: number;
}

/**
 * The hot path. Derive the directive `loc` from repo + touched paths, assemble the
 * smallest scoped pack, render it. assemble() applies the isInjectable provenance
 * gate internally, so review:pending agent nodes can never reach the rendered pack
 * — this thin front must not reconstruct the directive in any way that bypasses it.
 */
export function packTool(cache: IndexCache, a: PackArgs): { directive: Directive; ids: string[]; tokens: number; text: string } {
  const paths = a.paths ?? [];
  const triggers = a.triggers ?? [];
  const directive: Directive = {
    loc: deriveLoc(a.repo, paths),
    role: asRole(a.audience),
    paths,
    text: triggers.join(' '),
    budget: a.budget ?? 1800,
  };
  const pack = assemble(cache.get(), directive);
  return { directive, ids: pack.ids, tokens: pack.tokens, text: renderPack(pack) };
}

export interface Stub {
  id: string;
  title: string;
  summary: string;
  kind: string;
  loc: string[];
  weight: number;
}

const toStub = (n: NodeMeta): Stub => ({
  id: n.id,
  title: n.title,
  summary: n.summary,
  kind: n.kind,
  loc: n.loc,
  weight: n.weight,
});

export interface SurveyArgs {
  scope: string;
  audience?: string;
  budget?: number;
}

/**
 * Cheap catalog read: ranked STUBS only (no bodies). Scopes by loc ancestry +
 * audience, ranks by relevanceScore against the scope text then weight, and trims
 * to a stub-count budget. The worker decides what to memory_load from these.
 */
export function surveyTool(cache: IndexCache, a: SurveyArgs): Stub[] {
  const role = asRole(a.audience);
  const directive: Directive = { loc: a.scope, role, paths: [], text: a.scope, budget: 0 };
  const inScope = cache.get().filter((n) => {
    if (n.status !== 'active') return false;
    const roleOk = n.audience.includes(role) || n.audience.includes('all');
    const ancestor = n.loc.some((l) => l === a.scope || l.startsWith(a.scope + '.') || a.scope.startsWith(l + '.') || l === a.scope);
    return roleOk && ancestor;
  });
  inScope.sort((x, y) => relevanceScore(y, directive) - relevanceScore(x, directive) || y.weight - x.weight);
  const limit = a.budget ?? 40;
  return inScope.slice(0, limit).map(toStub);
}

export interface LoadedNode {
  id: string;
  title: string;
  kind: string;
  loc: string[];
  body: string;
}

const MAX_LOAD = 10;

/** Full bodies for explicit ids (≤10), sanitized + section-ordered, render-ready. */
export function loadTool(cache: IndexCache, ids: string[]): { nodes: LoadedNode[]; missing: string[] } {
  const want = ids.slice(0, MAX_LOAD);
  const byId = new Map(cache.get().map((n) => [n.id, n]));
  const nodes: LoadedNode[] = [];
  const missing: string[] = [];
  for (const id of want) {
    const n = byId.get(id);
    if (!n) {
      missing.push(id);
      continue;
    }
    nodes.push({ id: n.id, title: n.title, kind: n.kind, loc: n.loc, body: orderBodySections(sanitizeBody(n.body)) });
  }
  return { nodes, missing };
}

export interface SearchArgs {
  query?: string;
  triggers?: string[];
  loc?: string;
  concern?: string;
  kind?: string;
  limit?: number;
}

export interface SearchHit extends Stub {
  provenance: string;
  confidence: string;
  review: string;
  status: string;
  injectable: boolean;
}

/**
 * Frontmatter search. review:pending agent nodes ARE returnable (discoverability is
 * the point) but every hit carries its provenance/review/confidence + an injectable
 * flag so a caller never mistakes a searchable node for an injectable one.
 */
export function searchTool(cache: IndexCache, a: SearchArgs): SearchHit[] {
  const text = [a.query ?? '', ...(a.triggers ?? [])].join(' ').trim();
  const q: SearchQuery = {
    ...(text ? { text } : {}),
    ...(a.loc ? { loc: a.loc } : {}),
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.limit != null ? { limit: a.limit } : {}),
  };
  let hits = search(cache.get(), q);
  if (a.concern) hits = hits.filter((n) => n.concern.includes(a.concern!));
  return hits.map((n) => ({
    ...toStub(n),
    provenance: n.provenance,
    confidence: n.confidence,
    review: n.review,
    status: n.status,
    injectable: isInjectable(n),
  }));
}

export interface Neighbor {
  rel: string;
  id: string;
  resolved: Stub | null;
}

/** Typed edge traversal from a node's authored `edges` map. Optional `rel` filter. */
export function neighborsTool(cache: IndexCache, id: string, rel?: string): { id: string; neighbors: Neighbor[]; missing: boolean } {
  const index = cache.get();
  const node = index.find((n) => n.id === id);
  if (!node) return { id, neighbors: [], missing: true };
  const byId = new Map(index.map((n) => [n.id, n]));
  const out: Neighbor[] = [];
  for (const [edgeRel, value] of Object.entries(node.edges)) {
    if (rel && edgeRel !== rel) continue;
    const refs = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
    for (const ref of refs) {
      const target = byId.get(ref);
      out.push({ rel: edgeRel, id: ref, resolved: target ? toStub(target) : null });
    }
  }
  return { id, neighbors: out, missing: false };
}

export interface WriteResult {
  written: boolean;
  action: string;
  reason: string;
  score: number;
  file?: string;
  conflictingId?: string;
}

/**
 * Write chokepoint. classifyWrite runs FIRST — the dedup/provenance gate. A
 * NOOP/UPDATE/CONTRADICT verdict is a structured REFUSAL that names the existing
 * node id and does NOT write (this thin front never auto-supersedes; the operator/
 * wisdom layer owns merges). Only an ADD verdict reaches writeNode. A successful
 * write invalidates the cache.
 */
export function writeTool(cache: IndexCache, vault: string, n: WriteInput): WriteResult {
  const decision = classifyWrite(cache.get(), n);
  if (decision.action !== 'ADD') {
    return {
      written: false,
      action: decision.action,
      reason: decision.reason,
      score: decision.score,
      ...(decision.match ? { conflictingId: decision.match.id } : {}),
    };
  }
  const file = writeNode(vault, n);
  cache.invalidate();
  return { written: true, action: 'ADD', reason: decision.reason, score: decision.score, file };
}

export function validateTool(cache: IndexCache): ValidationResult {
  return validateVault(cache.vault);
}

export function reloadTool(cache: IndexCache): { count: number } {
  return { count: cache.reload() };
}
