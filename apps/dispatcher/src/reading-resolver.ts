import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config } from './config.js';

export interface ReadingReference {
  type: 'T1' | 'node';
  section?: string;
  slug?: string;
  raw: string;
}

export interface ResolvedReading {
  ref: ReadingReference;
  content: string;
}

export function parseReadingRefs(raw: string): ReadingReference[] {
  const tokens = raw.split(',').map(s => s.trim()).filter(Boolean);
  return tokens.map(parseOneRef);
}

function parseOneRef(token: string): ReadingReference {
  const raw = token;

  if (/^T1(\s|$)/.test(token)) {
    const rest = token.slice(2).trim();
    if (!rest) return { type: 'T1', raw };
    const m = rest.match(/^§\s*(.+)$/);
    if (m) return { type: 'T1', section: m[1]?.trim(), raw };
    throw new Error(`[reading:] malformed T1 reference — unexpected content after 'T1': "${token}"`);
  }

  // Everything that isn't T1 resolves to an Arachne node. Canonical form is
  // `node <id>`; legacy tier/category prefixes (T2/T3/T4/decision/playbook) are
  // accepted and mapped to the node whose id is the trailing slug (path basename,
  // sans .md) so existing [reading:] tags keep resolving against the graph.
  let rest = token;
  const m = token.match(/^(?:node|T2|T3|T4|decision|playbook)\s+(.+)$/i);
  if (m) rest = m[1] ?? '';

  let section: string | undefined;
  const secIdx = rest.indexOf(' §');
  if (secIdx !== -1) {
    section = rest.slice(secIdx + 2).trim();
    rest = rest.slice(0, secIdx).trim();
  }
  const slug = (rest.replace(/\.md$/, '').split('/').pop() ?? '').trim();
  if (!slug) throw new Error(`[reading:] unrecognized reference token: "${token}"`);
  return section ? { type: 'node', slug, section, raw } : { type: 'node', slug, raw };
}

let nodesDirOverride: string | null = null;
export function _setNodesDir(dir: string | null): void {
  nodesDirOverride = dir;
}

function resolveFilePath(ref: ReadingReference): string | null {
  if (ref.type === 'T1') return resolve(homedir(), '.claude', 'CLAUDE.md');
  if (ref.type === 'node') {
    if (!ref.slug) return null;
    const dir = nodesDirOverride ?? resolve(config.dataDir, 'memory', 'nodes');
    return resolve(dir, `${ref.slug}.md`);
  }
  return null;
}

interface HeadingInfo {
  idx: number;
  level: number;
  text: string;
  number: string | null;
}

function parseHeadings(lines: string[]): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    const level = m[1]?.length ?? 0;
    const text = (m[2] ?? '').toLowerCase().trim();
    const numMatch = text.match(/^§?\s*(\d+(?:\.\d+)*)\b/);
    headings.push({ idx: i, level, text, number: numMatch ? (numMatch[1] ?? null) : null });
  }
  return headings;
}

function headingMatches(h: HeadingInfo, needle: string): boolean {
  const numNeedle = needle.replace(/^§\s*/, '').trim();
  if (/^\d+(?:\.\d+)*$/.test(numNeedle)) {
    return h.number === numNeedle;
  }
  const stripped = h.text.replace(/^§?\s*\d+(?:\.\d+)*\s*:?\s*/, '').trim();
  return stripped === needle || h.text === needle;
}

function extractSection(content: string, section: string): string | null {
  const lines = content.split('\n');
  const needle = section.toLowerCase().trim();
  const headings = parseHeadings(lines);

  let exact = headings.filter(h => headingMatches(h, needle));
  if (exact.length === 0) {
    const stripNeedle = needle.replace(/^§\s*/, '').trim();
    const numericNeedle = /^\d+(?:\.\d+)*$/.test(stripNeedle);
    if (!numericNeedle) {
      exact = headings.filter(h => {
        const stripped = h.text.replace(/^§?\s*\d+(?:\.\d+)*\s*:?\s*/, '').trim();
        return stripped.startsWith(stripNeedle) || h.text.startsWith(needle);
      });
    }
  }
  if (exact.length === 0) return null;
  if (exact.length > 1) {
    throw new Error(
      `[reading:] ambiguous section reference "${section}" — matched ${exact.length} headings; tighten the reference to an exact section number or full heading text`,
    );
  }

  const startIdx = exact[0]?.idx ?? -1;
  const headingLevel = exact[0]?.level ?? 0;
  if (startIdx === -1) return null;

  const result: string[] = [lines[startIdx] ?? ''];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^(#{1,6})\s/);
    if (m && (m[1]?.length ?? 0) <= headingLevel) break;
    result.push(line);
  }

  return result.join('\n').trimEnd();
}

export function resolveReadingRefs(refs: ReadingReference[]): { resolved: ResolvedReading[]; missing: ReadingReference[] } {
  const resolved: ResolvedReading[] = [];
  const missing: ReadingReference[] = [];

  for (const ref of refs) {
    const filePath = resolveFilePath(ref);
    if (!filePath || !existsSync(filePath)) {
      missing.push(ref);
      continue;
    }

    let fileContent: string;
    try {
      fileContent = readFileSync(filePath, 'utf8');
    } catch {
      missing.push(ref);
      continue;
    }

    if (ref.section) {
      const sectionContent = extractSection(fileContent, ref.section);
      if (sectionContent === null) {
        missing.push(ref);
        continue;
      }
      resolved.push({ ref, content: sectionContent });
    } else {
      resolved.push({ ref, content: fileContent });
    }
  }

  return { resolved, missing };
}

export function buildRequiredContextBlock(resolved: ResolvedReading[]): string {
  const lines: string[] = [];
  lines.push('## REQUIRED CONTEXT — loaded from [reading:] tag');
  lines.push('');
  lines.push("The following sections were specified in this task's [reading:] tag. They represent prior decisions, patterns, or lessons the operator considers directly relevant to this task. Read them before proceeding.");

  for (const { ref, content } of resolved) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`### ${ref.raw}`);
    lines.push('');
    lines.push(content);
  }

  lines.push('');
  lines.push('---');

  return lines.join('\n');
}
