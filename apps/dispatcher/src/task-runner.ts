import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findTemplate } from '@nyx/assistant';

import { audit } from './audit.js';
import type { FlightPlan } from './composer/types.js';
import { config } from './config.js';
import { emitHook } from './plugins/hooks.js';
import { listMcpServers } from './mcp-discovery.js';
import { applyPolicy, probeReadiness, resolveWithheld } from './mcp-resilience.js';
import { buildRequiredContextBlock, parseReadingRefs, resolveReadingRefs } from './reading-resolver.js';
import { redactCredentialPatterns, redactValues } from './redaction.js';
import { spawnWithTimeout } from './spawn-helpers.js';
import { costMeteringArgs, extractResultText, parseMcpToolEvents, parseUsage, type McpToolEvent, type SpawnUsage } from './spawn-usage.js';
import { classOf } from './concurrency.js';
import { buildJudgePrompt } from './content-judge.js';
import { fetchProjectSecretValues } from './secrets/bitwarden-client.js';
import { resolveProject } from './secrets/project-registry.js';
import type { ParsedTask } from './types.js';
import { buildWisdomPrompt } from './wisdom-capture.js';

export interface ClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Locally-estimated cost/tokens from the JSON envelope; null when metering is off or the envelope was unparseable. */
  usage?: SpawnUsage | null;
  /**
   * MCP tool calls extracted from a stream-json spawn (assistant/analysis), with
   * each call's server-qualified name + error status. The breaker bookkeeping in
   * run-once attributes failures per server off these. Parsed from the RAW NDJSON
   * here (before reconcileMeteredOutput strips it down to the result text) and
   * value-scrubbed, so run-once gets the structured signal without re-handling raw
   * tool output. Absent/empty for non-MCP task types and single-json spawns.
   */
  mcpToolEvents?: McpToolEvent[];
  // Set when the spawn's output carried a rate-limit/overload signal. The
  // dispatcher leaves the task queued + opens a cooldown rather than failing it.
  rateLimited?: boolean;
  retryAfterMs?: number;
}

/**
 * Reconcile a metered spawn's stdout with the sentinel contract.
 *
 * With `--output-format json`, the agent's final text (carrying the VERDICT /
 * terminal sentinel) is inside the envelope's `result` field, not raw on stdout.
 * Every downstream check parses `stdout` for that sentinel, so we swap in the
 * extracted `result` text — making stdout byte-identical to the pre-metering
 * shape. If the envelope can't be parsed (older CLI, crash before the result
 * message, shape drift), we keep the raw stdout: the sentinel parse still works on
 * the unmodified output and metering simply reports null. This is the seam that
 * stops JSON output from regressing completion detection.
 */
