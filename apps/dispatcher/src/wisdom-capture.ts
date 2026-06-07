import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const WISDOM_FILE = 'NYX_WISDOM.md';

export type WisdomTarget = 'Graph' | 'T4' | 'T2' | 'T3' | 'Personality' | 'None';

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
  scope?: string[];
  summary?: string;
  title?: string;
}

let diagMemoryDirOverride: string | null = null;
let developerPersonalityPathOverride: string | null = null;
let memoryNodesDirOverride: string | null = null;

export function _setDiagMemoryDir(dir: string | null): void {
  diagMemoryDirOverride = dir;
}

export function _setDeveloperPersonalityPath(path: string | null): void {
  developerPersonalityPathOverride = path;
}

export function _setMemoryNodesDir(dir: string | null): void {
  memoryNodesDirOverride = dir;
}

function getMemoryNodesDir(): string {
  if (memoryNodesDirOverride) return memoryNodesDirOverride;
  return resolve(homedir(), 'Nyx', 'memory', 'nodes');
}

function getDiagMemoryDir(): string {
  if (diagMemoryDirOverride) return diagMemoryDirOverride;
  return resolve(homedir(), 'Nyx', 'diagnostic-memory');
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
    ...(Array.isArray(meta.scope) ? { scope: meta.scope } : {}),
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
  scope?: string[] | null;
  summary?: string | null;
  title?: string | null;
}

function isWisdomMeta(v: unknown): v is WisdomMeta {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;

  const VALID_TARGETS: WisdomTarget[] = ['Graph', 'T4', 'T2', 'T3', 'Personality', 'None'];
  if (!VALID_TARGETS.includes(obj['target'] as WisdomTarget)) return false;

  if (obj['slug'] !== undefined && obj['slug'] !== null && typeof obj['slug'] !== 'string') return false;
  if (obj['path'] !== undefined && obj['path'] !== null && typeof obj['path'] !== 'string') return false;
  if (obj['section'] !== undefined && obj['section'] !== null && typeof obj['section'] !== 'string') return false;
  if (obj['agent_reason'] !== undefined && obj['agent_reason'] !== null && typeof obj['agent_reason'] !== 'string') return false;
  if (obj['id'] !== undefined && obj['id'] !== null && typeof obj['id'] !== 'string') return false;
  if (obj['kind'] !== undefined && obj['kind'] !== null && typeof obj['kind'] !== 'string') return false;
  if (obj['summary'] !== undefined && obj['summary'] !== null && typeof obj['summary'] !== 'string') return false;
  if (obj['title'] !== undefined && obj['title'] !== null && typeof obj['title'] !== 'string') return false;
  if (
    obj['scope'] !== undefined &&
    obj['scope'] !== null &&
    (!Array.isArray(obj['scope']) || !obj['scope'].every((s) => typeof s === 'string'))
  )
    return false;

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
  workingDir: string,
): { fileModified: string | null } {
  if (wisdom.target === 'None') return { fileModified: null };

  if (wisdom.target === 'Graph') return routeToGraph(wisdom, taskId);
  if (wisdom.target === 'T4') return routeToT4(wisdom, taskId);
  if (wisdom.target === 'T2' || wisdom.target === 'T3') return routeToTierDoc(wisdom, taskId, workingDir);
  if (wisdom.target === 'Personality') return routeToPersonality(wisdom, taskId);

  return { fileModified: null };
}

const GRAPH_KINDS = ['lesson', 'invariant', 'decision', 'procedure', 'aesthetic'];

