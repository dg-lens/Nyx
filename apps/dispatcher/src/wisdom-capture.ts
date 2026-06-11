import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { writeNode, isValidKind, type NodeKind } from './memory/arachne.js';

export const WISDOM_FILE = 'NYX_WISDOM.md';

export type WisdomTarget = 'Graph' | 'Personality' | 'None';

export interface WisdomCapture {
  paragraph: string;
  target: WisdomTarget;
  slug?: string;
  path?: string;
  section?: string;
  agentReason?: string;
  // Graph target — a node in the memory vault
  id?: string;
  kind?: string;
  // `loc` is the canonical location-spine the engine indexes on (e.g.
  // 'stack.nyx', 'stack.employee-portal'). `scope` is the legacy field agents
  // used to emit; it is mapped onto `loc` for backward compatibility.
  loc?: string[];
  scope?: string[];
  triggers?: string[];
  summary?: string;
  title?: string;
}

let developerPersonalityPathOverride: string | null = null;
let memoryNodesDirOverride: string | null = null;

export function _setDeveloperPersonalityPath(path: string | null): void {
  developerPersonalityPathOverride = path;
}

export function _setMemoryNodesDir(dir: string | null): void {
  memoryNodesDirOverride = dir;
}

function getMemoryNodesDir(): string {
  if (memoryNodesDirOverride) return memoryNodesDirOverride;
  return resolve(config.dataDir, 'memory', 'nodes');
}

function getDeveloperPersonalityPath(): string {
  if (developerPersonalityPathOverride) return developerPersonalityPathOverride;
  return resolve(homedir(), '.claude', 'developer-personality.md');
}

export function parseWisdomFile(workingDir: string): WisdomCapture | null {
  const filePath = resolve(workingDir, WISDOM_FILE);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  return parseWisdomContent(raw);
}

function parseWisdomContent(raw: string): WisdomCapture | null {
  const fenceMatch = /^```json\n([\s\S]*?)\n```/m.exec(raw);
  if (!fenceMatch || !fenceMatch[1]) return null;

  let meta: unknown;
  try {
    meta = JSON.parse(fenceMatch[1]);
  } catch {
    return null;
  }

  if (!isWisdomMeta(meta)) return null;

  const afterFence = raw.slice(fenceMatch.index + fenceMatch[0].length).trim();
  if (!afterFence) return null;

  return {
    paragraph: afterFence,
    target: meta.target,
    ...(meta.slug ? { slug: meta.slug } : {}),
    ...(meta.path ? { path: meta.path } : {}),
    ...(meta.section ? { section: meta.section } : {}),
    ...(meta.agent_reason ? { agentReason: meta.agent_reason } : {}),
    ...(meta.id ? { id: meta.id } : {}),
    ...(meta.kind ? { kind: meta.kind } : {}),
    ...(Array.isArray(meta.loc) ? { loc: meta.loc } : {}),
    ...(Array.isArray(meta.scope) ? { scope: meta.scope } : {}),
    ...(Array.isArray(meta.triggers) ? { triggers: meta.triggers } : {}),
    ...(meta.summary ? { summary: meta.summary } : {}),
    ...(meta.title ? { title: meta.title } : {}),
  };
}

interface WisdomMeta {
  target: WisdomTarget;
  slug?: string | null;
  path?: string | null;
  section?: string | null;
  agent_reason?: string | null;
  id?: string | null;
  kind?: string | null;
  loc?: string[] | null;
  scope?: string[] | null;
  triggers?: string[] | null;
  summary?: string | null;
  title?: string | null;
}

