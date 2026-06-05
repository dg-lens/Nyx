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
  const lines: string[] = [
    `You are Nyx's task decomposer. Convert the operator's request into one or more queue tasks.`,
    `Emit ONE detailed task if the request is a single unit of work, or SEVERAL tasks (ordered with [depends:]) if it naturally splits.`,
    ``,
    TASK_FORMAT,
    ``,
  ];
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
