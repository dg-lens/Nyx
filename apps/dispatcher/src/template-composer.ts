/**
 * Template composer — turns a natural-language prompt (the desktop Create
 * Templates page, via a `compose_template` control action) into ONE validated
 * personal template appended to $NYX_DATA_DIR/templates.json with
 * `source: "ai"`. Mirrors decomposer.ts deliberately: same sonnet `claude -p`
 * spawn + auth model, same marker-fenced output protocol — the validation and
 * the atomic corrupt-safe write here are the unit-testable surface.
 *
 * templates.json is OWNED by the desktop TemplatesStore (schema v1, see
 * desktop/Sources/NyxDesktop/Views/TemplatesStore.swift). This module must
 * stay in lockstep with that schema: it never rewrites existing entries, only
 * appends one validated template, and it REFUSES to overwrite a file it cannot
 * parse — the desktop's corrupt-safe posture (preserve the bad file for
 * inspection) applies on this side too.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { spawnWithTimeout } from './spawn-helpers.js';
import { config } from './config.js';

export interface ComposeTemplateIntent {
  prompt: string;
  kind?: string; // task | workflow
}

export interface StoredTemplate {
  id: string;
  name: string;
  folderId: string | null;
  kind: 'task' | 'workflow';
  text: string;
  type: string;
  model: string;
  gate: string;
  priority: string;
  repo: string | null;
  schedule: string | null;
  createdAt: string;
  source: 'manual' | 'promoted' | 'ai';
}

const VALID_TYPES = ['code', 'content', 'analysis', 'assistant', 'pipeline'];
const VALID_MODELS = ['haiku', 'sonnet', 'opus', 'auto'];
const VALID_GATE_STAGES = ['typecheck', 'tests', 'lint'];
const VALID_PRIORITIES = ['high', 'normal', 'low'];

export function templatesStorePath(): string {
  return resolve(config.dataDir, 'templates.json');
}

export function buildComposeTemplatePrompt(intent: ComposeTemplateIntent): string {
  const kind = intent.kind === 'workflow' ? 'workflow' : 'task';
  return [
    `You draft ONE personal template for the Nyx desktop template library. A template is a reusable, fully-specified task/workflow spec the operator re-issues with one click — the operator never writes tag syntax, so every field must be concrete.`,
    ``,
    `Output a single JSON object with EXACTLY these fields:`,
    `{`,
    `  "name": "<short human-readable template name, 2-6 words>",`,
    `  "kind": "task" | "workflow",`,
    `  "text": "<the full plain-language description the dispatcher decomposes at issue time — concrete and self-contained>",`,
    `  "type": "code" | "content" | "analysis" | "assistant" | "pipeline",`,
    `  "model": "haiku" | "sonnet" | "opus" | "auto",`,
    `  "gate": "typecheck,tests" | "typecheck" | "tests" | "lint" | "none",`,
    `  "priority": "high" | "normal" | "low",`,
    `  "repo": "<org/name>" or null,`,
    `  "schedule": "slot:<0-287>" | "every:<Xm|Xh|Xd>" or null`,
    `}`,
    ``,
    `Rules:`,
    `- kind "workflow" is a multi-step pipeline; its type MUST be "pipeline". kind "task" uses one of the other four types.`,
    `- schedule null means a standing (run-when-picked) task. Only schedule when the prompt clearly asks for a recurrence or a daily time.`,
    `- repo only when the prompt names a repository.`,
    ``,
    `Requested kind: ${kind}`,
    ``,
    `Operator prompt:`,
    intent.prompt,
    ``,
    `Output ONLY the JSON object, wrapped exactly between a line "<<<TEMPLATE" and a line "TEMPLATE>>>". No preamble, no explanation, nothing else.`,
  ].join('\n');
}

export function parseTemplateOutput(stdout: string): unknown | null {
  const marked = stdout.match(/<<<TEMPLATE\s*\n([\s\S]*?)\n\s*TEMPLATE>>>/);
  const body = marked?.[1]?.trim();
  if (body) {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  // Fallback: salvage the outermost JSON object if the markers were dropped.
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(stdout.slice(first, last + 1));
  } catch {
    return null;
  }
}

function asTrimmedString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function pickEnum(v: unknown, valid: string[], fallback: string): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return valid.includes(s) ? s : fallback;
}

function validGate(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'none') return 'none';
  if (!s) return null;
  const stages = s.split(',').map((x) => x.trim());
  return stages.length > 0 && stages.every((x) => VALID_GATE_STAGES.includes(x)) ? stages.join(',') : null;
}

function validSchedule(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  const slot = /^slot:(\d+)$/.exec(s);
  if (slot) {
    const n = Number(slot[1]);
    return n >= 0 && n < 288 ? s : null;
  }
  return /^every:\d+[mhd]$/.test(s) ? s : null;
}

function validRepo(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null;
}

/**
 * Validate a raw composed object into a StoredTemplate, or null if it lacks
 * the two load-bearing fields (name, text). Everything else is forgiving:
 * invalid enums fall back to defaults, malformed repo/schedule drop to null.
 * `nowIso`/`id` are injected (never Date.now-dependent here) so the path is
 * deterministic under test. source is FORCED to "ai" and folderId to null —
 * AI drafts always land ungrouped, never claim operator provenance.
 */
