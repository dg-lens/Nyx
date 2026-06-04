import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findTemplate } from '@nyx/assistant';

import { audit } from './audit.js';
import type { FlightPlan } from './composer/types.js';
import { config } from './config.js';
import { listMcpServers } from './mcp-discovery.js';
import { buildRequiredContextBlock, parseReadingRefs, resolveReadingRefs } from './reading-resolver.js';
import { spawnWithTimeout } from './spawn-helpers.js';
import { fetchProjectSecretValues } from './secrets/bitwarden-client.js';
import { resolveProject } from './secrets/project-registry.js';
import type { ParsedTask } from './types.js';
import { buildWisdomPrompt } from './wisdom-capture.js';

export interface ClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface BuildPromptOpts {
  /**
   * Stage-0 composer integration: if the planning phase produced a flight plan,
   * it's injected into the execution prompt so the agent executes against its
   * own previously-drafted plan. The composer layer guarantees this is the
   * plan the SAME task drafted, not a foreign task's.
   */
  flightPlan?: FlightPlan;
}

/**
 * Maps a task to its memory-graph entry coordinates: the agent-class (audience)
 * and a scope hint for the seed call. The agent calls `memory_entry` itself with
 * these — the dispatcher doesn't pull node content, it just points the way.
 */
function memoryHints(task: ParsedTask): { agentClass: string; scopeHint: string } {
  const agentClass =
    task.type === 'analysis' ? 'analysis' : task.type === 'assistant' ? 'assistant' : 'coder';
  const scopeHint = task.repo
    ? 'omit scope (you will get the root map; lean on memory_search)'
    : '"nyx"';
  return { agentClass, scopeHint };
}

