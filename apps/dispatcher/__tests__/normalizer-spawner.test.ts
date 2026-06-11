/**
 * Tests for the normalizer spawn's artifact classification — the pure
 * `classifyNormalizerArtifact` half of `runNormalizerSpawn`, exercised without
 * spawning `claude`. Covers two PR-#53 gap fixes:
 *
 *   (fix 3) a genuine wall-clock timeout maps to `spawn_timeout` (carrying the
 *           elapsed ms), distinct from the generic `spawn_failed`.
 *   (fix 4) `artifact_malformed_json` AND `artifact_invalid_shape` both carry the
 *           raw artifact's tail so a postmortem can see what the agent wrote.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';

import { classifyNormalizerArtifact } from '../src/composer/normalizer-spawner.js';

const SPEC_REL = '.nyx/normalized-spec.json';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nyx-normspawn-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeArtifact(content: string): void {
  mkdirSync(resolve(dir, '.nyx'), { recursive: true });
  writeFileSync(resolve(dir, SPEC_REL), content, 'utf8');
}

// ── fix 3: timeout distinguished from spawn_failed ──────────────────────

describe('classifyNormalizerArtifact — timeout vs spawn_failed', () => {
  test('no artifact + timedOut → spawn_timeout with elapsed ms in detail', () => {
    const out = classifyNormalizerArtifact(dir, 'TASK-T', {
      timedOut: true,
      durationMs: 301_234,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.failure_class, 'spawn_timeout');
    assert.match(out.detail!, /timed out after 301234ms/);
  });

  test('no artifact + NOT timed out → artifact_missing (a structural spawn failure, not a timeout)', () => {
    const out = classifyNormalizerArtifact(dir, 'TASK-M', {
      timedOut: false,
      durationMs: 1200,
    });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.failure_class, 'artifact_missing');
  });

  test('a valid artifact present DESPITE a timeout is salvaged (ok), not classed as a timeout', () => {
    // The salvage contract: a slow exit that still wrote a complete spec is a
    // success, not a timeout.
    writeArtifact(
      JSON.stringify({
        task_id: 'TASK-OK',
        tightened_body: 'do it',
        acceptance_criteria: ['works'],
        anti_examples: [],
        resolved_paths: [],
        verdict: { solvable: 'yes', complete: 'yes', redundant_with: [], blocking_issues: [] },
      }),
    );
    const out = classifyNormalizerArtifact(dir, 'TASK-OK', {
      timedOut: true,
      durationMs: 999_999,
    });
    assert.ok(out.ok, 'a usable artifact wins over the timeout signal');
    if (!out.ok) return;
    assert.equal(out.result.spec.task_id, 'TASK-OK');
    // artifact cleaned up after a successful read
    assert.equal(existsSync(resolve(dir, SPEC_REL)), false);
  });
});

// ── fix 4: raw content carried in postmortem details ────────────────────

describe('classifyNormalizerArtifact — raw content for postmortems', () => {
  test('artifact_malformed_json carries the parse error AND the raw content tail', () => {
    const raw = '{ "task_id": "X", this is not valid json ]]]';
    writeArtifact(raw);
    const out = classifyNormalizerArtifact(dir, 'X', { timedOut: false, durationMs: 10 });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.failure_class, 'artifact_malformed_json');
    assert.match(out.detail!, /parse error:/);
    // the raw content the agent wrote must be present so a human can see it
    assert.match(out.detail!, /this is not valid json/);
  });

  test('artifact_invalid_shape carries a cause summary AND the raw content tail (previously had NO detail)', () => {
    // Valid JSON, but not a normalized-spec object (an array fails shape check).
    const raw = JSON.stringify(['not', 'a', 'spec', 'object']);
    writeArtifact(raw);
    const out = classifyNormalizerArtifact(dir, 'X', { timedOut: false, durationMs: 10 });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.failure_class, 'artifact_invalid_shape');
    assert.ok(out.detail, 'invalid_shape must now carry detail (was previously absent)');
    assert.match(out.detail!, /shape validation/);
    assert.match(out.detail!, /not.*a.*spec/);
  });

  test('the raw tail is bounded to the last 500 chars of a long artifact', () => {
    // A long blob whose first chars differ from its last 500 — only the tail
    // should appear in the detail.
    const head = 'HEAD_MARKER';
    const tail = 'T'.repeat(500);
    const raw = `${head}${'M'.repeat(2000)}${tail}`; // total well over 500, valid-JSON-free → malformed
    writeArtifact(raw);
    const out = classifyNormalizerArtifact(dir, 'X', { timedOut: false, durationMs: 10 });
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.failure_class, 'artifact_malformed_json');
    assert.ok(out.detail!.includes(tail), 'the last 500 chars must be present');
    assert.ok(!out.detail!.includes(head), 'the head (>500 chars back) must be dropped');
  });
});
