import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { registerClaude, deregisterClaude, liveOwnClaudeCount } from '../src/claude-registry.js';

describe('claude-registry (own-mode concurrency tracking)', () => {
  test('counts live registered PIDs; register/deregister round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    assert.equal(liveOwnClaudeCount(dir), 0);
    registerClaude(process.pid, dir); // this test process is alive
    assert.equal(liveOwnClaudeCount(dir), 1);
    deregisterClaude(process.pid, dir);
    assert.equal(liveOwnClaudeCount(dir), 0);
  });

  test('sweeps dead + malformed entries; never wedges on a stale pidfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    writeFileSync(join(dir, '2147480000'), '1'); // a PID that cannot be alive (> macOS max)
    writeFileSync(join(dir, 'notapid'), '1');
    registerClaude(process.pid, dir);
    assert.equal(liveOwnClaudeCount(dir), 1); // only the live one
    assert.deepEqual(readdirSync(dir).sort(), [String(process.pid)]); // stale entries swept
  });
});
