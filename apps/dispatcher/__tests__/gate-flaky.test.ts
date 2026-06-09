/**
 * Integration test for runGate's flaky-rerun (P7).
 *
 * Builds a tiny JS repo whose `test` script is deterministically non-determin-
 * istic: it fails on its first invocation and passes on its second (counter file
 * on disk). With rerunFlakyTests on, runGate must detect the flip and mark the
 * gate `flaky` WITHOUT taking the flipped green. Without the flag it must behave
 * exactly as before (a plain fail). A genuinely-green suite must not be reran.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { runGate } from '../src/test-gate.js';
import type { ParsedTask } from '../src/types.js';

function mkTask(): ParsedTask {
  return {
    id: 'FLAKY-1',
    description: 'x',
    type: 'code',
    model: 'sonnet',
    gates: ['tests'],
    priority: 'normal',
    checked: false,
    rawLines: [],
    startLine: 0,
    endLine: 0,
    invalidTags: [],
  };
}

function writeRepo(dir: string, testScript: string): void {
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify({ name: 'flaky-fixture', version: '0.0.0', scripts: { test: testScript } }),
  );
}

describe('runGate — flaky rerun', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gate-flaky-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fail-then-pass tests stage is quarantined as flaky, not taken green', () => {
    // The script increments a counter file; first run (count 1) exits 1, second
    // run (count 2) exits 0 and prints a pass marker. No tree change between runs.
    const counter = resolve(dir, '.count');
    const script =
      `node -e "const fs=require('fs');let n=0;try{n=+fs.readFileSync('${counter}','utf8')}catch{};` +
      `n++;fs.writeFileSync('${counter}',String(n));` +
      `if(n<2){console.error('1 failed');process.exit(1)}else{console.log('1 passed');process.exit(0)}"`;
    writeRepo(dir, script);

    const gate = runGate(mkTask(), dir, { rerunFlakyTests: true });
    assert.equal(gate.flaky, true);
    assert.equal(gate.passed, false, 'a flipped green must NOT be accepted');
    assert.deepEqual(gate.flakyDetail, { firstPassed: false, secondPassed: true });
    assert.ok(gate.stages.some((s) => s.name === 'tests-rerun'));
  });

  test('without the flag, the same fail is a plain non-flaky failure', () => {
    const counter = resolve(dir, '.count');
    const script =
      `node -e "const fs=require('fs');let n=0;try{n=+fs.readFileSync('${counter}','utf8')}catch{};` +
      `n++;fs.writeFileSync('${counter}',String(n));` +
      `if(n<2){console.error('1 failed');process.exit(1)}else{console.log('1 passed');process.exit(0)}"`;
    writeRepo(dir, script);

    const gate = runGate(mkTask(), dir, { rerunFlakyTests: false });
    assert.equal(gate.passed, false);
    assert.notEqual(gate.flaky, true);
    assert.ok(!gate.stages.some((s) => s.name === 'tests-rerun'));
  });

  test('a deterministically green suite passes and is not reran', () => {
    writeRepo(dir, `node -e "console.log('1 passed');process.exit(0)"`);
    const gate = runGate(mkTask(), dir, { rerunFlakyTests: true });
    assert.equal(gate.passed, true);
    assert.notEqual(gate.flaky, true);
    assert.ok(!gate.stages.some((s) => s.name === 'tests-rerun'));
  });

  test('a deterministically red suite stays red (reran once, second also fails)', () => {
    writeRepo(dir, `node -e "console.error('1 failed');process.exit(1)"`);
    const gate = runGate(mkTask(), dir, { rerunFlakyTests: true });
    assert.equal(gate.passed, false);
    assert.notEqual(gate.flaky, true);
    // The rerun happened (it's a tests-stage failure) but the verdict held.
    assert.ok(gate.stages.some((s) => s.name === 'tests-rerun'));
  });
});
