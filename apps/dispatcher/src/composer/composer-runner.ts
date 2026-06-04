/**
 * Phase 2 of the Composer layer — the composer call itself.
 *
 * Single `claude -p` subprocess (per operator decision 2: Max plan via
 * subprocess, not direct API). Model is sonnet (per decision 3). Input is
 * the new task's flight plan + ancestor flight plans + actual git diffs of
 * those ancestors.
 *
 * Output is parsed as a JSON array of findings. For stage 0 this is
 * OBSERVATION ONLY — findings are logged to `composer_findings`, never block.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import type { ParsedTask } from '../types.js';
import type { AncestorContext } from './chain-context.js';
import { saveComposerRun } from './db.js';
import type {
  ComposerFinding,
  ComposerRunResult,
  FindingKind,
  FindingSeverity,
  FlightPlan,
} from './types.js';

const COMPOSER_TIMEOUT_MS = 5 * 60_000;
const COMPOSER_MODEL = 'sonnet';

const VALID_KINDS: FindingKind[] = [
  'file_conflict',
  'interface_mismatch',
  'circular_dependency',
  'missing_doc_update',
  'plan_actual_divergence',
  'unresolved_dependency',
];
const VALID_SEVERITIES: FindingSeverity[] = ['info', 'warn', 'block_recommended'];

function buildComposerPrompt(
  task: ParsedTask,
  plan: FlightPlan,
  ancestors: AncestorContext[],
): string {
  const sections: string[] = [];
  sections.push('# Nyx Composer — chain coherence review');
  sections.push('');
  sections.push("You are the Composer. Your job is to identify integration issues BEFORE a new task executes against an existing chain of changes.");
  sections.push('');
  sections.push('You receive:');
  sections.push("1. A new task's flight plan (what it intends to do).");
  sections.push('2. Flight plans + actual git diffs of its declared `[depends:]` ancestors.');
  sections.push('');
  sections.push('Output ONLY a JSON array of findings to stdout. No prose, no markdown fences, no preamble. Stop after the closing `]`.');
  sections.push('');
  sections.push('## Finding categories');
  sections.push('');
  sections.push('- `file_conflict` — new task plans to modify a file that an ancestor also modified, and the line ranges likely overlap.');
  sections.push("- `interface_mismatch` — new task's `imports_from_chain` declares an `expected_signature` that doesn't match what the ancestor's actual diff exports.");
  sections.push("- `circular_dependency` — new task's plan implies a dep on something its ancestors transitively depend on it for.");
  sections.push('- `missing_doc_update` — new task touches env vars / new endpoints / new services / auth / CORS without declaring a corresponding entry in `doc_updates`.');
  sections.push("- `plan_actual_divergence` — an ancestor's actual diff differs materially from its declared flight plan (signal that chain context is stale).");
  sections.push('- `unresolved_dependency` — new task imports a symbol from an ancestor whose plan never declares exporting it.');
  sections.push('');
  sections.push('## Severity');
  sections.push('- `info` — minor or low-confidence; informational only.');
  sections.push('- `warn` — likely real issue, worth raising in code review.');
  sections.push('- `block_recommended` — high-confidence integration break; in a future stage this would halt execution.');
  sections.push('');
  sections.push('## Output schema (strict)');
  sections.push('```json');
  sections.push(
    JSON.stringify(
      [
        {
          kind: 'file_conflict',
          severity: 'warn',
          detail: 'human-readable one-paragraph description',
          involved: ['TASK-A', 'TASK-B'],
          payload: {
            /* structured detail — files, signatures, line ranges, etc. */
          },
        },
      ],
      null,
      2,
    ),
  );
  sections.push('```');
  sections.push('');
  sections.push('Empty array `[]` is valid if you find no issues. Do not invent issues to fill the response.');
  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push('## NEW TASK');
  sections.push(`Task ID: ${task.id}`);
  sections.push(`Description: ${task.description}`);
  sections.push('');
  sections.push('### Flight plan');
  sections.push('```json');
  sections.push(JSON.stringify(plan, null, 2));
  sections.push('```');
  sections.push('');
  if (ancestors.length === 0) {
    sections.push('## ANCESTORS');
    sections.push('(none — this task has no `[depends:]` declared)');
  } else {
    sections.push(`## ANCESTORS (${ancestors.length})`);
    for (const a of ancestors) {
      sections.push('');
      sections.push(`### ${a.task_id}`);
      if (a.plan) {
        sections.push('Flight plan:');
        sections.push('```json');
        sections.push(JSON.stringify(a.plan, null, 2));
        sections.push('```');
      } else {
        sections.push('Flight plan: (none recorded — legacy task or plan-emission failed)');
      }
      if (a.actual_diff) {
        sections.push('Actual git diff:');
        sections.push('```diff');
        sections.push(a.actual_diff);
        sections.push('```');
      } else {
        sections.push('Actual git diff: (none available)');
      }
    }
  }
  sections.push('');
  sections.push('Now output the findings JSON array.');
  return sections.join('\n');
}

