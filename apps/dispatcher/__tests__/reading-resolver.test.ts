import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  buildRequiredContextBlock,
  parseReadingRefs,
  resolveReadingRefs,
  type ReadingReference,
  type ResolvedReading,
} from '../src/reading-resolver.js';

// ─── parseReadingRefs ────────────────────────────────────────────────────────

describe('parseReadingRefs', () => {
  test('T1 without section', () => {
    const refs = parseReadingRefs('T1');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.type, 'T1');
    assert.equal(refs[0]?.section, undefined);
    assert.equal(refs[0]?.raw, 'T1');
  });

  test('T1 with section', () => {
    const refs = parseReadingRefs('T1 §3.1');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.type, 'T1');
    assert.equal(refs[0]?.section, '3.1');
    assert.equal(refs[0]?.raw, 'T1 §3.1');
  });

  test('T2 with path, no section', () => {
    const refs = parseReadingRefs('T2 ~/Nyx/CLAUDE.md');
    assert.equal(refs[0]?.type, 'T2');
    assert.equal(refs[0]?.path, '~/Nyx/CLAUDE.md');
    assert.equal(refs[0]?.section, undefined);
  });

  test('T2 with path and section', () => {
    const refs = parseReadingRefs('T2 ~/Nyx/CLAUDE.md §Cost model');
    assert.equal(refs[0]?.type, 'T2');
    assert.equal(refs[0]?.path, '~/Nyx/CLAUDE.md');
    assert.equal(refs[0]?.section, 'Cost model');
  });

  test('T3 with path and section', () => {
    const refs = parseReadingRefs('T3 apps/foo/CLAUDE.md §Routes');
    assert.equal(refs[0]?.type, 'T3');
    assert.equal(refs[0]?.path, 'apps/foo/CLAUDE.md');
    assert.equal(refs[0]?.section, 'Routes');
  });

  test('T4 with slug', () => {
    const refs = parseReadingRefs('T4 2026-05-24-nyx-key-leak');
    assert.equal(refs[0]?.type, 'T4');
    assert.equal(refs[0]?.slug, '2026-05-24-nyx-key-leak');
  });

  test('decision with slug', () => {
    const refs = parseReadingRefs('decision adr-0001-composer-design');
    assert.equal(refs[0]?.type, 'decision');
    assert.equal(refs[0]?.slug, 'adr-0001-composer-design');
  });

  test('playbook with slug', () => {
    const refs = parseReadingRefs('playbook writing-nyx-task-specs');
    assert.equal(refs[0]?.type, 'playbook');
    assert.equal(refs[0]?.slug, 'writing-nyx-task-specs');
  });

  test('multiple comma-separated references', () => {
    const refs = parseReadingRefs('T1 §3.1, T4 some-slug');
    assert.equal(refs.length, 2);
    assert.equal(refs[0]?.type, 'T1');
    assert.equal(refs[0]?.section, '3.1');
    assert.equal(refs[1]?.type, 'T4');
    assert.equal(refs[1]?.slug, 'some-slug');
  });

  test('ignores empty tokens from extra commas', () => {
    const refs = parseReadingRefs('T4 my-slug,');
    assert.equal(refs.length, 1);
  });

  test('malformed token throws', () => {
    assert.throws(() => parseReadingRefs('UNKNOWN stuff'), /unrecognized reference/);
  });
});

// ─── resolveReadingRefs ──────────────────────────────────────────────────────

