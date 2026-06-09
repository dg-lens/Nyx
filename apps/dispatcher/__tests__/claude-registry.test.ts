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
    registerClaude(process.pid, { class: 'iso' }, dir); // this test process is alive
    assert.equal(liveOwnClaudeCount(dir), 1);
    deregisterClaude(process.pid, dir);
    assert.equal(liveOwnClaudeCount(dir), 0);
  });

  test('sweeps dead + malformed entries; never wedges on a stale pidfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    writeFileSync(join(dir, '2147480000'), '1'); // a PID that cannot be alive (> macOS max)
    writeFileSync(join(dir, 'notapid'), '1');
    registerClaude(process.pid, { class: 'iso' }, dir);
    assert.equal(liveOwnClaudeCount(dir), 1); // only the live one
    assert.deepEqual(readdirSync(dir).sort(), [String(process.pid)]); // stale entries swept
  });

  test('counts a live entry regardless of class (aggregate budget) and sweeps a dead sibling', () => {
    // The budget math consumes the AGGREGATE live count — a git-class coder and an
    // iso-class digest each cost one Max-plan slot. A live entry of either class
    // counts as 1; a dead entry of either class is swept and counts as 0.
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    registerClaude(process.pid, { class: 'git', taskId: 'CODE-1' }, dir);
    writeFileSync(join(dir, '2147480000'), JSON.stringify({ class: 'iso', at: Date.now() })); // dead pid
    assert.equal(liveOwnClaudeCount(dir), 1);
    assert.deepEqual(readdirSync(dir).sort(), [String(process.pid)]); // dead entry swept
    deregisterClaude(process.pid, dir);
  });

  test('a legacy bare-timestamp entry still counts toward liveness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    // Old format: file content is just a millis timestamp, not JSON. The live
    // process owning it still consumes a budget slot.
    writeFileSync(join(dir, String(process.pid)), String(Date.now()));
    assert.equal(liveOwnClaudeCount(dir), 1);
  });
});
