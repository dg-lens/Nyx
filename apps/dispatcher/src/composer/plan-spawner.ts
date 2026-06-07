/**
 * Phase 1 of the Composer layer — plan-only spawn.
 *
 * Spawns `claude -p` with a planning-mode prompt that asks the agent to read
 * the codebase and emit ONLY a flight plan JSON to `.nyx/flight-plan.json`
 * in the working dir. The execution phase (the existing invokeClaude flow)
 * then runs with the plan injected into its prompt.
 *
 * Permission profile: Read/Glob/Grep/Bash for exploration, Write for the plan
 * file. No MCPs. The dispatcher deletes `.nyx/` after reading the plan so
 * phase 3 starts with a clean working dir.
 *
 * Per operator decision 1: two-phase spawn (plan-only call returns JSON,
 * dispatcher inspects, then execution call).
 * Per operator decision 2: claude -p subprocess (Max plan), not direct API.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { audit } from '../audit.js';
import { config } from '../config.js';
import { spawnWithTimeout } from '../spawn-helpers.js';
import type { ParsedTask } from '../types.js';
import { FLIGHT_PLAN_SCHEMA_VERSION, type FlightPlan } from './types.js';

const PLAN_TIMEOUT_MS = 5 * 60_000;
const PLAN_DIR = '.nyx';
const PLAN_FILE = `${PLAN_DIR}/flight-plan.json`;

export interface PlanSpawnResult {
  status: 'ok' | 'missing' | 'invalid_json' | 'spawn_failed';
  plan?: FlightPlan;
  rawContent?: string;
  parseError?: string;
  durationMs: number;
  exitCode: number;
  stderr: string;
  killedByTimeout?: boolean;
}

function buildPlanPrompt(task: ParsedTask): string {
  const sections: string[] = [];
  sections.push(`# Nyx flight-plan phase: ${task.id}`);
  sections.push('');
  sections.push('You are in the PLANNING phase for this task. Do NOT modify any source files. Do NOT commit. Read the codebase enough to understand what you would do, then output a flight plan and exit.');
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
  sections.push(`Write a JSON file at \`${PLAN_FILE}\` (mkdir \`${PLAN_DIR}\` first) matching exactly this schema:`);
  sections.push('');
  sections.push('```json');
  sections.push(
    JSON.stringify(
      {
        schema_version: FLIGHT_PLAN_SCHEMA_VERSION,
        task_id: task.id,
        task_summary: 'one-line summary of what this task accomplishes',
        drafted_at: 'ISO-8601 timestamp (e.g. 2026-05-25T17:30:00Z)',
        files: {
          create: ['paths/relative/to/repo/root.ts'],
          modify: ['paths/...'],
          delete: ['paths/...'],
        },
        exports: [
          {
            file: 'path/...',
            symbol: 'functionName | ClassName | const NAME',
            signature: 'TS- or Python-style signature',
            purpose: 'one-line why this exists',
          },
        ],
        depends_on_tasks: task.depends ?? [],
        imports_from_chain: [
          {
            from_task: 'ANCESTOR-TASK-ID',
            file: 'path/...',
            symbol: 'functionName',
            expected_signature: 'TS- or Python-style',
          },
        ],
        doc_updates: [
          {
            tier: 'T1 | T2 | T3 | T4',
            path: 'absolute or repo-relative path to the CLAUDE.md file',
            section: 'section name (e.g. "Required env vars")',
            change_summary: 'one-line',
          },
        ],
        revisable: true,
        revision_of: null,
        estimated_risk: 'low | medium | high',
        notes: 'freeform — context the composer should know',
      },
      null,
      2,
    ),
  );
  sections.push('```');
  sections.push('');
  sections.push('## Rules');
  sections.push('- Output ONLY the file. Do not write any other files. Do not modify source.');
  sections.push('- If the task description is vague, fill in your best understanding. The plan is REVISABLE — set `revisable: true`.');
  sections.push('- `imports_from_chain` is empty UNLESS your task depends on output from an upstream task (declared in `[depends:]`).');
  sections.push('- `doc_updates` declares any CLAUDE.md / docs updates your work will need to make. Required if your work adds env vars, new endpoints, new third-party services, etc. See `~/.claude/CLAUDE.md` §5 for the trigger table.');
  sections.push('- Use Bash for `ls`/`cat`/`grep` style exploration. You CANNOT commit, push, or modify source files in this phase.');
  sections.push('- Exit cleanly after writing the file. Nyx will re-spawn you with full permissions in the execution phase.');
  sections.push('');
  sections.push(`Working dir is the cwd. Write the file at \`${PLAN_FILE}\` relative to cwd.`);
  return sections.join('\n');
}

/**
 * Tool profile for planning: read + write + bash exploration. No MCPs. The
 * agent CAN write to the working dir (needs to in order to write the plan
 * file), but the dispatcher deletes `.nyx/` after reading so the execute
 * phase sees a clean tree.
 */
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Bash', 'TodoWrite'];

function planPermissionArgs(): string[] {
  return [
    '--permission-mode',
    config.claudePermissionMode,
    '--allowed-tools',
    PLAN_TOOLS.join(' '),
  ];
}

