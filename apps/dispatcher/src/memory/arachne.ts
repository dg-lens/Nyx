/**
 * Arachne — the scoped-context memory engine (the MCP function, reworked into Nyx core).
 *
 * Pure logic over the markdown+frontmatter vault at <dataDir>/memory. Consumed by the
 * `memory` plugin (tick: assemble + inject) and the `memory-surface` plugin (host: inbound
 * write/query). Spec: <dataDir>/memory/ARACHNE.md.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export type Role = 'dispatcher' | 'planner' | 'coder' | 'reviewer' | 'operator' | 'all';

// CLOSED node-kind vocabulary. Mirrors the `kind` enum in the ARACHNE.md spec.
// `ruleset` is a first-class kind (codified rule sets, peer to `invariant`). The
// set is closed on purpose: parseNode drops and writeNode rejects any kind outside
// it, so the corpus can't accrete ad-hoc kinds that downstream kind-keyed logic
// (search filters, MOC routing) would silently mis-handle. To add a kind, extend
// this union — never loosen the check to arbitrary strings.
export type NodeKind =
  | 'invariant'
  | 'lesson'
  | 'decision'
  | 'playbook'
  | 'proposal'
  | 'overview'
  | 'reference'
  | 'ruleset'
  | 'moc';

export const VALID_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'invariant',
  'lesson',
  'decision',
  'playbook',
  'proposal',
  'overview',
  'reference',
  'ruleset',
  'moc',
]);

export function isValidKind(k: unknown): k is NodeKind {
  return typeof k === 'string' && VALID_KINDS.has(k as NodeKind);
}

export interface NodeMeta {
  id: string;
  kind: NodeKind;
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
  // Injection-trust gate: agent-written nodes are searchable but NOT injectable
  // until an operator flips review to 'approved'. Absent → 'pending' for agent
  // provenance, treated as approved for the 145 pre-existing operator/audit nodes.
  review: string;
  // Bi-temporal lifecycle: nodes are invalidated, never deleted, so "what did we
  // believe at tick T" stays replayable and pairs with the non-lossy audit chain.
  validFrom: string;
  validUntil: string | null;
  supersededBy: string | null;
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
  // CLOSED kind gate: a node whose kind is outside VALID_KINDS is dropped from the
  // index (buildIndex treats null as a skipped/malformed node). An absent kind
  // still defaults to the valid `reference`, preserving the prior lenient default.
  const kind = fm['kind'] == null ? 'reference' : fm['kind'];
  if (!isValidKind(kind)) return null;
  const provenance = String(fm['provenance'] ?? 'unknown');
  return {
    id: String(fm['id']),
    kind,
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
    provenance,
    confidence: String(fm['confidence'] ?? 'medium'),
    // Default differs by provenance so the corpus stays backward-compatible: the
    // existing operator/audit nodes carry no `review` key and must remain
    // injectable; only agent writes default to 'pending' (the poisoning gate).
    review: fm['review'] != null ? String(fm['review']) : provenance === 'agent' ? 'pending' : 'approved',
    validFrom: String(fm['valid_from'] ?? fm['created'] ?? ''),
    validUntil: fm['valid_until'] != null ? String(fm['valid_until']) : null,
    supersededBy: fm['superseded_by'] != null ? String(fm['superseded_by']) : null,
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

/**
 * Injection-trust gate (B.5). A node body is injected into a privileged spawn ONLY
 * if it is operator-trusted. Agent-authored nodes are discoverable via `search` but
 * an agent could write a poisoned body that auto-injects "leak the token" into every
 * future auth task — so an agent node is injectable only once review is 'approved'
 * or its confidence has been promoted to 'high' (an operator action). Everything not
 * `provenance: agent` (operator/audit/unknown seeds) is trusted and stays injectable.
 */
export function isInjectable(n: NodeMeta): boolean {
  if (n.provenance !== 'agent') return true;
  return n.review === 'approved' || n.confidence === 'high';
}