export function buildPrompt(task: ParsedTask, opts: BuildPromptOpts = {}): string {
  if (task.type === 'assistant') {
    const tpl = findTemplate(task.id);
    if (tpl) return tpl(task.description);
  }

  const contextFile = task.repo ? resolve(config.contextDir, `${task.repo.replace('/', '__')}.md`) : null;
  const context = contextFile && existsSync(contextFile) ? readFileSync(contextFile, 'utf8') : '';

  const sections: string[] = [];

  // [reading:] REQUIRED CONTEXT block — prepended before the task header so the
  // agent reads prior decisions/patterns/lessons before anything else.
  if (task.reading && task.reading.length > 0) {
    try {
      const refs = parseReadingRefs(task.reading.join(','));
      const { resolved } = resolveReadingRefs(refs);
      if (resolved.length > 0) {
        sections.push(buildRequiredContextBlock(resolved));
        sections.push('');
      }
    } catch {
      // Resolution errors are caught at preflight; silently skip here if a race
      // condition or unresolvable ref somehow reaches prompt-build time.
    }
  }

  sections.push(`# Nyx task: ${task.id}`);
  sections.push('');
  sections.push(task.description);
  sections.push('');
  sections.push(`Task type: ${task.type}`);
  if (task.repo) sections.push(`Repo: ${task.repo}`);
  if (task.gates !== 'none') sections.push(`Gate stages (run by Nyx after you finish): ${task.gates.join(', ')}`);

  if (task.type === 'code' || task.type === 'analysis') {
    const { agentClass, scopeHint } = memoryHints(task);
    sections.push('');
    sections.push('## MEMORY — use the knowledge graph, do not guess');
    sections.push('');
    sections.push('You have a `memory` knowledge graph via the `memory_*` MCP tools — the stack\'s invariants, lessons, decisions, and conventions as atomic nodes. Consult it before reinventing or repeating a known mistake:');
    sections.push(`- **Start** with \`memory_entry({ agentClass: "${agentClass}", scope: ${scopeHint} })\` — it returns your context map (relevant nodes + one-line summaries). Open nodes on demand; do NOT bulk-load.`);
    sections.push('- `memory_open({ id })` for a node\'s full body + its neighbors (follow the links).');
    sections.push('- `memory_search({ query })` when you hit a failure or unfamiliar area and no link leads there (semantic — no literal keyword overlap needed).');
    sections.push('- If a `memory_*` call errors (server unavailable), proceed without it — the graph is an aid, not a gate.');
  }

  if (task.type === 'code') {
    sections.push('');
    sections.push('Instructions:');
    sections.push('- Make the changes required by the description.');
    sections.push('- Keep the change tightly scoped to this task.');
    sections.push('');
    sections.push('**Before you exit, verify your changes pass the project gate locally.** Nyx will run the gate after you finish; if it fails, the task fails. Running it yourself catches problems while you can still fix them.');
    sections.push('');
    sections.push('  If `package.json` exists at the repo root:');
    sections.push('    pnpm install --prefer-offline');
    sections.push('    pnpm run typecheck   # if defined; else: npx tsc --noEmit');
    sections.push('    pnpm test            # if defined');
    sections.push('');
    sections.push('  If `pyproject.toml` exists at the repo root:');
    sections.push('    uv sync --all-extras --all-groups --no-progress');
    sections.push('    uv run mypy .        # if [tool.mypy] is configured');
    sections.push('    uv run pytest        # if tests/ or [tool.pytest.ini_options]');
    sections.push('    uv run ruff check .  # if [tool.ruff] is configured');
    sections.push('');
    sections.push('  If a check fails because of TOOLING CONFIG (not because your code is wrong) — e.g. mypy doesn\'t understand SQLAlchemy\'s `Model.__table__` because [tool.mypy].plugins is missing `sqlalchemy.ext.mypy.plugin`, or Pydantic v2 features need `pydantic.mypy` — update pyproject.toml to include the relevant plugin. Updating tooling config is part of your task when you introduce a framework feature that needs it.');
    sections.push('');
    sections.push('**Before you commit, verify .gitignore covers all build/runtime artifacts.** Nyx commits ALL files in the working dir after you finish. If you leave `node_modules/`, `.venv/`, `__pycache__/`, `.next/`, `dist/`, `build/`, `.mypy_cache/`, `.pytest_cache/`, `.ruff_cache/`, etc. uncovered by `.gitignore`, they get committed — and GitHub rejects any single file over 100MB (Next.js, esbuild, and other binary deps blow past this routinely). If `.gitignore` is missing or incomplete, write/extend it BEFORE you exit.');
    sections.push('');
    sections.push('- Do not run `git commit` yourself — Nyx commits after the gate passes.');
    sections.push('- If you cannot complete the task, write a short reason to stderr and exit non-zero.');
    sections.push('');
    sections.push('## Ambiguity escalation');
    sections.push('');
    sections.push('If you encounter a genuine aesthetic decision that is NOT covered by `~/.claude/developer-personality.md` and where guessing would compound across the codebase — **stop and escalate** instead of guessing.');
    sections.push('');
    sections.push('Write `.nyx/ambiguity.json` in the working directory with this exact schema, then **exit 0** (not non-zero — non-zero routes to the noisy audit pipeline):');
    sections.push('');
    sections.push('```json');
    sections.push('{');
    sections.push('  "schema_version": 1,');
    sections.push('  "task_id": "<this task id>",');
    sections.push('  "question": "<single concrete question for the operator>",');
    sections.push('  "options": [');
    sections.push('    { "label": "Option A", "description": "...", "pros": "...", "cons": "..." },');
    sections.push('    { "label": "Option B", "description": "...", "pros": "...", "cons": "..." }');
    sections.push('  ],');
    sections.push('  "my_lean": "Option A",');
    sections.push('  "lean_reason": "<why you lean this way>"');
    sections.push('}');
    sections.push('```');
    sections.push('');
    sections.push('`my_lean` and `lean_reason` are optional but expected — a lean with reasoning lets the operator decide faster. `pros`/`cons` on each option are also optional but strongly encouraged.');
    sections.push('');
    sections.push('**When to escalate:** genuine naming/structure ambiguity where the developer-personality doc is silent and the choice compounds (e.g. a new table name, a new module location, a new API shape that other code will depend on). Do NOT escalate for: implementation details that are self-contained, choices where any reasonable option is equivalent, or anything already covered in the developer-personality doc.');
    sections.push('');
    sections.push('**Do not** write the file and exit non-zero — that routes to the audit pipeline and loses the structured escalation. Write the file AND exit 0.');

    if (task.expects && task.expects.length > 0) {
      sections.push('');
      sections.push('## REQUIRED ARTIFACTS — verified after you finish');
      sections.push('');
      sections.push('Nyx will check that EVERY path below exists when you exit. If any is missing the task FAILS at the expects-verifier stage, escalates to a diagnostic agent, and burns extra compute on retry. Treat this list as a hard contract — not a suggestion.');
      sections.push('');
      for (const path of task.expects) {
        sections.push(`  - ${path}`);
      }
      sections.push('');
      sections.push('The verifier only checks file existence, not content quality — but each file must contain real, substantive implementation. If a path is a new test file, write the tests as part of THIS task; do not defer. If a path is a new module, implement it fully. Creating empty stubs to "satisfy" the verifier counts as spec divergence and will be caught when the gate runs.');
    }

    sections.push('');
    sections.push('## Before you exit — doc-sweep');
    sections.push('');
    sections.push('**The doc-sweep verifier will check your diff against the `## Doc updates` section after gate passes.** If this task has a `## Doc updates` section, every concrete path listed there MUST appear in your changed files before Nyx commits. Failing to update a declared doc path will fail the task at finalize and burn additional compute on the audit-phase patch step. Update the docs as part of THIS task — do not defer.');
    sections.push('');
    sections.push('If your work changes anything future agents would benefit from knowing, update the appropriate CLAUDE.md tier BEFORE you finish. This closes the write-side of the doc system established in `~/.claude/CLAUDE.md` §5 — without it, every behavior change you make silently rots the docs for the next session.');
    sections.push('');
    sections.push('| If your change... | Update... |');
    sections.push('|---|---|');
    sections.push('| Adds or renames an env var that code reads at runtime | T2 (or T3) of the affected repo\'s CLAUDE.md — the section that lists env vars |');
    sections.push('| Adds a new sub-app under `apps/` | [T1 §2] sub-app directory row AND create the new app\'s T3 `CLAUDE.md` |');
    sections.push('| Adds a brand-new repo to the stack | [T1 §1] repo directory row AND create that repo\'s T2 `CLAUDE.md` |');
    sections.push('| Adds a new deploy target (new Fly app, new Vercel project, etc.) | T2 (or T3) deploy section + secret-mirror procedure if applicable |');
    sections.push('| Introduces a new third-party service / API dependency | T2 (or T3) with a one-line note + link to vendor docs |');
    sections.push('| Adds a new route / endpoint that the portal calls | T3 of the backend that exposes it (route table or surface list) |');
    sections.push('| Changes the auth chain, JWT verification, CORS, or any cross-component contract | T2 (or T3) of the affected repo + cite the related `[T4 <slug>]` entry if one exists |');
    sections.push('| Resolves a non-trivial bug-class (debugging effort > trivial) | Write a [T4] entry per the protocol in `~/.claude/CLAUDE.md` §4 |');
    sections.push('');
    sections.push('**Default tier when unsure: T2 of the affected repo.** Hoist UP to T1 ONLY if the fact genuinely applies to ≥ 2 repos. T1 bloat is harmful — it loads for every session including ones that never touch the affected repo.');
    sections.push('');
    sections.push('**Compounding clause:** every doc update you make becomes context for future agents. Skipping the doc-sweep is borrowing against future sessions — DOCS-DRIFT-AUDIT (runs every 24h) will surface it as a finding, but a finding 24h later is more expensive than a one-line edit now.');
    sections.push('');
    sections.push('**Format note:** lower tiers may reference higher tiers via `[T1 §3.1]` syntax — grep-friendly + intent obvious. Do not duplicate facts across tiers; if you find you need to, hoist the fact up instead.');
  } else if (task.type === 'analysis') {
    sections.push('');
    sections.push('Instructions:');
    sections.push('- This is a read-only analysis. Do not modify source files.');
    sections.push(`- Write findings as Markdown to ./NYX_FINDINGS.md inside the working directory.`);
    sections.push('- Structure: severity, file, line, recommendation.');
  } else if (task.type === 'content') {
    sections.push('');
    sections.push('Instructions:');
    sections.push(`- Produce the deliverable in the current working directory.`);
    sections.push(`- Use file names that reflect the artifact (e.g. deck.md, draft.md).`);
  } else if (task.type === 'assistant') {
    sections.push('');
    sections.push('Instructions:');
    sections.push('- This is a personal-assistant task. Use MCP tools as needed — your environment has user-connected MCPs for Slack, Gmail, Google Calendar, Google Drive, Notion, and Sanity (call `claude mcp list` to discover others). MCP tool names are `mcp__<server>__<tool>`.');
    sections.push('- Bash is disabled for read-only safety. Use the MCP tools (and Read/Glob/Grep/WebFetch/WebSearch) instead of shelling out.');
    sections.push('- Output your final answer to ./ASSISTANT_OUTPUT.md in the current working directory.');
    sections.push('- If an MCP you need is not available or not authenticated, write that fact into ASSISTANT_OUTPUT.md and continue with the parts you can complete.');
  }

  if (context) {
    sections.push('');
    sections.push('## Prior context for this repo');
    sections.push(context);
  }

  // Composer layer (stage 0): inject the agent's previously-drafted flight plan
  // into the execution prompt. Only happens for code tasks where phase 1 (plan
  // spawn) succeeded. See apps/dispatcher/src/composer/CLAUDE.md for the
  // architecture. Stage 0 is observation-only — divergence is logged but not
  // enforced; "execute it" is guidance, not a contract.
  if (opts.flightPlan && task.type === 'code') {
    sections.push('');
    sections.push('## YOUR FLIGHT PLAN (drafted in the planning phase)');
    sections.push('');
    sections.push('You previously drafted the following plan for this task in a planning-only spawn. Execute it. If circumstances force you to diverge from the plan, that is acceptable — note the divergence and the reason briefly at the end of your work so the composer layer can learn from it.');
    sections.push('');
    sections.push('```json');
    sections.push(JSON.stringify(opts.flightPlan, null, 2));
    sections.push('```');
  }

  return sections.join('\n');
}

