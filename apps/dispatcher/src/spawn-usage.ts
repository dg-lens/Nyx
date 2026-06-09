/**
 * Per-spawn cost + token metering off `claude -p --output-format json`.
 *
 * Why this exists: under Max-plan OAuth there is NO billing signal — the seat is
 * flat-rate, so the API never reports a per-call dollar amount. The CLI's JSON
 * envelope carries a LOCALLY-ESTIMATED `total_cost_usd` derived from a bundled
 * price table, which survives the no-billing seat. It is NOT a bill (Anthropic
 * warns against driving financial decisions off it) — it is the correct fidelity
 * for internal per-spawn economic metering and per-run budgeting.
 *
 * The load-bearing constraint this module protects: switching stdout to JSON must
 * NOT break the VERDICT-line / terminal-sentinel completion detection that every
 * downstream caller parses. The agent's final text (where the sentinel lives) is
 * the envelope's `result` field; `extractResultText` pulls it back out so callers
 * see the same plain text they saw before `--output-format json` was added. If the
 * envelope can't be parsed (older CLI, mid-stream crash before the result message,
 * shape drift), parsing returns null and the caller falls back to the raw stdout —
 * the sentinel still works on the unmodified text.
 */

export interface SpawnUsage {
  /** Locally-estimated dollars (price-table, not a bill). Null if absent. */
  estimatedCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  numTurns: number | null;
}

/**
 * Flags appended to a metered `claude -p` invocation. Kept as a function (not a
 * const) so callers spread it at the call site and the intent reads at the spawn.
 *
 * `format: 'json'` (default) emits a SINGLE result object — the right shape for
 * code/coder spawns that only need cost + the VERDICT sentinel. `format:
 * 'stream-json'` emits NDJSON (per-turn tool_use/tool_result events + a final
 * `result` line) and REQUIRES `--verbose`; MCP-dependent task types use it so the
 * breaker can attribute failures to the specific server that 401'd / timed out
 * (`parseMcpToolEvents`). Both shapes feed the same `parseUsage`/`extractResultText`
 * (the parser scans the NDJSON's last line for the identical result envelope), so
 * cost metering and sentinel detection are unaffected by the format choice.
 */
export function costMeteringArgs(opts: { format?: 'json' | 'stream-json' } = {}): string[] {
  if (opts.format === 'stream-json') {
    return ['--output-format', 'stream-json', '--verbose'];
  }
  return ['--output-format', 'json'];
}

interface ResultEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: unknown;
      outputTokens?: unknown;
      cacheReadInputTokens?: unknown;
      cacheCreationInputTokens?: unknown;
      costUSD?: unknown;
    }
  >;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parse the result envelope out of a metered spawn's stdout. Handles BOTH
 * `--output-format json` (a SINGLE JSON object — the whole stdout) AND
 * `--output-format stream-json` (NDJSON, where the LAST line is the same
 * `type: 'result'` envelope, byte-identical to the single-json form, preceded by
 * per-turn `assistant`/`user`/`system` event lines). The MCP-dependent task types
 * spawn with stream-json so their tool-use events can be attributed to the breaker
 * (see `mcpServersFailedIn`); code/coder spawns stay on single-json. This parser
 * is a strict superset, so both shapes flow through `parseUsage`/`extractResultText`
 * unchanged. Returns null on any parse/shape failure so the caller can fall back to
 * raw-stdout sentinel parsing.
 */
function parseEnvelope(stdout: string): ResultEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Single-json fast path: the whole stdout is one object.
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    return parseOneEnvelope(trimmed);
  }
  // stream-json (or single-json that happens to span lines): scan from the end
  // for the `type: 'result'` line. The result message is always emitted last, so
  // a reverse scan finds it in O(1) for the common case without parsing every
  // event line. Fall back to a whole-blob parse if no line qualifies (e.g. an
  // older single-json blob pretty-printed across lines).
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line.startsWith('{')) continue;
    const env = parseOneEnvelope(line);
    if (env) return env;
  }
  return parseOneEnvelope(trimmed);
}

/** Parse one JSON object string into a result envelope, or null. */
function parseOneEnvelope(text: string): ResultEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const env = parsed as ResultEnvelope;
  // A real result envelope always carries `type: 'result'`. Guarding on it stops
  // an unrelated JSON blob (e.g. an agent that legitimately printed JSON as its
  // answer) from being mistaken for the metering envelope.
  if (env.type !== 'result') return null;
  return env;
}

/**
 * Pull the agent's final text back out of the envelope so the VERDICT sentinel
 * (and every other stdout-based check) sees the same plain text it saw before
 * JSON output was enabled. Returns null when there's no parseable envelope — the
 * caller then keeps the raw stdout untouched.
 */
export function extractResultText(stdout: string): string | null {
  const env = parseEnvelope(stdout);
  if (!env) return null;
  return typeof env.result === 'string' ? env.result : '';
}

/**
 * One MCP tool invocation extracted from a stream-json spawn: the server-qualified
 * tool name the agent actually called (`mcp__<server>__<tool>`) paired with whether
 * its matching `tool_result` came back an error. This is the ONLY out-of-process
 * signal that names which MCP server was exercised AND whether it failed — the
 * single-result `--output-format json` envelope drops the per-turn tool blocks
 * entirely (the agent's prose `result` text describes a failure but never names the
 * `mcp__server__tool` token), which is why the breaker accumulated nothing before.
 */
export interface McpToolEvent {
  /** The full `mcp__<server>__<tool>` token the agent invoked. */
  tool: string;
  /** True when the paired tool_result block carried is_error (or an error body). */
  isError: boolean;
  /** The tool_result text, when present — fed to the auth/transport classifier. */
  resultText: string;
}