const HIDDEN_UNICODE = /[­​-‏‪-‮⁠-⁤⁪-⁯﻿￹-￻\u{e0000}-\u{e007f}]/gu;

/**
 * Sanitize a node body before it is rendered into a privileged prompt. Treats the
 * body as untrusted DATA, not instructions: strips zero-width/bidi/tag Unicode used to
 * smuggle hidden directives, and neutralizes the classic injection envelopes
 * (HTML comments, <IMPORTANT>/<SYSTEM> blocks) so a body can't impersonate a
 * platform instruction. Deterministic + model-independent, same shape as
 * checkDocUpdatesSpecMalformed.
 */
export function sanitizeBody(body: string): string {
  return body
    .replace(HIDDEN_UNICODE, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:important|system|instructions?|admin)[^>]*>/gi, '');
}

export interface PackResult {
  nodes: NodeMeta[];
  ids: string[];
  tokens: number;
  reasons: Record<string, string>;
}

// Above this many match-hits, run the deterministic rerank precision pass so
// low-relevance nodes can't crowd the budget on an over-matched scope (B.3).
const RERANK_THRESHOLD = 8;

/**
 * Deterministic relevance score in [0,1] of a node's summary/triggers against the
 * directive text — the cheap precision stage that stands in for a haiku rater off
 * the hot path (the model rerank, when wired, refines this; the engine must stay
 * model-free). Token-overlap of the directive against summary + triggers + title.
 */
