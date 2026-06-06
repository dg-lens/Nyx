/**
 * Task decomposer — turns a natural-language dispatch request (from the desktop
 * Dispatch tab, or any decompose_task control action) into one or more
 * fully-tagged queue tasks via a sonnet `claude -p` call, so the operator never
 * has to hand-write the task-tag syntax.
 */
import { spawnWithTimeout } from './spawn-helpers.js';
import { config } from './config.js';

export interface DecomposeIntent {
  text: string;
  type?: string; // code | analysis | assistant | content | pipeline
  model?: string; // haiku | sonnet | opus | auto
  priority?: string; // high | normal | low
  repo?: string;
  schedule?: string; // "slot:<0-287>" (daily at time) | "every:<Xh|Xd>" (recurring) | undefined (standing)
}

const TASK_FORMAT = `Queue task format — a checkbox line plus indented tag lines:

- [ ] TASK-ID — one-line description
      [type: code|content|analysis|assistant|pipeline]
      [model: haiku|sonnet|opus]      (optional; defaults by type)
      [gate: typecheck,tests|none]    (code only; default typecheck,tests)
      [priority: high|normal|low]     (optional; default normal)
      [repo: org/name]                (code/analysis/pipeline against a repo)
      [depends: OTHER-ID]             (optional; this task waits for OTHER-ID)
      [env: NAME1, NAME2]             (optional; env vars the task needs)
      [expects: path1, path2]         (optional; files the task must produce)

Rules:
- TASK-ID: short uppercase slug derived from the work, unique per task.
- Single unit of work -> one task. Naturally separable work -> several tasks
  ordered with [depends:].
- Keep each description concrete and self-contained.`;

export function buildDecomposerPrompt(intent: DecomposeIntent): string {
  const isPipeline = (intent.type ?? '').toLowerCase() === 'pipeline';
  const lines: string[] = [];

  if (isPipeline) {
    // Pipeline tasks are NOT decomposed here — the pipeline's own planning stage
    // splits the work into phases + parallel coders. The decomposer just fleshes
    // the idea out into one self-contained brief.
    lines.push(
      `You are Nyx's task decomposer. The operator chose the PIPELINE type. Do NOT split this into multiple tasks — the pipeline runs its OWN planning stage that decomposes the work into phases and parallel coders.`,
      `Emit EXACTLY ONE [type: pipeline] task whose description is the operator's idea FLESHED OUT: a clear, self-contained brief (goal, scope, key surfaces/pages, data model + constraints) — concrete enough for the pipeline to plan from, but NOT itself a task breakdown.`,
      ``,
      TASK_FORMAT,
      ``,
      `Put [type: pipeline] on the single task. Do NOT add [model:] or [gate:] — the pipeline picks per-stage models and gates itself.`,
    );
    if (intent.repo) lines.push(`Put [repo: ${intent.repo}].`);
    if (intent.priority && intent.priority !== 'normal') lines.push(`Put [priority: ${intent.priority}].`);
    if (intent.schedule?.startsWith('slot:')) lines.push(`Add [slot: ${intent.schedule.slice(5)}].`);
    else if (intent.schedule?.startsWith('every:')) lines.push(`Add [every: ${intent.schedule.slice(6)}].`);
  } else {
    lines.push(
      `You are Nyx's task decomposer. Convert the operator's request into one or more queue tasks.`,
      `Emit ONE detailed task if the request is a single unit of work, or SEVERAL tasks (ordered with [depends:]) if it naturally splits.`,
      ``,
      TASK_FORMAT,
      ``,
    );
    if (intent.model && intent.model !== 'auto') {
      lines.push(`Put [model: ${intent.model}] on every task.`);
    } else {
      lines.push(
        `Choose [model:] per task: haiku for simple/mechanical work, sonnet for normal code/analysis, opus for complex reasoning or risky changes.`,
      );
    }
    if (intent.type) lines.push(`Default [type:] is ${intent.type} unless the work clearly calls for another.`);
    if (intent.repo) lines.push(`Put [repo: ${intent.repo}] on code/analysis/pipeline tasks.`);
    if (intent.priority && intent.priority !== 'normal') lines.push(`Put [priority: ${intent.priority}] on the tasks.`);
    if (intent.schedule?.startsWith('slot:')) {
      lines.push(`Schedule it with [slot: ${intent.schedule.slice(5)}] — runs once daily at that 5-minute slot. Prefer emitting a single task.`);
    } else if (intent.schedule?.startsWith('every:')) {
      lines.push(`Schedule it with [every: ${intent.schedule.slice(6)}] — a recurring cadence. Prefer emitting a single task.`);
    }
  }
  lines.push(``, `Operator request:`, intent.text, ``);
  lines.push(
    `Output ONLY the task block(s), wrapped exactly between a line "<<<TASKS" and a line "TASKS>>>". No preamble, no explanation, nothing else.`,
  );
  return lines.join('\n');
}

export function parseDecomposerOutput(stdout: string): string | null {
  const marked = stdout.match(/<<<TASKS\s*\n([\s\S]*?)\n\s*TASKS>>>/);
  const body = marked?.[1];
  if (body && body.trim()) return body.trim();
  // Fallback: salvage from the first `- [ ]` line if the markers were dropped.
  const lines = stdout.split('\n');
  const first = lines.findIndex((l) => /^\s*-\s*\[ \]/.test(l));
  if (first === -1) return null;
  const salvaged = lines.slice(first).join('\n').trim();
  return salvaged || null;
}

export async function invokeDecomposer(
  intent: DecomposeIntent,
  timeoutMs = 180_000,
): Promise<{ tasks: string | null; error?: string }> {
  if (!intent.text || !intent.text.trim()) return { tasks: null, error: 'empty request' };
  const prompt = buildDecomposerPrompt(intent);
  const args = ['-p', prompt, '--model', 'sonnet'];
  // Same auth model as invokeClaude: ANTHROPIC_API_KEY passes through if set
  // (API billing), otherwise claude -p falls back to ~/.claude OAuth (Max).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
  };
  const result = await spawnWithTimeout(
    'claude',
    args,
    { cwd: config.dataDir, env, captureStdout: true, label: 'nyx-decompose' },
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    return { tasks: null, error: `decomposer exit ${result.exitCode}: ${result.stderr.slice(0, 300)}` };
  }
  const tasks = parseDecomposerOutput(result.stdout);
  return tasks ? { tasks } : { tasks: null, error: 'decomposer produced no parseable tasks' };
}