export async function runPlanSpawn(task: ParsedTask, workingDir: string): Promise<PlanSpawnResult> {
  const prompt = buildPlanPrompt(task);
  const args = [
    '-p',
    prompt,
    '--model',
    task.model,
    ...planPermissionArgs(),
    '--add-dir',
    workingDir,
  ];

  audit('task.flight_plan.spawned', 'composer.plan-spawner', {
    taskId: task.id,
    model: task.model,
  });

  const start = Date.now();
  // Auth: ANTHROPIC_API_KEY passes through if set, else OAuth — matching
  // task-runner.ts::invokeClaude.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };

  const spawnResult = await spawnWithTimeout('claude', args, {
    cwd: workingDir,
    env: spawnEnv,
    captureStdout: false,
    label: 'plan-spawner',
  }, PLAN_TIMEOUT_MS);

  const durationMs = Date.now() - start;
  const killedByTimeout = spawnResult.killedByTimeout;

  // A non-zero exit (especially exitCode 124 from a wall-clock timeout) does NOT
  // mean the plan is unusable. The planning agent's whole job is to write
  // `.nyx/flight-plan.json` and exit; a slow exit (tool grandchildren keeping
  // pipes open, or drift after the write) trips the timeout even though a
  // complete, valid plan is already on disk. Mirror the audit-pass salvage
  // protocol: inspect the artifact before discarding. Only report spawn_failed
  // when the process failed AND no plan artifact was produced.
  const planPath = resolve(workingDir, PLAN_FILE);
  if (!existsSync(planPath)) {
    return {
      status: spawnResult.exitCode !== 0 ? 'spawn_failed' : 'missing',
      durationMs,
      exitCode: spawnResult.exitCode,
      stderr: spawnResult.stderr,
      killedByTimeout,
    };
  }

  const rawContent = readFileSync(planPath, 'utf8');
  try {
    const parsed = JSON.parse(rawContent) as unknown;
    const plan = validateFlightPlanShape(parsed, task.id);
    if (!plan) {
      return {
        status: 'invalid_json',
        rawContent,
        parseError: 'shape validation failed (wrong schema_version, or not an object)',
        durationMs,
        exitCode: spawnResult.exitCode,
        stderr: spawnResult.stderr,
        killedByTimeout,
      };
    }
    return {
      status: 'ok',
      plan,
      rawContent,
      durationMs,
      exitCode: spawnResult.exitCode,
      stderr: spawnResult.stderr,
      killedByTimeout,
    };
  } catch (err) {
    return {
      status: 'invalid_json',
      rawContent,
      parseError: (err as Error).message,
      durationMs,
      exitCode: spawnResult.exitCode,
      stderr: spawnResult.stderr,
      killedByTimeout,
    };
  }
}

/**
 * Lenient shape validator. Stage 0 goal is to collect plans, not to enforce
 * strict schema compliance. We require schema_version match + an object; the
 * rest is best-effort. Missing fields → defaults. Wrong types → coerced or
 * empty. Minimizes plan rejection in stage 0.
 */
export function validateFlightPlanShape(raw: unknown, taskId: string): FlightPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== FLIGHT_PLAN_SCHEMA_VERSION) return null;
  const files = r.files && typeof r.files === 'object' ? (r.files as Record<string, unknown>) : {};
  return {
    schema_version: FLIGHT_PLAN_SCHEMA_VERSION,
    task_id: typeof r.task_id === 'string' ? r.task_id : taskId,
    task_summary: typeof r.task_summary === 'string' ? r.task_summary : '',
    drafted_at: typeof r.drafted_at === 'string' ? r.drafted_at : new Date().toISOString(),
    files: {
      create: arrOfStr(files.create),
      modify: arrOfStr(files.modify),
      delete: arrOfStr(files.delete),
    },
    exports: arrOfObj(r.exports).map((e) => ({
      file: typeof e.file === 'string' ? e.file : '',
      symbol: typeof e.symbol === 'string' ? e.symbol : '',
      signature: typeof e.signature === 'string' ? e.signature : '',
      purpose: typeof e.purpose === 'string' ? e.purpose : '',
    })),
    depends_on_tasks: arrOfStr(r.depends_on_tasks),
    imports_from_chain: arrOfObj(r.imports_from_chain).map((i) => ({
      from_task: typeof i.from_task === 'string' ? i.from_task : '',
      file: typeof i.file === 'string' ? i.file : '',
      symbol: typeof i.symbol === 'string' ? i.symbol : '',
      expected_signature: typeof i.expected_signature === 'string' ? i.expected_signature : '',
    })),
    doc_updates: arrOfObj(r.doc_updates).map((d) => ({
      tier: (['T1', 'T2', 'T3', 'T4'].includes(d.tier as string) ? d.tier : 'T2') as 'T1' | 'T2' | 'T3' | 'T4',
      path: typeof d.path === 'string' ? d.path : '',
      section: typeof d.section === 'string' ? d.section : '',
      change_summary: typeof d.change_summary === 'string' ? d.change_summary : '',
    })),
    revisable: r.revisable !== false,
    revision_of: typeof r.revision_of === 'string' ? r.revision_of : null,
    estimated_risk: (['low', 'medium', 'high'].includes(r.estimated_risk as string)
      ? r.estimated_risk
      : 'medium') as 'low' | 'medium' | 'high',
    notes: typeof r.notes === 'string' ? r.notes : '',
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

/**
 * Delete `.nyx/flight-plan.json` and the `.nyx/` directory from the
 * working dir so the execution phase doesn't see the file and so it doesn't
 * get committed. Best-effort — failures are non-fatal.
 */
export function removeFlightPlanArtifact(workingDir: string): void {
  const planPath = resolve(workingDir, PLAN_FILE);
  if (existsSync(planPath)) {
    try {
      rmSync(planPath);
    } catch {
      /* swallow */
    }
  }
  const planDir = resolve(workingDir, PLAN_DIR);
  if (existsSync(planDir)) {
    try {
      rmSync(planDir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  }
}
