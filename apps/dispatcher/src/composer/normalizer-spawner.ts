/**
 * Normalizer spawn — the LLM half of the pre-dispatch normalizer (shadow stage).
 *
 * Spawns a read-only `claude -p` (model sonnet) that inspects the actual repo to
 * VERIFY every file path / symbol the task references, surfaces contradictions /
 * missing constraints, and writes a tightened spec to `.nyx/normalized-spec.json`
 * conforming to `NormalizedSpec`. Mirrors plan-spawner's artifact-read-then-remove
 * pattern: the agent writes ONE JSON file and exits; we read + validate + delete.
 *
 * Tools are restricted to Read/Glob/Grep — the normalizer NEVER modifies the
 * repo. Malformed / missing output → returns null; the caller treats null as a
 * skip (shadow stage tolerates failure, never blocks).
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../config.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import type { ParsedTask } from '../types.js';
import type { NormalizedSpec, NormalizationVerdict } from './types.js';

const NORMALIZE_TIMEOUT_MS = 5 * 60_000;
const NORMALIZE_DIR = '.nyx';
const NORMALIZE_FILE = `${NORMALIZE_DIR}/normalized-spec.json`;
const NORMALIZE_MODEL = 'sonnet';

export interface NormalizerSpawnResult {
  spec: NormalizedSpec;
  rawResponse: string;
}

/**
 * Closed set of reasons the spawn failed to produce a usable spec. Each maps
 * 1:1 to a `failure_class` in the outcomes taxonomy. Keeping these structurally
 * distinct (vs. all collapsed into one "spawn produced no usable spec" string)
 * is the point — it's what lets the operator-review CLI tell artifact_missing
 * apart from artifact_malformed_json.
 */
export type NormalizerSpawnFailureClass =
  | 'spawn_failed'
  | 'artifact_missing'
  | 'artifact_unreadable'
  | 'artifact_malformed_json'
  | 'artifact_invalid_shape';

export type NormalizerSpawnOutcome =
  | { ok: true; result: NormalizerSpawnResult }
  | { ok: false; failure_class: NormalizerSpawnFailureClass; detail?: string };

function buildNormalizePrompt(task: ParsedTask): string {
  const sections: string[] = [];
  sections.push(`# Nyx pre-dispatch normalizer: ${task.id}`);
  sections.push('');
  sections.push(
    'You are the NORMALIZER. You compile a task spec into a tightened, executable form BEFORE any coding agent runs. You do NOT write code, modify files, or commit. You inspect the repo READ-ONLY to ground your output in reality, then write ONE JSON file and exit.',
  );
  sections.push('');
  sections.push('## Your job');
  sections.push('1. Read the task description below.');
  sections.push('2. For EVERY file path and symbol the task references, verify it actually exists in this repo (use Read/Glob/Grep). Record each in `resolved_paths` with an honest `exists` flag.');
  sections.push('3. Detect ambiguities, contradictions, and missing constraints. List them in `verdict.blocking_issues`.');
  sections.push('4. Tighten the spec deterministically: produce `tightened_body` (the exact, unambiguous instruction set), concrete `acceptance_criteria`, and `anti_examples` (wrong approaches to avoid).');
  sections.push('5. Judge `verdict.solvable` and `verdict.complete` HONESTLY — do not inflate. If the spec cannot be executed as written, say so.');
  sections.push('');
  sections.push('## Task description');
  sections.push(task.description);
  sections.push('');
  if (task.repo) sections.push(`Repo: ${task.repo}`);
  sections.push(`Task type: ${task.type}`);
  if (task.depends && task.depends.length > 0) {
    sections.push(`Depends on tasks: ${task.depends.join(', ')}`);
  }
  sections.push('');
  sections.push('## What to produce');
  sections.push('');
  sections.push(`Write a JSON file at \`${NORMALIZE_FILE}\` (mkdir \`${NORMALIZE_DIR}\` first) matching exactly this schema:`);
  sections.push('');
  sections.push('```json');
  sections.push(
    JSON.stringify(
      {
        task_id: task.id,
        tightened_body: 'the exact, unambiguous instruction set a coding agent would execute',
        acceptance_criteria: ['concrete checkable criterion 1', 'criterion 2'],
        anti_examples: ['wrong approach the agent must NOT take'],
        resolved_paths: [
          { path: 'src/foo.ts', exists: true },
          { path: 'src/missing.ts', exists: false },
        ],
        verdict: {
          solvable: 'yes | no | uncertain',
          complete: 'yes | no',
          redundant_with: ['TASK-ID this duplicates, if any'],
          blocking_issues: ['contradiction or missing constraint, if any'],
        },
      },
      null,
      2,
    ),
  );
  sections.push('```');
  sections.push('');
  sections.push('## Rules');
  sections.push('- Output ONLY the file. Do not write any other files. Do not modify source. You have Read/Glob/Grep only.');
  sections.push('- `resolved_paths` MUST reflect what you actually found in the repo — set `exists: false` for any path the task names that is absent.');
  sections.push('- Empty arrays are valid. Do not invent issues to fill `blocking_issues`.');
  sections.push('- Be honest about `solvable`/`complete`. A vague or self-contradictory spec is `complete: "no"` with the gap named in `blocking_issues`.');
  sections.push('- After writing the file, output the single line `NORMALIZE COMPLETE` and emit NO further tool calls.');
  sections.push('');
  sections.push(`Working dir is the cwd. Write the file at \`${NORMALIZE_FILE}\` relative to cwd.`);
  return sections.join('\n');
}

