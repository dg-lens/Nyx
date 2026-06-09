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
 * Flags appended to every metered `claude -p` invocation. Kept as a function (not
 * a const) so callers spread it at the call site and the intent reads at the spawn.
 */
export function costMeteringArgs(): string[] {
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
 * Parse the `--output-format json` envelope. `claude -p` emits a SINGLE JSON
 * object on stdout (not the streaming NDJSON of `--output-format stream-json`),
 * so the whole captured stdout is one object. Returns null on any parse/shape
 * failure so the caller can fall back to raw-stdout sentinel parsing.
 */
function parseEnvelope(stdout: string): ResultEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
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
