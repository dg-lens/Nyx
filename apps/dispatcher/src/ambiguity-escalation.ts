import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AMBIGUITY_FILE = '.nyx/ambiguity.json';

export interface AmbiguityOption {
  label: string;
  description: string;
  pros?: string;
  cons?: string;
}

export interface AmbiguityEscalation {
  schema_version: 1;
  task_id: string;
  question: string;
  options: AmbiguityOption[];
  my_lean?: string;
  lean_reason?: string;
}

export function parseAmbiguityFile(workingDirPath: string): AmbiguityEscalation | null {
  const filePath = resolve(workingDirPath, AMBIGUITY_FILE);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isAmbiguityEscalation(parsed)) return null;
  return parsed;
}

function isAmbiguityEscalation(v: unknown): v is AmbiguityEscalation {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;

  if (obj['schema_version'] !== 1) return false;
  if (typeof obj['task_id'] !== 'string' || !obj['task_id']) return false;
  if (typeof obj['question'] !== 'string' || !obj['question']) return false;
  if (!Array.isArray(obj['options']) || obj['options'].length < 2) return false;

  for (const opt of obj['options']) {
    if (typeof opt !== 'object' || opt === null) return false;
    const o = opt as Record<string, unknown>;
    if (typeof o['label'] !== 'string' || !o['label']) return false;
    if (typeof o['description'] !== 'string' || !o['description']) return false;
    if (o['pros'] !== undefined && typeof o['pros'] !== 'string') return false;
    if (o['cons'] !== undefined && typeof o['cons'] !== 'string') return false;
  }

  if (obj['my_lean'] !== undefined && typeof obj['my_lean'] !== 'string') return false;
  if (obj['lean_reason'] !== undefined && typeof obj['lean_reason'] !== 'string') return false;

  return true;
}

export function buildAmbiguityHaltReport(escalation: AmbiguityEscalation): string {
  const lines: string[] = [];

  lines.push(`Decision required: ${escalation.question}`);
  lines.push('');
  lines.push('Options:');

  for (const opt of escalation.options) {
    lines.push(`  ${opt.label}: ${opt.description}`);
    if (opt.pros) lines.push(`    pros: ${opt.pros}`);
    if (opt.cons) lines.push(`    cons: ${opt.cons}`);
  }

  if (escalation.my_lean) {
    lines.push('');
    lines.push(`Agent lean: ${escalation.my_lean}`);
    if (escalation.lean_reason) {
      lines.push(`Reason: ${escalation.lean_reason}`);
    }
  }

  return lines.join('\n');
}
