import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ReadingReference {
  type: 'T1' | 'T2' | 'T3' | 'T4' | 'decision' | 'playbook';
  path?: string;
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

  const t23 = token.match(/^(T[23])\s+(.+)$/);
  if (t23) {
    const type = t23[1] as 'T2' | 'T3';
    const rest = t23[2] ?? '';
    const secIdx = rest.indexOf(' §');
    if (secIdx === -1) return { type, path: rest.trim(), raw };
    return { type, path: rest.slice(0, secIdx).trim(), section: rest.slice(secIdx + 2).trim(), raw };
  }

  const t4 = token.match(/^T4\s+(.+)$/);
  if (t4) return { type: 'T4', slug: t4[1]?.trim(), raw };

  const dec = token.match(/^decision\s+(.+)$/i);
  if (dec) return { type: 'decision', slug: dec[1]?.trim(), raw };

  const pb = token.match(/^playbook\s+(.+)$/i);
  if (pb) return { type: 'playbook', slug: pb[1]?.trim(), raw };

  throw new Error(`[reading:] unrecognized reference token: "${token}"`);
}

function expandPath(p: string): string {
  const home = homedir();
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (p.startsWith('/')) return p;
  return join(home, p);
}

function resolveFilePath(ref: ReadingReference): string | null {
  const home = homedir();
  switch (ref.type) {
    case 'T1':
      return resolve(home, '.claude', 'CLAUDE.md');
    case 'T2':
    case 'T3':
      if (!ref.path) return null;
      return expandPath(ref.path);
    case 'T4':
      if (!ref.slug) return null;
      return resolve(home, 'Nyx', 'diagnostic-memory', `${ref.slug}.md`);
    case 'decision':
      if (!ref.slug) return null;
      return resolve(home, 'Nyx', 'decisions', `${ref.slug}.md`);
    case 'playbook':
      if (!ref.slug) return null;
      return resolve(home, 'Nyx', 'playbooks', `${ref.slug}.md`);
    default:
      return null;
  }
}

function extractSection(content: string, section: string): string | null {
  const lines = content.split('\n');
  const needle = section.toLowerCase().trim();
  let headingLevel = 0;
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    const text = m[2]?.toLowerCase() ?? '';
    if (text.includes(needle) || text.includes(`§${needle}`)) {
      headingLevel = m[1]?.length ?? 0;
      startIdx = i;
      break;
    }
  }

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