function reconcileMeteredOutput(rawStdout: string): { stdout: string; usage: SpawnUsage | null } {
  const usage = parseUsage(rawStdout);
  const resultText = extractResultText(rawStdout);
  return { stdout: resultText ?? rawStdout, usage };
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
    sections.push('## Before you exit — grow the memory graph');
    sections.push('');
    sections.push('The stack\'s knowledge lives in the Arachne memory graph at `~/Nyx/Data/memory` (nodes + MOCs, read via the `memory_*` MCP), not in tiered CLAUDE.md docs. If this task surfaced a durable lesson, invariant, decision, or convention a future agent would get wrong without it, capture it as a node — the wisdom step after the gate will prompt you for exactly that, so note what\'s worth keeping now. Store what corrects, not what confirms; a routine task needs no node.');
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
/**
 * Resolve the MCP servers that survive the resilience layer for this spawn.
 *
 * The discovered allowlist (mcp-discovery) is passed through three out-of-process
 * filters before it reaches the spawn — none of which the cold per-spawn client
 * could enforce itself:
 *   1. **circuit breaker** — a server whose breaker is OPEN (N consecutive
 *      failures, generalizing the SUPABASE_URL rule) is withheld so the task isn't
 *      spawned against a backend known-bad this cooldown window.
 *   2. **readiness probe** — `claude mcp list` connection status withholds a
 *      server the probe reports disconnected RIGHT NOW (parallel to the v0.7
 *      env-var presence check). Best-effort: if the probe didn't run/observe a
 *      server, the breaker remains the authoritative suppressor.
 *   3. **policy** — settings.mcp.policy drops `deny` servers entirely and routes
 *      `ask` servers out of the headless allowlist (no human to prompt; `ask` is
 *      reified as Nyx's halt path elsewhere). `auto` (the default) keeps the
 *      server — so an empty policy map reproduces today's allowlist exactly.
 *
 * Every withholding decision emits an audit row so the immutable chain records why
 * an MCP was absent from a spawn (the post-mortem join the hang T4 entries lacked).
 * Best-effort: any throw is swallowed and the raw discovered list is returned, so
 * the resilience layer can never crash a tick.
 */
export function resolveMcpAllowlist(task: ParsedTask): string[] {
  const discovered = listMcpServers();
  if (discovered.length === 0) return discovered;
  try {
    const probe = config.settings.mcp.probe.enabled ? probeReadiness() : undefined;
    const { allowed: afterBreaker, withheld } = resolveWithheld(discovered, { probe });
    if (withheld.length > 0) {
      audit('task.mcp.servers_withheld', 'mcp-resilience', {
        taskId: task.id,
        withheld: withheld.map((w) => ({ server: w.server, reason: w.reason })),
      });
    }
    const { allowed, denied, ask } = applyPolicy(afterBreaker);
    if (denied.length > 0 || ask.length > 0) {
      audit('task.mcp.policy_decision', 'mcp-resilience', {
        taskId: task.id,
        ...(denied.length > 0 ? { denied } : {}),
        ...(ask.length > 0 ? { ask } : {}),
      });
    }
    return allowed;
  } catch (err) {
    console.warn('[task-runner] MCP resilience resolution failed, using raw allowlist:', (err as Error).message);
    return discovered;
  }
}

export function permissionArgs(task: ParsedTask): string[] {
  const args: string[] = ['--permission-mode', config.claudePermissionMode];
  const READ_ONLY = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Write', 'Edit'];
  if (task.type === 'assistant') {
    args.push('--allowed-tools', [...READ_ONLY, ...resolveMcpAllowlist(task)].join(' '));
  } else if (task.type === 'content') {
    args.push('--allowed-tools', READ_ONLY.join(' '));
  } else if (task.type === 'analysis') {
    args.push('--allowed-tools', [...READ_ONLY, 'Bash', ...resolveMcpAllowlist(task)].join(' '));
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
/**
 * Build the environment for a spawned agent, stripping the GitHub PAT (H2).
 * Code/analysis agents run with Bash and could otherwise `echo $GITHUB_TOKEN` to
 * read the operator's all-repo-write token straight from their inherited env —
 * a live exfil path, worst for analysis tasks scanning untrusted repos. In the
 * dispatch model the agent never needs GitHub credentials: it writes code and
 * commits locally; the DISPATCHER performs every git network op itself (with the
 * token supplied out-of-band via GIT_ASKPASS — see git-ops.gitEnv). So drop both
 * GITHUB_TOKEN and GH_TOKEN here. An analysis task that genuinely needs GitHub
 * read access should be granted a narrowly-scoped token explicitly, not inherit
 * the write PAT. ANTHROPIC_API_KEY + Bitwarden extraEnv are preserved.
 */
export function buildAgentEnv(extraEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(config.anthropicApiKey ? { ANTHROPIC_API_KEY: config.anthropicApiKey } : {}),
    ...extraEnv,
  };
  delete env['GITHUB_TOKEN'];
  delete env['GH_TOKEN'];
  return env;
}

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
  const spawnEnv = buildAgentEnv(extraEnv);
  const result = await spawnWithTimeout(command, args, {
    cwd,
    env: spawnEnv,
    captureStdout: true,
    label: 'nyx-wisdom',
    silenceTimeoutMs: config.claudeSilenceTimeoutMs || undefined,
    // Wisdom capture only runs for code (GIT-class) tasks, inside the GIT task's
    // own lifetime — count it as GIT so it's attributed to the right budget.
    claudeMeta: { class: 'git', taskId: task.id },
  }, WISDOM_TIMEOUT_MS);
  // Wisdom output is read from NYX_WISDOM.md, not stdout, so no cost-reconcile is
  // needed; still scrub secret values from stdout/stderr before the result leaves.
  return scrubResult(result, extraEnv);
}

const JUDGE_TIMEOUT_MS = 5 * 60_000;

/**
 * Content-judge spawn (P7): an INDEPENDENT haiku Read/Grep-only `claude -p` that
 * scores the just-committed diff PASS/FAIL against the task's acceptance criteria
 * and writes NYX_JUDGE.md. Shares the wisdom-capture spawn shape exactly (haiku,
 * restricted read-only tools, 5-min cap, GIT-class attribution) — it runs only
 * for code tasks inside the GIT task's lifetime.
 *
 * Read-ONLY by construction: only Read/Glob/Grep are allowed, so the judge can
 * inspect the diff but can neither run the gate (no second compute) nor mutate
 * the diff it's judging. Non-fatal: the caller treats any non-zero exit / missing
 * file as "no concern".
 */
export async function invokeContentJudge(task: ParsedTask, cwd: string): Promise<ClaudeResult> {
  const prompt = buildJudgePrompt(task);
  const claudeArgs = [
    '-p', prompt,
    '--model', 'haiku',
    '--permission-mode', config.claudePermissionMode,
    '--allowed-tools', 'Read Glob Grep Write',
    '--add-dir', cwd,
  ];
  const { command, args, extraEnv } = buildSpawnInvocation(task, claudeArgs);
  const spawnEnv = buildAgentEnv(extraEnv);
  const result = await spawnWithTimeout(command, args, {
    cwd,
    env: spawnEnv,
    captureStdout: true,
    label: 'nyx-judge',
    silenceTimeoutMs: config.claudeSilenceTimeoutMs || undefined,
    claudeMeta: { class: 'git', taskId: task.id },
  }, JUDGE_TIMEOUT_MS);
  // Verdict is read from NYX_JUDGE.md, not stdout; just scrub secret values.
  return scrubResult(result, extraEnv);
}

/**
 * The injected per-task Bitwarden secret VALUES (`extraEnv`) live only in the
 * child's spawn env, never in the dispatcher's `process.env`, so the downstream
 * redaction layers keyed on `process.env` cannot see them. If any tool the agent
 * ran echoed one (a stack trace, `set -x`, an HTTP error printing a connection
 * string), it would otherwise reach the IMMUTABLE hash-chained audit DB and Slack
 * verbatim. Redact here — at the one site where the resolved values are known —
 * before the result leaves task-runner. The generic credential-shape backstop
 * also catches token shapes (github_pat_, ghp_, sk-, xox*-, AKIA…) that are not
 * the dispatcher's own configured secrets.
 */
function scrubResult(
  result: { exitCode: number; stdout: string; stderr: string; durationMs: number; rateLimited?: boolean; retryAfterMs?: number },
  extraEnv: Record<string, string>,
): ClaudeResult {
  const values = Object.values(extraEnv);
  const scrub = (s: string): string => redactCredentialPatterns(redactValues(s, values));
  return {
    exitCode: result.exitCode,
    stdout: scrub(result.stdout),
    stderr: scrub(result.stderr),
    durationMs: result.durationMs,
    rateLimited: result.rateLimited,
    ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
  };
}

export async function invokeClaude(
  task: ParsedTask,
  cwd: string,
  opts: BuildPromptOpts = {},
): Promise<ClaudeResult> {
  let prompt = buildPrompt(task, opts);
  prompt = (await emitHook('task.promptBuild', { task, prompt })).prompt;
  // MCP-dependent task types emit stream-json so the post-spawn breaker can
  // attribute each MCP tool call (and its result's error status) to the specific
  // server — the single-result envelope drops those per-turn tool blocks, which is
  // why the breaker never accumulated. The final NDJSON `result` line is the same
  // envelope single-json emits, so cost metering + the VERDICT sentinel are
  // unaffected (reconcileMeteredOutput parses it from the last line). Code/coder
  // spawns keep single-json — they run no MCP tools and don't need the stream.
  const meterFormat: 'json' | 'stream-json' =
    task.type === 'assistant' || task.type === 'analysis' ? 'stream-json' : 'json';
  const claudeArgs = [
    '-p',
    prompt,
    '--model', task.model,
    ...permissionArgs(task),
    ...(config.costMeteringEnabled ? costMeteringArgs({ format: meterFormat }) : []),
    '--add-dir', cwd,
  ];
  const { command, args, extraEnv } = buildSpawnInvocation(task, claudeArgs);

  const start = Date.now();
  // Auth model: ANTHROPIC_API_KEY passes through to `claude -p` as-is. If it's
  // set (BYO key), the spawn uses API billing; if absent, it falls back to the
  // host's ~/.claude OAuth (Max-plan). The install chooses by whether the key is
  // present in the spawn env (.env / launchd). See .env.example. GITHUB_TOKEN is
  // stripped (H2); Bitwarden extraEnv (BWS_ACCESS_TOKEN) is preserved. Never logged.
  const spawnEnv = buildAgentEnv(extraEnv);
  const result = await spawnWithTimeout(command, args, {
    cwd,
    env: spawnEnv,
    captureStdout: true,
    label: 'nyx',
    silenceTimeoutMs: config.claudeSilenceTimeoutMs || undefined,
    claudeMeta: { class: classOf(task.type), taskId: task.id },
  }, config.claudeTaskTimeoutMs);
  // Extract MCP tool events from the RAW stream-json BEFORE reconciliation strips
  // stdout down to the result text. Done for MCP-dependent types regardless of exit
  // code — a non-zero/stalled spawn is precisely when a wedged MCP call should
  // count toward its breaker. The events' result text is value-scrubbed below so no
  // secret a tool echoed reaches the breaker/audit path.
  const rawToolEvents =
    (task.type === 'assistant' || task.type === 'analysis')
      ? parseMcpToolEvents(result.stdout)
      : [];

  // Reconcile the metered JSON envelope (extract the agent's result text + usage)
  // when metering is on and the spawn exited cleanly, THEN scrub secret values from
  // the result before it leaves task-runner. A non-zero exit keeps stdout raw.
  // scrubResult also threads through the rate-limit/overload signal so the
  // dispatcher can leave the task queued + open a cooldown rather than fail it.
  const metered = config.costMeteringEnabled && result.exitCode === 0
    ? reconcileMeteredOutput(result.stdout)
    : { stdout: result.stdout, usage: null };
  const scrubbed = scrubResult(
    {
      exitCode: result.exitCode,
      stdout: metered.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      rateLimited: result.rateLimited,
      ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
    },
    extraEnv,
  );
  const scrubText = (s: string): string => redactCredentialPatterns(redactValues(s, Object.values(extraEnv)));
  const mcpToolEvents = rawToolEvents.map((e) => ({ ...e, resultText: scrubText(e.resultText) }));
  return { ...scrubbed, usage: metered.usage, mcpToolEvents };
}