function yamlQuote(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Writes a node into the memory vault (the graph is the source of truth now).
 * Mirrors routeToT4 but targets ~/Nyx/memory/nodes/<id>.md with graph
 * frontmatter. title/summary are always quoted so a colon can't break YAML.
 * If the node already exists, the lesson is appended to its body (never clobber)
 * — dedup/merge is the curator's job, not the wisdom spawn's.
 */
function routeToGraph(wisdom: WisdomCapture, taskId: string): { fileModified: string | null } {
  if (!wisdom.id || !/^[a-z0-9][a-z0-9-]*$/.test(wisdom.id)) return { fileModified: null };

  const dir = getMemoryNodesDir();
  const filePath = resolve(dir, `${wisdom.id}.md`);
  const date = new Date().toISOString().slice(0, 10);

  try {
    mkdirSync(dir, { recursive: true });

    if (existsSync(filePath)) {
      appendFileSync(filePath, `\n## Update (from ${taskId}, ${date})\n\n${wisdom.paragraph}\n`, 'utf8');
      return { fileModified: filePath };
    }

    const kind = wisdom.kind && GRAPH_KINDS.includes(wisdom.kind) ? wisdom.kind : 'lesson';
    const scope = wisdom.scope && wisdom.scope.length > 0 ? wisdom.scope : ['nyx'];
    const summary = wisdom.summary ?? wisdom.paragraph.slice(0, 100).replace(/\s+/g, ' ').trim();
    const title = wisdom.title ?? wisdom.id.replace(/-/g, ' ');

    const content = [
      '---',
      `id: ${wisdom.id}`,
      `title: ${yamlQuote(title)}`,
      `summary: ${yamlQuote(summary)}`,
      `kind: ${kind}`,
      `scope: [${scope.map(yamlQuote).join(', ')}]`,
      'load: on-demand',
      'status: active',
      `created: ${date}`,
      `updated: ${date}`,
      'visibility: shared',
      '---',
      '',
      `# ${title}`,
      '',
      '<!-- pending operator review -->',
      '',
      wisdom.paragraph,
      '',
      `<!-- captured by wisdom-capture from ${taskId} -->`,
      '',
    ].join('\n');

    writeFileSync(filePath, content, 'utf8');
    return { fileModified: filePath };
  } catch {
    return { fileModified: null };
  }
}

function routeToT4(wisdom: WisdomCapture, taskId: string): { fileModified: string | null } {
  const now = new Date().toISOString();
  const dateStr = now.slice(0, 10);
  const rawSlug = wisdom.slug
    ? `${wisdom.slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`
    : `wisdom-${taskId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const slug = `${dateStr}-${rawSlug}`;

  const diagDir = getDiagMemoryDir();
  const filePath = resolve(diagDir, `${slug}.md`);

  const content = [
    '---',
    `id: ${slug}`,
    `first_seen_at: ${now}`,
    `last_seen_at: ${now}`,
    `occurrences: 1`,
    `status: resolved`,
    `tags: []`,
    `related_task: ${taskId}`,
    `pattern_signature: ""`,
    '---',
    '',
    `# ${slug}`,
    '',
    `## Lesson`,
    '',
    wisdom.paragraph,
    '',
    `<!-- captured by wisdom-capture from ${taskId} -->`,
    '',
  ].join('\n');

  try {
    mkdirSync(diagDir, { recursive: true });
    writeFileSync(filePath, content, 'utf8');

    const indexPath = resolve(diagDir, 'INDEX.md');
    const summary = wisdom.paragraph.slice(0, 80).replace(/\n/g, ' ');
    const indexLine = `- [${slug}](./${slug}.md) — ${summary} (from ${taskId})\n`;
    appendFileSync(indexPath, indexLine, 'utf8');

    return { fileModified: filePath };
  } catch {
    return { fileModified: null };
  }
}

function routeToTierDoc(
  wisdom: WisdomCapture,
  taskId: string,
  workingDir: string,
): { fileModified: string | null } {
  if (!wisdom.path) return { fileModified: null };

  let absPath: string;
  if (wisdom.path.startsWith('~/')) {
    absPath = resolve(homedir(), wisdom.path.slice(2));
  } else if (wisdom.path.startsWith('/')) {
    absPath = wisdom.path;
  } else {
    absPath = resolve(workingDir, wisdom.path);
  }

  if (!existsSync(absPath)) return { fileModified: null };

  return appendWithReviewMarker(absPath, wisdom.paragraph, taskId);
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
    '  "scope": ["<nyx|portal|marketing|outreach|stack>"],',
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
    'The stack\'s memory is a knowledge graph — an Obsidian vault at `~/Nyx/memory` (the `memory_*` MCP tools read it). Lessons become atomic nodes there.',
    '',
    '| Target | When to use | What happens |',
    '|---|---|---|',
    '| `Graph` | **The default for any durable lesson** — a non-obvious constraint, gotcha, invariant, decision, or convention worth preserving. | Writes a node at `~/Nyx/memory/nodes/<id>.md` with `kind`/`scope`/`summary` frontmatter. If a node with that `id` already exists, your lesson is appended to it (no clobber). |',
    '| `None` | Nothing worth capturing — routine task, documented pattern, or the lesson is already a node. | No-op. |',
    '',
    'Pick an `id` that reads like the existing nodes (scope-meaningful kebab, no date prefix): `nyx-…`, `outreach-…`, `portal-…`, etc. Pick `kind` by what the lesson IS (a bug+fix → `lesson`; a stable rule → `invariant`; a why-we-chose → `decision`; a how-to → `procedure`; a code-style rule → `aesthetic`).',
    '',
    '## Anti-gaming note',
    '',
    'Defaulting to `None` when in doubt is correct. A low-quality invented node is worse than nothing — it pollutes the graph and wastes operator review time. A weekly audit checks skip rates; consistent `None` on routine tasks is expected and fine.',
    '',
    'Write `NYX_WISDOM.md` now, then exit 0.',
  ];

  return lines.join('\n');
}
