/**
 * Tests for spawn-usage.ts — the `--output-format json` cost/token parser.
 *
 * The load-bearing invariant under test: parsing the envelope must (a) recover
 * the agent's final text from `result` so the VERDICT sentinel survives, and
 * (b) fall back cleanly (null usage, raw text) on any non-envelope stdout so a
 * sentinel parse on the original output still works. Field names are pinned to a
 * real `claude -p --output-format json` envelope captured at build time.
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  addUsage,
  costMeteringArgs,
  emptyCostActuals,
  extractResultText,
  parseCostActuals,
  parseMcpToolEvents,
  parseUsage,
} from '../src/spawn-usage.js';

// A real envelope shape (field names verified against the live CLI).
const ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  result: 'VERDICT: fixed — added rate limiting to the auth endpoint',
  total_cost_usd: 0.0147809,
  usage: {
    input_tokens: 10,
    output_tokens: 43,
    cache_read_input_tokens: 11524,
    cache_creation_input_tokens: 10318,
  },
  modelUsage: {
    'claude-sonnet-4-5-20250929': {
      inputTokens: 456,
      outputTokens: 55,
      cacheReadInputTokens: 11524,
      cacheCreationInputTokens: 10318,
      costUSD: 0.0147809,
    },
  },
});

describe('costMeteringArgs', () => {
  test('emits --output-format json by default', () => {
    assert.deepEqual(costMeteringArgs(), ['--output-format', 'json']);
  });
  test('emits stream-json + --verbose for the MCP-attribution format', () => {
    assert.deepEqual(costMeteringArgs({ format: 'stream-json' }), ['--output-format', 'stream-json', '--verbose']);
  });
});

// A faithful stream-json transcript: per-turn event lines + a final `result` line
// that is byte-identical to the single-json envelope. Mirrors the live CLI shape.
const STREAM_JSON = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__Sanity__whoami', input: {} }] },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'bearer token is invalid or expired: HTTP 401' }],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'mcp__Notion__search', input: {} }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', is_error: false, content: [{ type: 'text', text: '3 results' }] }] },
  }),
  ENVELOPE,
].join('\n');

describe('extractResultText / parseUsage are robust to stream-json (superset)', () => {
  test('extractResultText finds the result envelope on the LAST NDJSON line', () => {
    assert.equal(extractResultText(STREAM_JSON), 'VERDICT: fixed — added rate limiting to the auth endpoint');
  });
  test('parseUsage reads cost/tokens from the stream-json result line', () => {
    const u = parseUsage(STREAM_JSON);
    assert.ok(u);
    assert.equal(u!.estimatedCostUsd, 0.0147809);
    assert.equal(u!.inputTokens, 456);
  });
});

describe('parseMcpToolEvents — per-call MCP attribution from stream-json', () => {
  test('pairs each tool_use with its tool_result error status', () => {
    const events = parseMcpToolEvents(STREAM_JSON);
    const byTool = new Map(events.map((e) => [e.tool, e]));
    assert.equal(events.length, 2);
    assert.equal(byTool.get('mcp__Sanity__whoami')?.isError, true);
    assert.match(byTool.get('mcp__Sanity__whoami')!.resultText, /HTTP 401/);
    assert.equal(byTool.get('mcp__Notion__search')?.isError, false);
    assert.equal(byTool.get('mcp__Notion__search')?.resultText, '3 results');
  });
  test('ignores non-mcp tool_use blocks (Read/Grep/etc.)', () => {
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r', is_error: false, content: 'file body' }] } }),
      ENVELOPE,
    ].join('\n');
    assert.deepEqual(parseMcpToolEvents(out), []);
  });
  test('a tool_use with no paired result is reported as an error (wedged call)', () => {
    const out = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__Slack__send', input: {} }] } }),
    ].join('\n');
    // The single-line input has no newline so it short-circuits to [] — guard the
    // newline requirement by appending an (unrelated) line.
    const multi = `${out}\n${JSON.stringify({ type: 'system' })}`;
    const events = parseMcpToolEvents(multi);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.isError, true);
  });
  test('returns empty for single-json (no tool_use blocks) and plain text', () => {
    assert.deepEqual(parseMcpToolEvents(ENVELOPE), []);
    assert.deepEqual(parseMcpToolEvents('ASSISTANT COMPLETE\nplain output'), []);
  });
});

describe('extractResultText — sentinel preservation', () => {
  test('recovers the result text (carrying the VERDICT sentinel)', () => {
    const text = extractResultText(ENVELOPE);
    assert.equal(text, 'VERDICT: fixed — added rate limiting to the auth endpoint');
    assert.match(text!, /^VERDICT: fixed/);
  });

  test('returns null for non-JSON stdout so the caller keeps raw text', () => {
    assert.equal(extractResultText('VERDICT: fixed — plain text, no json'), null);
  });

  test('returns null for a JSON blob that is not a result envelope', () => {
    // An agent that legitimately printed JSON as its answer must NOT be mistaken
    // for the metering envelope.
    assert.equal(extractResultText('{"foo": "bar", "result": "not a sentinel"}'), null);
  });

  test('tolerates leading/trailing whitespace around the envelope', () => {
    assert.equal(extractResultText(`\n  ${ENVELOPE}\n`), 'VERDICT: fixed — added rate limiting to the auth endpoint');
  });

  test('returns empty string when result key is absent from a valid envelope', () => {
    const noResult = JSON.stringify({ type: 'result', total_cost_usd: 0.5 });
    assert.equal(extractResultText(noResult), '');
  });
});

describe('parseUsage', () => {
  test('extracts cost + tokens from modelUsage (preferred) + top-level cost', () => {
    const u = parseUsage(ENVELOPE);
    assert.ok(u);
    assert.equal(u!.estimatedCostUsd, 0.0147809);
    assert.equal(u!.numTurns, 3);
    assert.equal(u!.inputTokens, 456);
    assert.equal(u!.outputTokens, 55);
    assert.equal(u!.cacheReadInputTokens, 11524);
    assert.equal(u!.cacheCreationInputTokens, 10318);
    assert.equal(u!.totalTokens, 456 + 55 + 11524 + 10318);
  });

  test('sums costUSD across multiple models when total_cost_usd is absent', () => {
    const multi = JSON.stringify({
      type: 'result',
      result: 'done',
      modelUsage: {
        'model-a': { inputTokens: 100, outputTokens: 10, costUSD: 0.01 },
        'model-b': { inputTokens: 200, outputTokens: 20, costUSD: 0.02 },
      },
    });
    const u = parseUsage(multi);
    assert.ok(u);
    assert.ok(Math.abs(u!.estimatedCostUsd! - 0.03) < 1e-9);
    assert.equal(u!.inputTokens, 300);
    assert.equal(u!.outputTokens, 30);
  });

  test('falls back to top-level usage when modelUsage is absent', () => {
    const noModel = JSON.stringify({
      type: 'result',
      result: 'done',
      total_cost_usd: 0.5,
      usage: { input_tokens: 7, output_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
    });
    const u = parseUsage(noModel);
    assert.ok(u);
    assert.equal(u!.estimatedCostUsd, 0.5);
    assert.equal(u!.inputTokens, 7);
    assert.equal(u!.totalTokens, 7 + 9 + 1 + 2);
  });

  test('returns null cost (not 0) when no cost field is present', () => {
    const noCost = JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1 } });
    const u = parseUsage(noCost);
    assert.ok(u);
    assert.equal(u!.estimatedCostUsd, null);
  });

  test('returns null for unparseable / non-envelope stdout', () => {
    assert.equal(parseUsage('not json at all'), null);
    assert.equal(parseUsage(''), null);
    assert.equal(parseUsage('{"type":"assistant"}'), null);
  });
});

describe('CostActuals accumulation', () => {
  test('addUsage folds spawn usage into a running per-run total', () => {
    let acc = emptyCostActuals();
    acc = addUsage(acc, parseUsage(ENVELOPE));
    acc = addUsage(acc, parseUsage(ENVELOPE));
    assert.equal(acc.spawns, 2);
    assert.ok(Math.abs(acc.estimatedCostUsd - 2 * 0.0147809) < 1e-9);
    assert.equal(acc.inputTokens, 2 * 456);
    assert.equal(acc.totalTokens, 2 * (456 + 55 + 11524 + 10318));
  });

  test('addUsage is a no-op (no spawn increment) for null usage', () => {
    const acc = addUsage(emptyCostActuals(), null);
    assert.equal(acc.spawns, 0);
    assert.equal(acc.estimatedCostUsd, 0);
  });

  test('addUsage starting from null prior initializes the accumulator', () => {
    const acc = addUsage(null, parseUsage(ENVELOPE));
    assert.equal(acc.spawns, 1);
  });

  test('null estimatedCostUsd contributes 0 to the running cost', () => {
    const noCost = JSON.stringify({ type: 'result', result: 'x', usage: { input_tokens: 5, output_tokens: 5 } });
    const acc = addUsage(emptyCostActuals(), parseUsage(noCost));
    assert.equal(acc.estimatedCostUsd, 0);
    assert.equal(acc.totalTokens, 10);
  });

  test('parseCostActuals round-trips a persisted JSON value', () => {
    let acc = emptyCostActuals();
    acc = addUsage(acc, parseUsage(ENVELOPE));
    const round = parseCostActuals(JSON.stringify(acc));
    assert.deepEqual(round, acc);
  });

  test('parseCostActuals returns null on absent/malformed input', () => {
    assert.equal(parseCostActuals(null), null);
    assert.equal(parseCostActuals(undefined), null);
    assert.equal(parseCostActuals('not json'), null);
  });
});
