import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  AMBIGUITY_FILE,
  buildAmbiguityHaltReport,
  parseAmbiguityFile,
  type AmbiguityEscalation,
} from '../src/ambiguity-escalation.js';

// ─── parseAmbiguityFile ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-ambiguity-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeAmbiguity(obj: unknown): void {
  mkdirSync(resolve(tmpDir, '.nyx'), { recursive: true });
  writeFileSync(resolve(tmpDir, AMBIGUITY_FILE), JSON.stringify(obj));
}

describe('parseAmbiguityFile — file not present', () => {
  test('returns null when .nyx/ambiguity.json does not exist', () => {
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });
});

describe('parseAmbiguityFile — malformed files fall through to null', () => {
  test('returns null for invalid JSON', () => {
    mkdirSync(resolve(tmpDir, '.nyx'), { recursive: true });
    writeFileSync(resolve(tmpDir, AMBIGUITY_FILE), 'not json {{{');
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null for non-object JSON', () => {
    writeAmbiguity([1, 2, 3]);
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when schema_version is not 1', () => {
    writeAmbiguity({
      schema_version: 2,
      task_id: 'FOO',
      question: 'Q?',
      options: [
        { label: 'A', description: 'desc A' },
        { label: 'B', description: 'desc B' },
      ],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when task_id is missing', () => {
    writeAmbiguity({
      schema_version: 1,
      question: 'Q?',
      options: [
        { label: 'A', description: 'desc A' },
        { label: 'B', description: 'desc B' },
      ],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when question is missing', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      options: [
        { label: 'A', description: 'desc A' },
        { label: 'B', description: 'desc B' },
      ],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when options has fewer than 2 entries', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: [{ label: 'A', description: 'desc A' }],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when options is not an array', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: 'not-an-array',
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when an option is missing label', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: [
        { description: 'desc A' },
        { label: 'B', description: 'desc B' },
      ],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when an option is missing description', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: [
        { label: 'A' },
        { label: 'B', description: 'desc B' },
      ],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when my_lean is present but not a string', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: [
        { label: 'A', description: 'desc A' },
        { label: 'B', description: 'desc B' },
      ],
      my_lean: 42,
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when lean_reason is present but not a string', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: [
        { label: 'A', description: 'desc A' },
        { label: 'B', description: 'desc B' },
      ],
      lean_reason: true,
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });

  test('returns null when pros on an option is not a string', () => {
    writeAmbiguity({
      schema_version: 1,
      task_id: 'FOO',
      question: 'Q?',
      options: [
        { label: 'A', description: 'desc A', pros: 123 },
        { label: 'B', description: 'desc B' },
      ],
    });
    assert.equal(parseAmbiguityFile(tmpDir), null);
  });
});

describe('parseAmbiguityFile — valid schema', () => {
  test('returns parsed object for minimal valid schema (2 options, no optionals)', () => {
    const input = {
      schema_version: 1,
      task_id: 'NYX-001',
      question: 'Which approach for the new module?',
      options: [
        { label: 'Option A', description: 'Use approach A' },
        { label: 'Option B', description: 'Use approach B' },
      ],
    };
    writeAmbiguity(input);
    const result = parseAmbiguityFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.task_id, 'NYX-001');
    assert.equal(result.question, 'Which approach for the new module?');
    assert.equal(result.options.length, 2);
    assert.equal(result.my_lean, undefined);
  });

  test('returns parsed object with optional my_lean and lean_reason', () => {
    const input = {
      schema_version: 1,
      task_id: 'NYX-002',
      question: 'Table name: foo_events or events?',
      options: [
        { label: 'foo_events', description: 'namespaced', pros: 'avoids collision', cons: 'redundant' },
        { label: 'events', description: 'short', pros: 'simple', cons: 'ambiguous' },
      ],
      my_lean: 'foo_events',
      lean_reason: 'aligns with existing table naming pattern',
    };
    writeAmbiguity(input);
    const result = parseAmbiguityFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.my_lean, 'foo_events');
    assert.equal(result.lean_reason, 'aligns with existing table naming pattern');
    assert.equal(result.options[0]?.pros, 'avoids collision');
  });

  test('accepts 3+ options', () => {
    const input = {
      schema_version: 1,
      task_id: 'FOO',
      question: 'Three-way choice?',
      options: [
        { label: 'A', description: 'desc A' },
        { label: 'B', description: 'desc B' },
        { label: 'C', description: 'desc C' },
      ],
    };
    writeAmbiguity(input);
    const result = parseAmbiguityFile(tmpDir);
    assert.ok(result !== null);
    assert.equal(result.options.length, 3);
  });
});

// ─── buildAmbiguityHaltReport ─────────────────────────────────────────────────

describe('buildAmbiguityHaltReport — output structure', () => {
  const base: AmbiguityEscalation = {
    schema_version: 1,
    task_id: 'TEST-001',
    question: 'Which naming convention?',
    options: [
      { label: 'snake_case', description: 'Use underscores' },
      { label: 'camelCase', description: 'Use camel casing' },
    ],
  };

  test('includes the question', () => {
    const report = buildAmbiguityHaltReport(base);
    assert.ok(report.includes('Which naming convention?'), `report: ${report}`);
  });

  test('includes each option label and description', () => {
    const report = buildAmbiguityHaltReport(base);
    assert.ok(report.includes('snake_case'));
    assert.ok(report.includes('Use underscores'));
    assert.ok(report.includes('camelCase'));
    assert.ok(report.includes('Use camel casing'));
  });

  test('does not include lean section when my_lean is absent', () => {
    const report = buildAmbiguityHaltReport(base);
    assert.ok(!report.includes('Agent lean:'), `report: ${report}`);
  });

  test('includes pros and cons when present', () => {
    const withDetail: AmbiguityEscalation = {
      ...base,
      options: [
        { label: 'A', description: 'desc A', pros: 'readable', cons: 'verbose' },
        { label: 'B', description: 'desc B' },
      ],
    };
    const report = buildAmbiguityHaltReport(withDetail);
    assert.ok(report.includes('readable'));
    assert.ok(report.includes('verbose'));
  });

  test('includes lean section when my_lean is present', () => {
    const withLean: AmbiguityEscalation = {
      ...base,
      my_lean: 'snake_case',
      lean_reason: 'matches existing codebase',
    };
    const report = buildAmbiguityHaltReport(withLean);
    assert.ok(report.includes('Agent lean: snake_case'), `report: ${report}`);
    assert.ok(report.includes('matches existing codebase'));
  });

  test('includes lean without reason when lean_reason is absent', () => {
    const withLean: AmbiguityEscalation = {
      ...base,
      my_lean: 'camelCase',
    };
    const report = buildAmbiguityHaltReport(withLean);
    assert.ok(report.includes('Agent lean: camelCase'));
    assert.ok(!report.includes('Reason:'));
  });
});
