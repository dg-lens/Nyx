/**
 * Integration test for runGate's flaky-rerun (P7) + the machine-wide heavy-gate
 * lock.
 *
 * Builds a tiny JS repo whose `test` script is deterministically non-determin-
 * istic: it fails on its first invocation and passes on its second (counter file
 * on disk). With rerunFlakyTests on, runGate must detect the flip and PASS the
 * gate — a rerun-pass is a flaky-pass, surfaced via flaky/flakyDetail (→
 * task.gate.flaky) rather than halting work. A rerun that fails again is a
 * deterministic fail, unchanged. Without the flag a tests failure is a plain
 * fail. A genuinely-green suite must not be reran.
 *
 * Every test points the heavy-gate lock at a tmpdir via _setHeavyGateLockDir so
 * the suite never contends with a real gate on the operator's machine.
 */

import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { _setHeavyGateLockDir } from '../src/heavy-gate-lock.js';
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

function failThenPassScript(dir: string): string {
  // The script increments a counter file; first run (count 1) exits 1, second
  // run (count 2) exits 0 and prints a pass marker. No tree change between runs.
  const counter = resolve(dir, '.count');
  return (
    `node -e "const fs=require('fs');let n=0;try{n=+fs.readFileSync('${counter}','utf8')}catch{};` +
    `n++;fs.writeFileSync('${counter}',String(n));` +
    `if(n<2){console.error('1 failed');process.exit(1)}else{console.log('1 passed');process.exit(0)}"`
  );
}

describe('runGate — flaky rerun + heavy-gate lock', () => {
  let dir: string;
  let lockDir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gate-flaky-'));
    lockDir = resolve(dir, 'heavy-gate.lock');
    _setHeavyGateLockDir(lockDir);
  });
  afterEach(() => {
    _setHeavyGateLockDir(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fail-then-pass tests stage is a flaky-PASS: gate passes, flake surfaced with timings', () => {
    writeRepo(dir, failThenPassScript(dir));

    const gate = runGate(mkTask(), dir, { rerunFlakyTests: true });
    assert.equal(gate.passed, true, 'rerun-pass = flaky-pass: the gate must PASS');
    assert.equal(gate.flaky, true);
    assert.equal(gate.flakyDetail?.firstPassed, false);
    assert.equal(gate.flakyDetail?.secondPassed, true);
    assert.ok(typeof gate.flakyDetail?.firstRunMs === 'number' && gate.flakyDetail.firstRunMs >= 0);
    assert.ok(typeof gate.flakyDetail?.rerunMs === 'number' && gate.flakyDetail.rerunMs >= 0);
    assert.ok(gate.stages.some((s) => s.name === 'tests-rerun' && s.passed));
    assert.ok(gate.stages.some((s) => s.name === 'tests' && !s.passed), 'the first failed run stays on record');
  });

  test('without the flag, the same fail is a plain non-flaky failure', () => {
    writeRepo(dir, failThenPassScript(dir));

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

  test('the heavy-gate lock is taken during the gate and released after — pass and fail alike', () => {
    writeRepo(dir, `node -e "console.log('1 passed');process.exit(0)"`);
    const green = runGate(mkTask(), dir, { rerunFlakyTests: true });
    assert.equal(green.passed, true);
    assert.notEqual(green.lockTimedOut, true);
    assert.equal(existsSync(lockDir), false, 'lock must be released in the finally');

    writeRepo(dir, `node -e "console.error('1 failed');process.exit(1)"`);
    const red = runGate(mkTask(), dir, { rerunFlakyTests: true });
    assert.equal(red.passed, false);
    assert.equal(existsSync(lockDir), false, 'lock must be released on the failure path too');
  });

  test('a live foreign holder: the gate waits out the budget, PROCEEDS, and flags lockTimedOut', () => {
    writeRepo(dir, `node -e "console.log('1 passed');process.exit(0)"`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(resolve(lockDir, 'pid'), String(process.pid)); // alive — never recovered as stale

    const gate = runGate(mkTask(), dir, {
      rerunFlakyTests: true,
      _lockOpts: { timeoutMs: 250, pollMs: 50 },
    });
    assert.equal(gate.passed, true, 'timeout must never block the gate');
    assert.equal(gate.lockTimedOut, true);
    assert.ok((gate.lockWaitedMs ?? 0) >= 200, `waited ${gate.lockWaitedMs}ms, expected ~250ms`);
    assert.equal(existsSync(resolve(lockDir, 'pid')), true, 'the foreign lock is never removed');
  });
});