describe('resolveReadingRefs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-reading-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('file found → full content returned', () => {
    const filePath = resolve(tmpDir, 'test.md');
    writeFileSync(filePath, 'hello world', 'utf8');
    const ref: ReadingReference = { type: 'T2', path: filePath, raw: `T2 ${filePath}` };
    const { resolved, missing } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 1);
    assert.equal(missing.length, 0);
    assert.equal(resolved[0]?.content, 'hello world');
    assert.equal(resolved[0]?.ref.raw, ref.raw);
  });

  test('file missing → in missing[]', () => {
    const ref: ReadingReference = { type: 'T4', slug: 'nonexistent-slug-zzz', raw: 'T4 nonexistent-slug-zzz' };
    const { resolved, missing } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 0);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.raw, 'T4 nonexistent-slug-zzz');
  });

  test('file exists, section found → section content returned, not whole file', () => {
    const filePath = resolve(tmpDir, 'doc.md');
    writeFileSync(filePath, [
      '# Top',
      '',
      '## Pre-amble',
      '',
      'ignored preamble',
      '',
      '## Target Section',
      '',
      'section content here',
      'more content',
      '',
      '## Next Section',
      '',
      'should not appear',
    ].join('\n'), 'utf8');
    const ref: ReadingReference = {
      type: 'T2',
      path: filePath,
      section: 'Target Section',
      raw: `T2 ${filePath} §Target Section`,
    };
    const { resolved, missing } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 1);
    assert.equal(missing.length, 0);
    assert.ok(resolved[0]?.content.includes('section content here'));
    assert.ok(!resolved[0]?.content.includes('ignored preamble'));
    assert.ok(!resolved[0]?.content.includes('should not appear'));
  });

  test('section extraction stops at same-level heading', () => {
    const filePath = resolve(tmpDir, 'doc.md');
    writeFileSync(filePath, [
      '## Section A',
      'content A',
      '## Section B',
      'content B',
    ].join('\n'), 'utf8');
    const ref: ReadingReference = { type: 'T2', path: filePath, section: 'Section A', raw: 'T2 ...' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.ok(resolved[0]?.content.includes('content A'));
    assert.ok(!resolved[0]?.content.includes('content B'));
  });

  test('subsections are included within a parent section', () => {
    const filePath = resolve(tmpDir, 'doc.md');
    writeFileSync(filePath, [
      '## Parent',
      'parent text',
      '### Child',
      'child text',
      '## Sibling',
      'sibling text',
    ].join('\n'), 'utf8');
    const ref: ReadingReference = { type: 'T2', path: filePath, section: 'Parent', raw: 'T2 ...' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.ok(resolved[0]?.content.includes('parent text'));
    assert.ok(resolved[0]?.content.includes('child text'));
    assert.ok(!resolved[0]?.content.includes('sibling text'));
  });

  test('file exists, section missing → in missing[]', () => {
    const filePath = resolve(tmpDir, 'doc.md');
    writeFileSync(filePath, '# Only heading\n\ncontent', 'utf8');
    const ref: ReadingReference = {
      type: 'T2',
      path: filePath,
      section: 'Nonexistent Section',
      raw: 'T2 ... §Nonexistent Section',
    };
    const { resolved, missing } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 0);
    assert.equal(missing.length, 1);
  });

  test('section matching is case-insensitive', () => {
    const filePath = resolve(tmpDir, 'doc.md');
    writeFileSync(filePath, '## My Section\ncontent', 'utf8');
    const ref: ReadingReference = { type: 'T2', path: filePath, section: 'my section', raw: 'T2 ...' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 1);
  });

  test('mixed found and missing refs', () => {
    const filePath = resolve(tmpDir, 'found.md');
    writeFileSync(filePath, 'found content', 'utf8');
    const refs: ReadingReference[] = [
      { type: 'T2', path: filePath, raw: 'T2 found' },
      { type: 'T4', slug: 'totally-missing-slug-xyz', raw: 'T4 totally-missing-slug-xyz' },
    ];
    const { resolved, missing } = resolveReadingRefs(refs);
    assert.equal(resolved.length, 1);
    assert.equal(missing.length, 1);
  });
});

// ─── buildRequiredContextBlock ───────────────────────────────────────────────

describe('buildRequiredContextBlock', () => {
  test('produces correct header text', () => {
    const resolved: ResolvedReading[] = [
      { ref: { type: 'T1', section: '3.1', raw: 'T1 §3.1' }, content: '### 3.1 Heading\n\nSome content.' },
    ];
    const block = buildRequiredContextBlock(resolved);
    assert.ok(block.includes('## REQUIRED CONTEXT'));
    assert.ok(block.includes('[reading:] tag'));
  });

  test('each entry gets a ### header matching its raw token', () => {
    const resolved: ResolvedReading[] = [
      { ref: { type: 'T1', section: '3.1', raw: 'T1 §3.1' }, content: 'content one' },
    ];
    const block = buildRequiredContextBlock(resolved);
    assert.ok(block.includes('### T1 §3.1'));
    assert.ok(block.includes('content one'));
  });

  test('entries are separated by --- dividers', () => {
    const resolved: ResolvedReading[] = [
      { ref: { type: 'T1', raw: 'T1 §3.1' }, content: 'first content' },
      { ref: { type: 'T4', slug: 'my-slug', raw: 'T4 my-slug' }, content: 'second content' },
    ];
    const block = buildRequiredContextBlock(resolved);
    assert.ok(block.includes('---'));
    assert.ok(block.includes('### T1 §3.1'));
    assert.ok(block.includes('first content'));
    assert.ok(block.includes('### T4 my-slug'));
    assert.ok(block.includes('second content'));
    const lines = block.split('\n');
    const dividers = lines.filter(l => l.trim() === '---');
    assert.ok(dividers.length >= 2);
  });

  test('block ends with --- divider', () => {
    const resolved: ResolvedReading[] = [
      { ref: { type: 'T4', slug: 's', raw: 'T4 s' }, content: 'c' },
    ];
    const block = buildRequiredContextBlock(resolved);
    assert.ok(block.trimEnd().endsWith('---'));
  });
});