export function validateComposedTemplate(
  raw: unknown,
  opts: { kind?: string; nowIso: string; id?: string },
): StoredTemplate | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const name = asTrimmedString(obj['name']);
  const text = asTrimmedString(obj['text']);
  if (!name || !text) return null;

  const rawKind = typeof obj['kind'] === 'string' ? obj['kind'].trim().toLowerCase() : '';
  const intentKind = opts.kind === 'workflow' ? 'workflow' : opts.kind === 'task' ? 'task' : null;
  const resolvedKind: 'task' | 'workflow' =
    intentKind ?? (rawKind === 'workflow' ? 'workflow' : 'task');

  const type = resolvedKind === 'workflow' ? 'pipeline' : pickEnum(obj['type'], VALID_TYPES, 'code');
  // Taxonomy invariant (matches the desktop): workflow ⟺ pipeline. A
  // kind:"task" draft whose type resolves to "pipeline" would contradict it,
  // so the type wins and kind is forced to "workflow".
  const kind: 'task' | 'workflow' = type === 'pipeline' ? 'workflow' : resolvedKind;
  const gate = validGate(obj['gate']) ?? (type === 'code' ? 'typecheck,tests' : 'none');

  return {
    id: opts.id ?? `tpl-${randomUUID().slice(0, 8)}`,
    name,
    folderId: null,
    kind,
    text,
    type,
    model: pickEnum(obj['model'], VALID_MODELS, 'auto'),
    gate,
    priority: pickEnum(obj['priority'], VALID_PRIORITIES, 'normal'),
    repo: validRepo(obj['repo']),
    schedule: validSchedule(obj['schedule']),
    createdAt: opts.nowIso,
    source: 'ai',
  };
}

interface TemplatesDoc {
  version: number;
  folders: unknown[];
  templates: unknown[];
  [k: string]: unknown;
}

/**
 * Append one template to the store with an atomic tmp+rename write. A missing
 * file seeds a fresh v1 doc; an UNPARSEABLE file throws (the action is marked
 * failed) rather than being clobbered — the desktop preserves corrupt files
 * for inspection and this writer must not destroy that evidence. Unknown
 * top-level fields in an existing doc round-trip untouched.
 */
export function writeTemplateIntoStore(path: string, template: StoredTemplate): void {
  let doc: TemplatesDoc = { version: 1, folders: [], templates: [] };
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('templates.json unreadable — refusing to overwrite (fix or remove the file)');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('templates.json has an unexpected shape — refusing to overwrite');
    }
    const p = parsed as Record<string, unknown>;
    doc = {
      ...p,
      version: typeof p['version'] === 'number' ? p['version'] : 1,
      folders: Array.isArray(p['folders']) ? p['folders'] : [],
      templates: Array.isArray(p['templates']) ? p['templates'] : [],
    };
  }
  doc.templates.push(template);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export async function invokeTemplateComposer(
  intent: ComposeTemplateIntent,
  timeoutMs = 180_000,
): Promise<{ template: StoredTemplate | null; error?: string }> {
  if (!intent.prompt || !intent.prompt.trim()) return { template: null, error: 'empty prompt' };
  const prompt = buildComposeTemplatePrompt(intent);
  const args = ['-p', prompt, '--model', 'sonnet'];
  // Same auth model as invokeDecomposer: ANTHROPIC_API_KEY passes through if
  // set (API billing), otherwise claude -p falls back to ~/.claude OAuth (Max).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  const result = await spawnWithTimeout(
    'claude',
    args,
    { cwd: config.dataDir, env, captureStdout: true, label: 'nyx-compose-template' },
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    return { template: null, error: `composer exit ${result.exitCode}: ${result.stderr.slice(0, 300)}` };
  }
  const raw = parseTemplateOutput(result.stdout);
  if (raw === null) return { template: null, error: 'composer produced no parseable template' };
  const template = validateComposedTemplate(raw, { ...(intent.kind ? { kind: intent.kind } : {}), nowIso: new Date().toISOString() });
  return template ? { template } : { template: null, error: 'composed template failed validation (missing name or text)' };
}