export function relevanceScore(n: NodeMeta, d: Directive): number {
  const terms = (d.text || '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  if (terms.length === 0) return 0;
  const hay = (n.summary + ' ' + n.triggers.join(' ') + ' ' + n.title).toLowerCase();
  const pathHay = n.paths.join(' ');
  let hits = 0;
  for (const t of new Set(terms)) {
    if (hay.includes(t)) hits++;
    else if (d.paths.some((q) => q.toLowerCase().includes(t)) && pathHay.toLowerCase().includes(t)) hits++;
  }
  return hits / new Set(terms).size;
}

/** The hot path: smallest correct scoped pack for a directive, budgeted + U-ordered. */
export function assemble(index: NodeMeta[], d: Directive): PackResult {
  const text = (d.text || '').toLowerCase();
  const reasons: Record<string, string> = {};
  const eligible: NodeMeta[] = [];
  const matches: NodeMeta[] = [];
  for (const n of index) {
    if (n.status !== 'active') continue;
    // Injection gate: an un-reviewed agent node is searchable but never injected.
    if (!isInjectable(n)) continue;
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
      if (hit.startsWith('match')) matches.push(n);
      else eligible.push(n);
    }
  }
  // Over-match precision pass: keep only the most relevant match nodes so a noisy
  // scope can't dilute the budget. Spine (always/entry) is never reranked away.
  let keptMatches = matches;
  if (matches.length > RERANK_THRESHOLD) {
    keptMatches = matches
      .map((n) => ({ n, s: relevanceScore(n, d) }))
      .sort((a, b) => b.s - a.s || b.n.weight - a.n.weight)
      .slice(0, RERANK_THRESHOLD)
      .map((x) => x.n);
    for (const n of matches) if (!keptMatches.includes(n)) delete reasons[n.id];
  }
  const all = [...eligible, ...keptMatches];
  all.sort((a, b) => b.weight - a.weight);
  const kept: NodeMeta[] = [];
  let tokens = 0;
  for (const n of all) {
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

// Body section headers, in render order. ANTI: comes LAST: naming a forbidden
// action primes it (Ironic Process Theory), so the corrective FIX:/CHECK: must
// be read first and the ANTI: anchored against them (B.4). Authors keep the
// human-readable SYMPTOM/CAUSE/ANTI/FIX/CHECK order on disk; the render reorders.
const SECTION_ORDER = ['SYMPTOM', 'CAUSE', 'TRIGGER', 'FIX', 'CHECK', 'ANTI', 'NEGATIVE'];

/**
 * Reorder a node body so FIX:/CHECK: precede ANTI:/NEGATIVE:. Splits on leading
 * `LABEL:` markers; any prose before the first marker is preserved as a lead. A
 * body with no recognized markers is returned untouched.
 */
export function orderBodySections(body: string): string {
  const lines = body.split('\n');
  const head: string[] = [];
  const sections: { label: string; text: string[] }[] = [];
  let cur: { label: string; text: string[] } | null = null;
  for (const line of lines) {
    const m = /^([A-Z][A-Z_]+):/.exec(line);
    if (m && SECTION_ORDER.includes(m[1]!)) {
      cur = { label: m[1]!, text: [line] };
      sections.push(cur);
    } else if (cur) cur.text.push(line);
    else head.push(line);
  }
  if (sections.length === 0) return body;
  sections.sort((a, b) => SECTION_ORDER.indexOf(a.label) - SECTION_ORDER.indexOf(b.label));
  const lead = head.join('\n').trim();
  const ordered = sections.map((s) => s.text.join('\n').trim()).join('\n');
  return (lead ? lead + '\n' : '') + ordered;
}

/** Render an assembled pack into the injected `## MEMORY` block. */
export function renderPack(pack: PackResult): string {
  if (pack.nodes.length === 0) return '';
  const L = ['', '## MEMORY (Arachne — scoped invariants & lessons for this task)', ''];
  for (const n of pack.nodes) {
    L.push(`### ${n.id} — ${n.title}`, orderBodySections(sanitizeBody(n.body)), '');
  }
  L.push(`_(${pack.nodes.length} nodes, ~${pack.tokens} tokens. Honor these; record durable lessons via the memory surface.)_`);
  return L.join('\n');
}

export interface SearchQuery {
  text?: string;
  loc?: string;
  kind?: NodeKind;
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
  kind: NodeKind;
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
  // Lifecycle/provenance overrides used by routeWrite + supersedeNode; absent on
  // a plain inbound write, which stays agent/pending/active as before.
  provenance?: string;
  confidence?: string;
  status?: string;
  review?: string;
  created?: string;
  validFrom?: string;
  validUntil?: string;
  supersededBy?: string;
  supersedes?: string;
}

/**
 * Quote a scalar only when leaving it bare would produce invalid or mis-parsed
 * YAML — a colon (the H1 trap: `summary: x: y` parses as a nested map and throws),
 * a leading `#`/`!`/`&`/`*`/`>`/`|`/`@`/quote/`[`/`{`, or surrounding whitespace.
 * Plain words (`kind: lesson`, `load: match`) stay unquoted so the output matches
 * the hand-authored corpus shape.
 */
const needsQuote = (s: string): boolean =>
  s === '' || /[:#]/.test(s) || /^[\s!&*>|@'"[\]{}#-]/.test(s) || /\s$/.test(s);

const fmScalar = (v: unknown): string => {
  const s = String(v);
  return typeof v === 'string' && needsQuote(s)
    ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
    : s;
};

const fmLine = ([k, v]: [string, unknown]): string =>
  `${k}: ${Array.isArray(v) ? '[' + v.map(fmScalar).join(', ') + ']' : fmScalar(v)}`;

/** Inbound write: append a leaf as agent-provenance, pending review. Returns the file path. */
export function writeNode(dir: string, n: WriteInput): string {
  // CLOSED kind gate at the write boundary: reject an out-of-vocabulary kind before
  // it ever touches disk, so the corpus stays enumerable (mirrors parseNode's drop).
  if (!isValidKind(n.kind)) {
    throw new Error(`writeNode: invalid kind '${String(n.kind)}' (allowed: ${[...VALID_KINDS].join(', ')})`);
  }
  const nodesDir = join(dir, 'nodes');
  mkdirSync(nodesDir, { recursive: true });
  const safeId = n.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const created = n.created ?? today;
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
    provenance: n.provenance ?? 'agent',
    confidence: n.confidence ?? 'medium',
    status: n.status ?? 'active',
    review: n.review ?? 'pending',
    created,
    updated: today,
    valid_from: n.validFrom ?? created,
    ...(n.validUntil ? { valid_until: n.validUntil } : {}),
    ...(n.supersededBy ? { superseded_by: n.supersededBy } : {}),
    ...(n.supersedes ? { supersedes: n.supersedes } : {}),
  };
  const out = `---\n${Object.entries(fm).map(fmLine).join('\n')}\n---\n\n${n.body.trim()}\n`;
  const path = resolve(nodesDir, `${safeId}.md`);
  writeFileSync(path, out, 'utf8');
  return path;
}

const tokenize = (s: string): Set<string> => new Set((s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []));

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** loc[] overlap as a fraction of the smaller set — same scope spine ⇒ near-1. */
function locOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const hit = a.filter((x) => b.some((y) => isAncestor(x, y) || isAncestor(y, x))).length;
  return hit / Math.min(a.length, b.length);
}

export interface WriteDecision {
  action: 'ADD' | 'UPDATE' | 'NOOP' | 'CONTRADICT';
  match: NodeMeta | null;
  score: number;
  reason: string;
}

// Opposed-directive polarity pairs. A real contradiction is two imperatives that
// PUSH OPPOSITE WAYS on the same subject (always vs never run the gate), not the
// mere presence of a hedge word. Counting negations anywhere is too noisy —
// "avoid duration overshoot" is a recommendation, not a contradiction of a node
// that also recommends the fix. So we require one node to carry a positive verb
// and the other its paired negative.
const POLARITY_PAIRS: Array<[RegExp, RegExp]> = [
  [/\balways\b/, /\bnever\b/],
  [/\b(enable|enabled)\b/, /\b(disable|disabled)\b/],
  [/\b(must|should|do)\b/, /\b(must not|should not|do not|don'?t)\b/],
  [/\brequire[sd]?\b/, /\b(forbid|forbidden|prohibit|prohibited)\b/],
  [/\bkeep\b/, /\b(drop|remove|delete)\b/],
];

/** True iff a and b assert opposite polarities (one positive arm, one negative arm). */
function opposedPolarity(a: string, b: string): boolean {
  const A = a.toLowerCase();
  const B = b.toLowerCase();
  for (const [pos, neg] of POLARITY_PAIRS) {
    // Test the negative arm before stripping it so "must not" doesn't read as "must".
    const aNeg = neg.test(A);
    const bNeg = neg.test(B);
    const aPos = !aNeg && pos.test(A);
    const bPos = !bNeg && pos.test(B);
    if ((aPos && bNeg) || (aNeg && bPos)) return true;
  }
  return false;
}

/**
 * Heuristic dedup classifier (Mem0 ADD/UPDATE/NOOP shape) — NO LLM call (the engine
 * is the deterministic hot path; the model router, when wired, sits in the plugin/
 * wisdom layer and can override this). An exact id collision, or high loc+summary
 * overlap, routes to UPDATE/NOOP/CONTRADICT instead of a blind append.
 *
 * NOOP   — same id OR ≥0.85 combined similarity: already captured.
 * UPDATE — ≥0.55 similarity to an existing node: merge into it (supersede, B.2).
 * CONTRADICT — strong scope+summary overlap AND opposed directive polarity (one
 *              says always/the other never on the same subject): two clashing
 *              claims — preserve both, edges.contradicts, route to the operator
 *              gate (a clock can't resolve a semantic conflict; never auto-merge).
 * ADD    — no meaningful neighbor.
 */
export function classifyWrite(index: NodeMeta[], n: WriteInput): WriteDecision {
  const safeId = n.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const exact = index.find((c) => c.id === safeId && c.status === 'active');
  if (exact) return { action: 'NOOP', match: exact, score: 1, reason: 'id-collision' };

  const inLoc = n.loc ?? ['stack'];
  const inSum = tokenize(n.summary + ' ' + n.title);
  const inBody = tokenize(n.body);
  let best: { node: NodeMeta; score: number; loc: number; sum: number } | null = null;
  for (const c of index) {
    if (c.status !== 'active') continue;
    const loc = locOverlap(inLoc, c.loc);
    if (loc === 0) continue;
    const sum = jaccard(inSum, tokenize(c.summary + ' ' + c.title));
    const body = jaccard(inBody, tokenize(c.body));
    const score = loc * 0.4 + sum * 0.4 + body * 0.2;
    if (!best || score > best.score) best = { node: c, score, loc, sum };
  }
  if (!best || best.score < 0.55) return { action: 'ADD', match: null, score: best?.score ?? 0, reason: 'no-neighbor' };

  // Polarity check: same scope + overlapping terms AND opposed directives ⇒ a
  // genuine contradiction a clock can't resolve. Preserve both, gate to operator.
  const opposite = opposedPolarity(n.summary + ' ' + n.body, best.node.summary + ' ' + best.node.body);
  if (best.loc >= 0.5 && best.sum >= 0.3 && opposite) {
    return { action: 'CONTRADICT', match: best.node, score: best.score, reason: 'scope-overlap-opposite-polarity' };
  }
  if (best.score >= 0.85) return { action: 'NOOP', match: best.node, score: best.score, reason: 'near-identical' };
  return { action: 'UPDATE', match: best.node, score: best.score, reason: 'high-overlap' };
}

export interface RouteResult {
  action: WriteDecision['action'];
  file: string | null;
  matchId: string | null;
  score: number;
  reason: string;
}

/**
 * Write-through dedup chokepoint. Every write path (wisdom-capture, the
 * memory-surface inbound op, the future relay) routes here instead of calling
 * writeNode directly, so the corpus dedups/supersedes at the source rather than
 * accumulating near-dups. The heuristic decides; the caller (plugin/wisdom) is
 * free to upgrade the decision with a haiku router before calling this.
 */
export function routeWrite(dir: string, n: WriteInput): RouteResult {
  const index = buildIndex(dir);
  const decision = classifyWrite(index, n);
  const base = { matchId: decision.match?.id ?? null, score: decision.score, reason: decision.reason };

  if (decision.action === 'NOOP') {
    // Already captured: drop the write but bump the matched node's importance so a
    // re-derived fact counts toward its eventual promotion (B.6 seed, no decay yet).
    if (decision.match) bumpWeight(decision.match.file);
    return { action: 'NOOP', file: decision.match?.file ?? null, ...base };
  }

  if (decision.action === 'UPDATE' && decision.match) {
    // Non-destructive: write a successor that carries the merged fact and stamp the
    // predecessor superseded — never overwrite the existing body (B.2).
    const successorId = nextRevisionId(index, decision.match.id);
    const file = supersedeNode(dir, decision.match, {
      ...n,
      id: successorId,
      loc: n.loc ?? decision.match.loc,
    });
    return { action: 'UPDATE', file, ...base };
  }

  if (decision.action === 'CONTRADICT' && decision.match) {
    // Preserve both; link the contradiction and leave it active+pending for the
    // operator gate. A clock cannot resolve a semantic conflict — a human must.
    const file = writeNode(dir, {
      ...n,
      review: 'pending',
      provenance: n.provenance ?? 'agent',
    });
    linkContradiction(file, decision.match.id);
    linkContradiction(decision.match.file, n.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase());
    return { action: 'CONTRADICT', file, ...base };
  }

  return { action: 'ADD', file: writeNode(dir, n), ...base };
}

/** Successor id `<base>-rN`, skipping ids already taken in the index. */
function nextRevisionId(index: NodeMeta[], baseId: string): string {
  const stem = baseId.replace(/-r\d+$/, '');
  let rev = 2;
  let id = `${stem}-r${rev}`;
  const taken = new Set(index.map((n) => n.id));
  while (taken.has(id)) id = `${stem}-r${++rev}`;
  return id;
}

/**
 * Bi-temporal supersession (B.2): write `successor` as a fresh active node and
 * stamp `predecessor` with status:superseded + valid_until + superseded_by. Never
 * deletes or rewrites the predecessor body — "what we believed at tick T" stays
 * replayable, consistent with the non-lossy hash chain. Returns the successor path.
 */
export function supersedeNode(dir: string, predecessor: NodeMeta, successor: WriteInput): string {
  const today = new Date().toISOString().slice(0, 10);
  const successorId = successor.id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const path = writeNode(dir, {
    ...successor,
    supersedes: predecessor.id,
    validFrom: today,
  });
  stampSuperseded(predecessor.file, successorId, today);
  return path;
}

/**
 * Mutate ONLY a node's frontmatter via a full parse→mutate→serialize round-trip,
 * leaving the body verbatim. This is the ONLY sanctioned way to edit an existing
 * node's frontmatter.
 *
 * Regex surgery on a single frontmatter line corrupts BLOCK-form maps: the live
 * corpus authors `edges:` as
 *
 *   edges:
 *     relates: [a, b]
 *     contradicts: [c]
 *
 * A regex tuned for the inline shape (`edges: {...}`) rewrites the `edges:` line
 * and orphans the indented block beneath it → invalid YAML → `parseNode` throws →
 * `buildIndex`'s `catch {}` SILENTLY DROPS the node from the index. An agent-driven
 * contradiction/supersede write can thus erase an operator-authored node from
 * retrieval with no error surfaced — pure data loss. Parsing the whole frontmatter
 * into an object, mutating the object, and re-serializing is robust to both inline
 * and block forms. See node `arachne-frontmatter-mutation-must-roundtrip-yaml`.
 */
function mutateFrontmatter(file: string, mutate: (fm: Record<string, unknown>) => void): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('---')) return;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return;
  const fm = (parseYaml(text.slice(3, end)) as Record<string, unknown>) ?? {};
  mutate(fm);
  // stringify emits a trailing newline; strip it so the closing `---` sits flush.
  const serialized = stringifyYaml(fm).replace(/\n+$/, '');
  writeFileSync(file, `---\n${serialized}\n${text.slice(end + 1)}`, 'utf8');
}

/** Rewrite ONLY a node's frontmatter to mark it superseded; body is left intact. */
function stampSuperseded(file: string, successorId: string, date: string): void {
  mutateFrontmatter(file, (fm) => {
    fm['status'] = 'superseded';
    if (fm['review'] != null) fm['review'] = 'superseded';
    if (fm['updated'] != null) fm['updated'] = date;
    fm['valid_until'] = date;
    fm['superseded_by'] = successorId;
  });
}

/** Add an id to a node's edges.contradicts list, in place, frontmatter-only. */
function linkContradiction(file: string, otherId: string): void {
  mutateFrontmatter(file, (fm) => {
    const edges =
      fm['edges'] && typeof fm['edges'] === 'object' && !Array.isArray(fm['edges'])
        ? (fm['edges'] as Record<string, unknown>)
        : {};
    const list = Array.isArray(edges['contradicts'])
      ? (edges['contradicts'] as unknown[]).map(String)
      : edges['contradicts'] != null
        ? [String(edges['contradicts'])]
        : [];
    if (!list.includes(otherId)) list.push(otherId);
    edges['contradicts'] = list;
    fm['edges'] = edges;
  });
}

/** Increment a node's weight by 1 (ExpeL importance seed, B.6) — frontmatter only. */
function bumpWeight(file: string): void {
  mutateFrontmatter(file, (fm) => {
    const w = Number(fm['weight']);
    if (!Number.isFinite(w)) return;
    fm['weight'] = w + 1;
  });
}

export function nodeCount(dir: string): number {
  return buildIndex(dir).length;
}

export { basename };
