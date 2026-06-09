/**
 * Tests for flaky-test classification (P7 rerun-on-same-commit).
 *
 * The load-bearing property: a verdict that DISAGREES across two same-tree runs
 * is flaky and must be quarantined — never silently taken as a green. These
 * assert the pure classifier + the same-tree guard.
 */

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  buildFlakyReport,
  classifyRerun,
} from '../src/flaky-detect.js';

describe('classifyRerun', () => {
  test('pass,pass → deterministic-pass', () => {
    assert.equal(classifyRerun(true, true).verdict, 'deterministic-pass');
  });
  test('fail,fail → deterministic-fail', () => {
    assert.equal(classifyRerun(false, false).verdict, 'deterministic-fail');
  });
  test('fail,pass → flaky (the retry-to-green case)', () => {
    assert.equal(classifyRerun(false, true).verdict, 'flaky');
  });
  test('pass,fail → flaky (order-independent)', () => {
    assert.equal(classifyRerun(true, false).verdict, 'flaky');
  });
  test('carries the two booleans through', () => {
    const c = classifyRerun(false, true);
    assert.equal(c.firstPassed, false);
    assert.equal(c.secondPassed, true);
  });
});

describe('buildFlakyReport', () => {
  test('names which verdicts flipped and that no retry-to-green happened', () => {
    const report = buildFlakyReport('FOO-1', classifyRerun(false, true));
    assert.ok(report.includes('FOO-1'));
    assert.ok(report.includes('run 1: FAIL'));
    assert.ok(report.includes('run 2: PASS'));
    assert.ok(/retry-to-green/i.test(report));
    assert.ok(report.includes('nyx resume FOO-1'));
  });
});