/**
 * Permission scoping per task type. Two layers of defense:
 *
 *  1. **Tool allowlist** via `--allowed-tools`. The Claude CLI treats this flag
 *     as exclusive — listing names whitelists ONLY those. v0.5 returns to
 *     allowlist (after a v0.3.1 blocklist detour) so the spawned `claude` can
 *     never reach for an unanticipated tool, even one Anthropic might add later.
 *
 *     MCP tools are namespaced `mcp__<server>__<tool>` and need explicit
 *     enumeration. We discover the set at startup via `claude mcp list` so
 *     adding a new MCP in the user's Claude config picks up automatically —
 *     no code change required. The undocumented `mcp__*` wildcard is NOT used
 *     because it isn't documented and a literal-match interpretation would
 *     silently block every MCP call.
 *
 *     Per-type policy:
 *       - assistant → READ_ONLY tools + all discovered MCPs (Gmail, Notion, Slack, …)
 *       - content   → READ_ONLY tools (NO MCPs — content tasks don't need email/calendar/etc.)
 *       - analysis  → READ_ONLY + Bash + all discovered MCPs (codebase scans need shells)
 *       - code      → no flag at all (default Claude tool set)
 *
 *  2. **Working directory isolation**. Assistant cwd is an empty
 *     `outputs/<TASK-ID>/` dir — even with Write/Edit, there's nothing real to
 *     mutate. Analysis cwd is a `/tmp/nyx-clone-<TASK-ID>/` clone with no
 *     push credentials — mutations there can't escape. Code cwd is a real
 *     worktree where mutations are the entire point.
 *
 * The "no shell access" guarantee for assistant/content is (1). The "mutations
 * can't escape" guarantee for assistant/content/analysis is (2). Code has
 * neither restriction by design.
 */