interface StreamMessageBlock {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface StreamLine {
  type?: string;
  message?: { content?: StreamMessageBlock[] };
}

/** Flatten a tool_result `content` value (string | array of {type,text}) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
          ? (c as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

/**
 * Extract every MCP tool invocation (and its result's error status) from a
 * stream-json spawn's NDJSON stdout. Walks `assistant` messages for `tool_use`
 * blocks whose `name` starts with `mcp__`, then pairs each with its `tool_result`
 * (matched by `tool_use_id`) from the following `user` message to learn whether the
 * call errored. Tools that never produced a result (spawn killed mid-call) are
 * reported with `isError: true` — a tool that started but never returned is exactly
 * the wedged-MCP case the breaker exists to suppress.
 *
 * Pure + tolerant: a non-NDJSON stdout (single-json, plain text) yields an empty
 * list, so callers fall back to the regex scanner. Never throws.
 */
export function parseMcpToolEvents(stdout: string): McpToolEvent[] {
  const trimmed = stdout.trim();
  if (!trimmed.includes('\n') || !trimmed.includes('"tool_use"')) return [];
  const calls = new Map<string, { tool: string }>();
  const results = new Map<string, { isError: boolean; text: string }>();
  for (const raw of trimmed.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let parsed: StreamLine;
    try {
      parsed = JSON.parse(line) as StreamLine;
    } catch {
      continue;
    }
    const blocks = parsed.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith('mcp__') && b.id) {
        calls.set(b.id, { tool: b.name });
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const text = toolResultText(b.content);
        results.set(b.tool_use_id, { isError: b.is_error === true, text });
      }
    }
  }
  const events: McpToolEvent[] = [];
  for (const [id, call] of calls) {
    const res = results.get(id);
    events.push({
      tool: call.tool,
      // No paired result → the tool call never returned (spawn died mid-call):
      // treat as an error so a wedged MCP still counts toward its breaker.
      isError: res ? res.isError : true,
      resultText: res?.text ?? '',
    });
  }
  return events;
}

/**
 * Cost + token usage from the envelope. Prefers `modelUsage` (per-model, the
 * authoritative source for `costUSD`), falling back to top-level `usage` for the
 * token counts. modelUsage is already AGGREGATED per model across the whole run,
 * so there is no per-message-id double-count to dedup at this layer — that gotcha
 * applies to the streaming `assistant`-message events, which this envelope sums
 * for us. Returns null when no envelope is present.
 */
export function parseUsage(stdout: string): SpawnUsage | null {
  const env = parseEnvelope(stdout);
  if (!env) return null;

  let cost = numOrNull(env.total_cost_usd);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;

  const models = env.modelUsage ? Object.values(env.modelUsage) : [];
  if (models.length > 0) {
    let costFromModels = 0;
    let sawCost = false;
    for (const m of models) {
      inputTokens += num(m.inputTokens);
      outputTokens += num(m.outputTokens);
      cacheReadInputTokens += num(m.cacheReadInputTokens);
      cacheCreationInputTokens += num(m.cacheCreationInputTokens);
      const c = numOrNull(m.costUSD);
      if (c !== null) {
        costFromModels += c;
        sawCost = true;
      }
    }
    // total_cost_usd is the canonical run-level figure; only fall back to summing
    // per-model costUSD when the envelope omitted it.
    if (cost === null && sawCost) cost = costFromModels;
  } else if (env.usage) {
    inputTokens = num(env.usage.input_tokens);
    outputTokens = num(env.usage.output_tokens);
    cacheReadInputTokens = num(env.usage.cache_read_input_tokens);
    cacheCreationInputTokens = num(env.usage.cache_creation_input_tokens);
  }

  return {
    estimatedCostUsd: cost,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalTokens: inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    numTurns: numOrNull(env.num_turns),
  };
}

/**
 * Accumulator for the per-RUN `pipeline_runs.cost_actuals` budget. Parallel
 * coders multiply cost ~7x, so the meaningful budget is per-run, not per-spawn —
 * this folds each spawn's usage into a running total. `spawns` counts metered
 * spawns so a per-spawn average is derivable.
 */
export interface CostActuals {
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  spawns: number;
}

export function emptyCostActuals(): CostActuals {
  return {
    estimatedCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    spawns: 0,
  };
}

/**
 * Parse a persisted `pipeline_runs.cost_actuals` JSON value back into the
 * accumulator. Returns null on absent/malformed input so callers start fresh.
 */
export function parseCostActuals(raw: string | null | undefined): CostActuals | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<CostActuals>;
    if (o === null || typeof o !== 'object') return null;
    return {
      estimatedCostUsd: num(o.estimatedCostUsd),
      inputTokens: num(o.inputTokens),
      outputTokens: num(o.outputTokens),
      cacheReadInputTokens: num(o.cacheReadInputTokens),
      cacheCreationInputTokens: num(o.cacheCreationInputTokens),
      totalTokens: num(o.totalTokens),
      spawns: num(o.spawns),
    };
  } catch {
    return null;
  }
}

export function addUsage(prior: CostActuals | null, usage: SpawnUsage | null): CostActuals {
  const base = prior ?? emptyCostActuals();
  if (!usage) return base;
  return {
    estimatedCostUsd: base.estimatedCostUsd + (usage.estimatedCostUsd ?? 0),
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    cacheReadInputTokens: base.cacheReadInputTokens + usage.cacheReadInputTokens,
    cacheCreationInputTokens: base.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    totalTokens: base.totalTokens + usage.totalTokens,
    spawns: base.spawns + 1,
  };
}