function isWisdomMeta(v: unknown): v is WisdomMeta {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;

  const VALID_TARGETS: WisdomTarget[] = ['Graph', 'Personality', 'None'];
  if (!VALID_TARGETS.includes(obj['target'] as WisdomTarget)) return false;

  if (obj['slug'] !== undefined && obj['slug'] !== null && typeof obj['slug'] !== 'string') return false;
  if (obj['path'] !== undefined && obj['path'] !== null && typeof obj['path'] !== 'string') return false;
  if (obj['section'] !== undefined && obj['section'] !== null && typeof obj['section'] !== 'string') return false;
  if (obj['agent_reason'] !== undefined && obj['agent_reason'] !== null && typeof obj['agent_reason'] !== 'string') return false;
  if (obj['id'] !== undefined && obj['id'] !== null && typeof obj['id'] !== 'string') return false;
  if (obj['kind'] !== undefined && obj['kind'] !== null && typeof obj['kind'] !== 'string') return false;
  if (obj['summary'] !== undefined && obj['summary'] !== null && typeof obj['summary'] !== 'string') return false;
  if (obj['title'] !== undefined && obj['title'] !== null && typeof obj['title'] !== 'string') return false;
  for (const key of ['loc', 'scope', 'triggers']) {
    const val = obj[key];
    if (
      val !== undefined &&
      val !== null &&
      (!Array.isArray(val) || !val.every((s) => typeof s === 'string'))
    )
      return false;
  }

  // Graph nodes need a valid kebab-case id; without it we can't write the node.
  if (obj['target'] === 'Graph') {
    const id = obj['id'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return false;
  }

  return true;
}

export function routeWisdomCapture(
  wisdom: WisdomCapture,
  taskId: string,
  _workingDir: string,
): { fileModified: string | null } {
  if (wisdom.target === 'None') return { fileModified: null };

  if (wisdom.target === 'Graph') return routeToGraph(wisdom, taskId);
  if (wisdom.target === 'Personality') return routeToPersonality(wisdom, taskId);

  return { fileModified: null };
}

// Advisory kinds the wisdom model may emit, mapped onto the engine's CLOSED
// NodeKind vocabulary. The model speaks a looser dialect (`procedure`/`aesthetic`);
// the engine only stores closed kinds, so normalize before writeNode (which now
// rejects out-of-vocabulary kinds). Anything unrecognized falls back to `lesson`.
const WISDOM_KIND_ALIAS: Record<string, NodeKind> = {
  procedure: 'playbook',
  aesthetic: 'invariant',
};

function resolveGraphKind(raw: string | null | undefined): NodeKind {
  if (!raw) return 'lesson';
  if (isValidKind(raw)) return raw;
  return WISDOM_KIND_ALIAS[raw] ?? 'lesson';
}

// Legacy `scope` tokens → canonical `loc` spine. The engine indexes on `loc`
// (stack ⊃ stack.nyx ⊃ stack.nyx.{pipeline,…}; stack.employee-portal[.…]), so a
// node tagged with the wrong field is invisible to every retrieval path.
const SCOPE_TO_LOC: Record<string, string> = {
  nyx: 'stack.nyx',
  portal: 'stack.employee-portal',
  marketing: 'stack.employee-portal.marketing-api',
  outreach: 'stack.employee-portal.outreach-api',
  stack: 'stack',
};

/**
 * Resolve the node's `loc` (the location spine the Arachne engine indexes on).
 * Prefer the agent's explicit `loc`; fall back to mapping the legacy `scope`
 * tokens; default to ['stack.nyx']. Never returns an empty array — an empty
 * `loc` is exactly the H1 bug (node matches no scope, appears in no MOC, is
 * never injected or searched).
 */
function wisdomLoc(wisdom: WisdomCapture): string[] {
  const fromLoc = (wisdom.loc ?? []).map((l) => l.trim()).filter(Boolean);
  if (fromLoc.length > 0) return fromLoc;
  const fromScope = (wisdom.scope ?? [])
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('stack') ? t : (SCOPE_TO_LOC[t] ?? `stack.${t}`)));
  return fromScope.length > 0 ? fromScope : ['stack.nyx'];
}

/**
 * Write a captured lesson into the memory vault. The graph is the source of
 * truth, so a new node MUST carry the exact schema the engine reads —
 * `loc`/`audience` + a VALID `load` value (`always|entry|match|manual`).
 * Previously this hand-rolled `scope`/`visibility`/`load: on-demand`, none of
 * which the engine reads (it reads `loc`/`audience`, and `on-demand` is not a
 * valid `load`), so every captured node was written but invisible to injection,
 * MOCs, and search — the H1 defect.
 *
 * The create path now routes through the engine's own `writeNode` rather than
 * hand-emitting YAML, so capture and the engine can never drift again: one
 * serializer stamps the canonical frontmatter (and quotes colon-bearing
 * summaries/titles safely). See node
 * arachne-write-through-dedup-and-provenance-gate.
 *
 * If the node already exists it is already well-formed + indexed, so the lesson
 * is appended (never clobber) — dedup/merge is the curator's job.
 */
function routeToGraph(wisdom: WisdomCapture, taskId: string): { fileModified: string | null } {
  if (!wisdom.id || !/^[a-z0-9][a-z0-9-]*$/.test(wisdom.id)) return { fileModified: null };

  const nodesDir = getMemoryNodesDir();
  const filePath = resolve(nodesDir, `${wisdom.id}.md`);
  const date = new Date().toISOString().slice(0, 10);

  try {
    mkdirSync(nodesDir, { recursive: true });

    if (existsSync(filePath)) {
      appendFileSync(filePath, `\n## Update (from ${taskId}, ${date})\n\n${wisdom.paragraph}\n`, 'utf8');
      return { fileModified: filePath };
    }

    const kind = resolveGraphKind(wisdom.kind);
    const loc = wisdomLoc(wisdom);
    const summary = wisdom.summary ?? wisdom.paragraph.slice(0, 100).replace(/\s+/g, ' ').trim();
    const title = wisdom.title ?? wisdom.id.replace(/-/g, ' ');
    const triggers = (wisdom.triggers ?? []).map((t) => t.trim()).filter(Boolean);

    // `writeNode` writes into <dir>/nodes; nodesDir is that leaf, so pass its parent.
    const written = writeNode(dirname(nodesDir), {
      id: wisdom.id,
      kind,
      title,
      summary,
      loc,
      load: 'match',
      audience: ['coder', 'reviewer'],
      weight: 4,
      ...(triggers.length > 0 ? { triggers } : {}),
      provenance: 'agent',
      confidence: 'medium',
      status: 'active',
      review: 'pending',
      created: date,
      body: `# ${title}\n\n${wisdom.paragraph}\n\n<!-- captured by wisdom-capture from ${taskId} -->`,
    });
    return { fileModified: written };
  } catch {
    return { fileModified: null };
  }
}