export function permissionArgs(task: ParsedTask): string[] {
  const args: string[] = ['--permission-mode', config.claudePermissionMode];
  const READ_ONLY = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Write', 'Edit'];
  const mcps = listMcpServers();
  if (task.type === 'assistant') {
    args.push('--allowed-tools', [...READ_ONLY, ...mcps].join(' '));
  } else if (task.type === 'content') {
    args.push('--allowed-tools', READ_ONLY.join(' '));
  } else if (task.type === 'analysis') {
    args.push('--allowed-tools', [...READ_ONLY, 'Bash', ...mcps].join(' '));
  }
  // type === 'code' → no --allowed-tools, full default tool access
  return args;
}

/**
 * Resolves Bitwarden secrets injection for this task. Returns the cmd + args
 * tuple to spawn, plus any extra env. When a Bitwarden project is in play, we
 * fetch the project's secrets via `bws secret list` and inject them as env
 * vars directly into Claude's spawn environment — Claude is spawned as a plain
 * `claude` process, NOT wrapped in `bws run --`.
 *
 * Why not `bws run -- claude …`: bws's run wrapper passes the trailing argv
 * through a shell, which mangles any prompt containing backticks, parens,
 * single quotes, or other shell metacharacters (see CHANGELOG v0.6.8 — the
 * EMP-002 task description had SQL with single quotes + parens and bws
 * reported `sh: -c: line 2: syntax error near unexpected token '('`). With
 * pre-resolved env injection, the prompt goes through fork+exec only and the
 * shell never sees it.
 *
 * Trade-off: secret values live in Node memory inside `extraEnv` until the
 * spawn call delivers them to the child. They are never logged, audited, or
 * persisted. The previous design also had the access TOKEN in Node memory,
 * so this is a small expansion of an existing trust boundary, not a new one.
 */
