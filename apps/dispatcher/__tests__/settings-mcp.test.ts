import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { loadSettings, SETTINGS_DEFAULTS } from '../src/settings.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'nyx-settings-mcp-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(obj: unknown): void {
  writeFileSync(resolve(dir, 'settings.json'), JSON.stringify(obj));
}

describe('loadSettings — mcp block', () => {
  test('absent settings.json yields the default mcp block', () => {
    assert.deepEqual(loadSettings(dir).mcp, SETTINGS_DEFAULTS.mcp);
  });

  test('a settings.json with no mcp key falls back to defaults', () => {
    write({ pipeline: { concurrentCap: 8 } });
    assert.deepEqual(loadSettings(dir).mcp, SETTINGS_DEFAULTS.mcp);
  });

  test('a partial mcp block merges onto defaults', () => {
    write({ mcp: { breaker: { failureThreshold: 5 } } });
    const m = loadSettings(dir).mcp;
    assert.equal(m.breaker.failureThreshold, 5);
    assert.equal(m.breaker.cooldownMs, SETTINGS_DEFAULTS.mcp.breaker.cooldownMs);
    assert.equal(m.probe.enabled, SETTINGS_DEFAULTS.mcp.probe.enabled);
  });

  test('an out-of-range threshold is clamped', () => {
    write({ mcp: { breaker: { failureThreshold: 0 } } });
    assert.equal(loadSettings(dir).mcp.breaker.failureThreshold, 1);
  });

  test('a non-finite cooldown falls back to the default', () => {
    write({ mcp: { breaker: { cooldownMs: 'nope' } } });
    assert.equal(loadSettings(dir).mcp.breaker.cooldownMs, SETTINGS_DEFAULTS.mcp.breaker.cooldownMs);
  });

  test('a bogus defaultPolicy falls back to the default', () => {
    write({ mcp: { policy: { defaultPolicy: 'allowall' } } });
    assert.equal(loadSettings(dir).mcp.policy.defaultPolicy, SETTINGS_DEFAULTS.mcp.policy.defaultPolicy);
  });

  test('valid per-tool policies are kept and invalid ones dropped', () => {
    write({
      mcp: { policy: { tools: { 'mcp__Slack': 'deny', 'mcp__Notion': 'bogus', 'mcp__Drive': 'ask' } } },
    });
    const tools = loadSettings(dir).mcp.policy.tools;
    assert.equal(tools['mcp__Slack'], 'deny');
    assert.equal(tools['mcp__Drive'], 'ask');
    assert.equal('mcp__Notion' in tools, false, 'an invalid policy value must be dropped, not coerced');
  });

  test('probe.enabled false is honored', () => {
    write({ mcp: { probe: { enabled: false } } });
    assert.equal(loadSettings(dir).mcp.probe.enabled, false);
  });

  test('refreshAtFraction out of (0,1] is clamped', () => {
    write({ mcp: { auth: { refreshAtFraction: 2 } } });
    assert.equal(loadSettings(dir).mcp.auth.refreshAtFraction, 1);
  });
});