export interface ComposerRunInput {
  task: ParsedTask;
  plan: FlightPlan;
  ancestors: AncestorContext[];
}

export async function runComposer(input: ComposerRunInput): Promise<ComposerRunResult> {
  const composerRunId = `composer-${input.task.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const prompt = buildComposerPrompt(input.task, input.plan, input.ancestors);

  audit('composer.run.spawned', 'composer.runner', {
    taskId: input.task.id,
    composer_run_id: composerRunId,
    ancestor_count: input.ancestors.length,
    model: COMPOSER_MODEL,
  });

  // Composer cwd is a throwaway tmpdir — it has no file-system access into the
  // real working dir. All context it needs is in the prompt.
  const tmpDir = mkdtempSync(join(tmpdir(), `nyx-composer-${input.task.id}-`));

  const args = [
    '-p',
    prompt,
    '--model',
    COMPOSER_MODEL,
    '--permission-mode',
    config.claudePermissionMode,
    // Composer needs NO tools — output is stdout only.
    '--allowed-tools',
    '',
  ];

  const start = Date.now();
  // Same ANTHROPIC_API_KEY strip as other spawns. See task-runner.ts.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  if (spawnEnv.ANTHROPIC_API_KEY) {
    spawnEnv.NYX_HOST_ANTHROPIC_KEY = spawnEnv.ANTHROPIC_API_KEY;
    delete spawnEnv.ANTHROPIC_API_KEY;
  }

  const { stdout, stderr, exitCode } = await spawnWithTimeout('claude', args, {
    cwd: tmpDir,
    env: spawnEnv,
    captureStdout: true,
    label: 'composer',
  }, COMPOSER_TIMEOUT_MS);

  const durationMs = Date.now() - start;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }

  const findings = parseComposerOutput(stdout);

  const result: ComposerRunResult = {
    composer_run_id: composerRunId,
    task_id: input.task.id,
    ancestor_task_ids: input.ancestors.map((a) => a.task_id),
    findings,
    raw_response: stdout,
    duration_ms: durationMs,
    model: COMPOSER_MODEL,
  };

  // Persist even on partial failure — raw response is training data for v1+.
  saveComposerRun(result);

  audit('composer.run.completed', 'composer.runner', {
    taskId: input.task.id,
    composer_run_id: composerRunId,
    finding_count: findings.length,
    finding_kinds: countKinds(findings),
    duration_ms: durationMs,
    exit_code: exitCode,
    parse_status:
      findings.length > 0 || stdout.trim() === '[]'
        ? 'parsed'
        : 'unparseable',
    stderr_excerpt: stderr.slice(-500),
  });

  return result;
}

/**
 * Parse the composer's stdout into a findings array. Lenient: strips markdown
 * fences if present, extracts the first `[ ... ]` span, JSON-parses, filters
 * to valid kind/severity values. If parsing fails entirely, returns []; the
 * raw stdout is still saved on the run row for v1+ training.
 */
export function parseComposerOutput(stdout: string): ComposerFinding[] {
  if (!stdout.trim()) return [];
  let cleaned = stdout.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\n?([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) cleaned = fenceMatch[1].trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  cleaned = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const r = raw as Record<string, unknown>;
      const kind = VALID_KINDS.includes(r.kind as FindingKind) ? (r.kind as FindingKind) : null;
      const severity = VALID_SEVERITIES.includes(r.severity as FindingSeverity)
        ? (r.severity as FindingSeverity)
        : 'info';
      if (!kind) return [];
      return [
        {
          kind,
          severity,
          detail: typeof r.detail === 'string' ? r.detail : '',
          involved: Array.isArray(r.involved)
            ? r.involved.filter((x): x is string => typeof x === 'string')
            : [],
          payload:
            r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
              ? (r.payload as Record<string, unknown>)
              : {},
        },
      ];
    });
  } catch {
    return [];
  }
}

function countKinds(findings: ComposerFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) {
    out[f.kind] = (out[f.kind] ?? 0) + 1;
  }
  return out;
}