const NORMALIZE_TOOLS = ['Read', 'Glob', 'Grep'];

/**
 * Run the normalizer spawn. Returns a discriminated outcome — `{ ok: true }`
 * with the parsed spec, or `{ ok: false }` with the specific
 * `failure_class` that broke. Never throws — the caller treats `ok: false` as
 * a structured skip, not an exception.
 *
 * The discriminated `failure_class` is load-bearing: it is what unblocks the
 * rollup of "what failed in this stage and why" (was previously collapsed into
 * one prose string).
 */
export async function runNormalizerSpawn(
  task: ParsedTask,
  workingDir: string,
): Promise<NormalizerSpawnOutcome> {
  const prompt = buildNormalizePrompt(task);
  const args = [
    '-p',
    prompt,
    '--model',
    NORMALIZE_MODEL,
    '--permission-mode',
    config.claudePermissionMode,
    '--allowed-tools',
    NORMALIZE_TOOLS.join(' '),
    '--add-dir',
    workingDir,
  ];

  // Auth: ANTHROPIC_API_KEY passes through if set, else OAuth — matching
  // plan-spawner.ts / composer-runner.ts.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };

  try {
    await spawnWithTimeout(
      'claude',
      args,
      {
        cwd: workingDir,
        env: spawnEnv,
        captureStdout: true,
        label: 'normalizer-spawner',
      },
      NORMALIZE_TIMEOUT_MS,
    );
  } catch (err) {
    return { ok: false, failure_class: 'spawn_failed', detail: (err as Error).message };
  }

  // Mirror plan-spawner's salvage: a non-zero/timeout exit does NOT mean the
  // artifact is unusable — inspect it before discarding. The whole job is to
  // write the file and exit; a slow exit still leaves a valid spec on disk.
  const specPath = resolve(workingDir, NORMALIZE_FILE);
  if (!existsSync(specPath)) {
    return { ok: false, failure_class: 'artifact_missing' };
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(specPath, 'utf8');
  } catch (err) {
    removeNormalizedSpecArtifact(workingDir);
    return { ok: false, failure_class: 'artifact_unreadable', detail: (err as Error).message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent) as unknown;
  } catch (err) {
    removeNormalizedSpecArtifact(workingDir);
    return {
      ok: false,
      failure_class: 'artifact_malformed_json',
      detail: (err as Error).message,
    };
  }

  const spec = validateNormalizedSpecShape(parsed, task.id);
  removeNormalizedSpecArtifact(workingDir);
  if (!spec) {
    return { ok: false, failure_class: 'artifact_invalid_shape' };
  }
  return { ok: true, result: { spec, rawResponse: rawContent } };
}

/**
 * Lenient shape validator for the normalized spec. Coerces missing/wrong-typed
 * fields to safe defaults; returns null only when the input isn't an object.
 * Shadow stage favors collecting a usable spec over strict rejection — but a
 * non-object (or unparseable) artifact is always a skip.
 */
export function validateNormalizedSpecShape(raw: unknown, taskId: string): NormalizedSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const v =
    r.verdict && typeof r.verdict === 'object' && !Array.isArray(r.verdict)
      ? (r.verdict as Record<string, unknown>)
      : {};

  const verdict: NormalizationVerdict = {
    solvable: (['yes', 'no', 'uncertain'].includes(v.solvable as string)
      ? v.solvable
      : 'uncertain') as NormalizationVerdict['solvable'],
    complete: (v.complete === 'yes' ? 'yes' : v.complete === 'no' ? 'no' : 'no') as
      NormalizationVerdict['complete'],
    redundant_with: arrOfStr(v.redundant_with),
    blocking_issues: arrOfStr(v.blocking_issues),
  };

  return {
    task_id: typeof r.task_id === 'string' ? r.task_id : taskId,
    tightened_body: typeof r.tightened_body === 'string' ? r.tightened_body : '',
    acceptance_criteria: arrOfStr(r.acceptance_criteria),
    anti_examples: arrOfStr(r.anti_examples),
    resolved_paths: arrOfObj(r.resolved_paths).map((p) => ({
      path: typeof p.path === 'string' ? p.path : '',
      exists: p.exists === true,
    })),
    verdict,
  };
}

function arrOfStr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function arrOfObj(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x),
  );
}

/** Delete `.nyx/normalized-spec.json` + the `.nyx/` dir. Best-effort. */
export function removeNormalizedSpecArtifact(workingDir: string): void {
  const specPath = resolve(workingDir, NORMALIZE_FILE);
  if (existsSync(specPath)) {
    try {
      rmSync(specPath);
    } catch {
      /* swallow */
    }
  }
  const specDir = resolve(workingDir, NORMALIZE_DIR);
  if (existsSync(specDir)) {
    try {
      rmSync(specDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
}