function routeToPersonality(wisdom: WisdomCapture, taskId: string): { fileModified: string | null } {
  const absPath = getDeveloperPersonalityPath();
  if (!existsSync(absPath)) return { fileModified: null };

  return appendWithReviewMarker(absPath, wisdom.paragraph, taskId);
}

function appendWithReviewMarker(
  absPath: string,
  paragraph: string,
  taskId: string,
): { fileModified: string | null } {
  const append = [
    '',
    `<!-- pending operator review --> <!-- from ${taskId} -->`,
    '',
    `### Wisdom (from ${taskId})`,
    '',
    paragraph,
    '',
    `<!-- end wisdom from ${taskId} -->`,
    '',
  ].join('\n');

  try {
    appendFileSync(absPath, append, 'utf8');
    return { fileModified: absPath };
  } catch {
    return { fileModified: null };
  }
}

export function buildWisdomPrompt(): string {
  const lines: string[] = [
    '# Wisdom Capture',
    '',
    'You just completed a task. Before exiting, take a moment to capture a single lesson if you learned something worth preserving for future agents.',
    '',
    '## What to write',
    '',
    'If your task surfaced a non-obvious constraint, a gotcha, a pattern that future agents would benefit from knowing, or confirmed a design decision — write it down. One to three sentences maximum. Be concrete and specific; no platitudes.',
    '',
    'If you did not learn anything non-obvious (you followed a documented pattern, the task was routine, or the lesson is already a node in the memory graph) — declare `target: "None"`. Do not invent a lesson to justify writing the file.',
    '',
    '## File format',
    '',
    'Write `NYX_WISDOM.md` in the current working directory with this exact structure:',
    '',
    '````markdown',
    '```json',
    '{',
    '  "target": "<Graph|None>",',
    '  "id": "<kebab-case node id — REQUIRED for Graph, e.g. outreach-send-gate-blackout>",',
    '  "kind": "<lesson|invariant|decision|procedure|aesthetic>",',
    '  "loc": ["<location spine: stack.nyx | stack.nyx.pipeline | stack.nyx.dispatch | stack.employee-portal | stack>"],',
    '  "triggers": ["<keywords a future agent would search to surface this: error strings, symbol names, filenames>"],',
    '  "summary": "<one-line matchable hint — for a lesson: \\"<signature> — <root cause>\\">",',
    '  "title": "<optional human-readable title>",',
    '  "agent_reason": "<one sentence: why this lesson matters>"',
    '}',
    '```',
    '',
    'One to three sentences describing the lesson (this becomes the node body). Be concrete.',
    '````',
    '',
    '## Target options',
    '',
    'The stack\'s memory is a knowledge graph — an Obsidian vault at `~/Nyx/Data/memory` (the `memory_*` MCP tools read it). Lessons become atomic nodes there.',
    '',
    '| Target | When to use | What happens |',
    '|---|---|---|',
    '| `Graph` | **The default for any durable lesson** — a non-obvious constraint, gotcha, invariant, decision, or convention worth preserving. | Writes a node at `~/Nyx/Data/memory/nodes/<id>.md` with `kind`/`loc`/`summary`/`triggers` frontmatter. If a node with that `id` already exists, your lesson is appended to it (no clobber). |',
    '| `None` | Nothing worth capturing — routine task, documented pattern, or the lesson is already a node. | No-op. |',
    '',
    'Pick an `id` that reads like the existing nodes (location-meaningful kebab, no date prefix): `nyx-…`, `outreach-…`, `portal-…`, etc. Pick `kind` by what the lesson IS (a bug+fix → `lesson`; a stable rule → `invariant`; a why-we-chose → `decision`; a how-to → `procedure`; a code-style rule → `aesthetic`).',
    '',
    'Set `loc` to where the lesson lives on the location spine the retriever indexes on — `stack.nyx` (or a segment: `stack.nyx.pipeline`, `stack.nyx.dispatch`, `stack.nyx.secrets`, `stack.nyx.composer`, `stack.nyx.desktop`), `stack.employee-portal[.marketing-api|.outreach-api]`, or `stack` for cross-stack. Set `triggers` to the few keywords (error strings, symbol/file names) a future agent would have in context when this lesson should resurface — this is what makes the node match-injected, not just stored.',
    '',
    '## Anti-gaming note',
    '',
    'Defaulting to `None` when in doubt is correct. A low-quality invented node is worse than nothing — it pollutes the graph and wastes operator review time. A weekly audit checks skip rates; consistent `None` on routine tasks is expected and fine.',
    '',
    'Write `NYX_WISDOM.md` now, then exit 0.',
  ];

  return lines.join('\n');
}