export function buildSpawnInvocation(
  task: ParsedTask,
  claudeArgs: string[],
): { command: string; args: string[]; extraEnv: Record<string, string> } {
  const project = resolveProject(task);
  if (!project) {
    return { command: 'claude', args: claudeArgs, extraEnv: {} };
  }
  let secrets: Record<string, string>;
  try {
    secrets = fetchProjectSecretValues(project.bw_project_id, project.token_path);
  } catch (err) {
    // Token-path declared but file missing/insecure, OR bws CLI errored.
    // Audit the failure mode and fall back to plain claude. The dispatcher
    // decides downstream whether to fail the task.
    audit('bitwarden.token.missing', 'task-runner', {
      taskId: task.id,
      token_path: project.token_path,
      reason: (err as Error).message,
    });
    return { command: 'claude', args: claudeArgs, extraEnv: {} };
  }
  return {
    command: 'claude',
    args: claudeArgs,
    extraEnv: secrets,
  };
}

const WISDOM_TIMEOUT_MS = 5 * 60_000;

/**
 * Second claude -p invocation after the main task exits 0. Asks the agent to
 * reflect on what it learned and write NYX_WISDOM.md. Uses haiku (fast/cheap)
 * with restricted tools — only needs to read the working dir and write one file.
 *
 * Non-fatal: caller must treat any non-zero exit as a skip, not a failure.
 */
export async function invokeWisdomCapture(task: ParsedTask, cwd: string): Promise<ClaudeResult> {
  const prompt = buildWisdomPrompt();
  const claudeArgs = [
    '-p', prompt,
    '--model', 'haiku',
    '--permission-mode', config.claudePermissionMode,
    '--allowed-tools', 'Read Glob Grep Write',
    '--add-dir', cwd,
  ];
  const { command, args, extraEnv } = buildSpawnInvocation(task, claudeArgs);
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
    ...extraEnv,
  };
  const result = await spawnWithTimeout(command, args, {
    cwd,
    env: spawnEnv,
    captureStdout: true,
    label: 'nyx-wisdom',
  }, WISDOM_TIMEOUT_MS);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}

export async function invokeClaude(
  task: ParsedTask,
  cwd: string,
  opts: BuildPromptOpts = {},
): Promise<ClaudeResult> {
  const prompt = buildPrompt(task, opts);
  const claudeArgs = [
    '-p',
    prompt,
    '--model', task.model,
    ...permissionArgs(task),
    '--add-dir', cwd,
  ];
  const { command, args, extraEnv } = buildSpawnInvocation(task, claudeArgs);

  const start = Date.now();
  // Auth model: ANTHROPIC_API_KEY passes through to `claude -p` as-is. If it's
  // set (BYO key), the spawn uses API billing; if absent, it falls back to the
  // host's ~/.claude OAuth (Max-plan). The install chooses by whether the key is
  // present in the spawn env (.env / launchd). See .env.example.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
    ...extraEnv, // BWS_ACCESS_TOKEN if Bitwarden is in play. Never logged.
  };
  const result = await spawnWithTimeout(command, args, {
    cwd,
    env: spawnEnv,
    captureStdout: true,
    label: 'nyx',
  }, config.claudeTaskTimeoutMs);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
