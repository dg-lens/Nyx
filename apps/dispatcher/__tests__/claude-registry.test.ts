import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { registerClaude, deregisterClaude, liveClaudeCountByClass, liveOwnClaudeCount } from '../src/claude-registry.js';

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
});

describe('liveClaudeCountByClass (type-aware accounting)', () => {
  test('attributes a live ISO spawn to the iso bucket', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    registerClaude(process.pid, { class: 'iso', taskId: 'BRIEF-1' }, dir);
    assert.deepEqual(liveClaudeCountByClass(dir), { git: 0, iso: 1 });
    deregisterClaude(process.pid, dir);
  });

  test('a legacy bare-timestamp entry degrades to iso (never inflates the git count)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    // Old format: file content is just a millis timestamp, not JSON.
    writeFileSync(join(dir, String(process.pid)), String(Date.now()));
    assert.deepEqual(liveClaudeCountByClass(dir), { git: 0, iso: 1 });
  });

  test('a git-class entry counts toward git; sweeps a dead sibling of the other class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    registerClaude(process.pid, { class: 'git', taskId: 'CODE-1' }, dir);
    writeFileSync(join(dir, '2147480000'), JSON.stringify({ class: 'iso', at: Date.now() })); // dead pid
    assert.deepEqual(liveClaudeCountByClass(dir), { git: 1, iso: 0 });
    assert.deepEqual(readdirSync(dir).sort(), [String(process.pid)]); // dead entry swept
    deregisterClaude(process.pid, dir);
  });

  test('empty/absent dir → zero of each class', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    assert.deepEqual(liveClaudeCountByClass(dir), { git: 0, iso: 0 });
    assert.deepEqual(liveClaudeCountByClass(join(dir, 'does-not-exist')), { git: 0, iso: 0 });
  });
});
