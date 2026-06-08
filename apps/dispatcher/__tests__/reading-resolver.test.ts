import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  _setNodesDir,
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
    assert.equal(refs[0]?.type, 'T1');
    assert.equal(refs[0]?.section, '3.1');
  });

  test('node <id> (canonical)', () => {
    const refs = parseReadingRefs('node migrations-no-auto-apply');
    assert.equal(refs[0]?.type, 'node');
    assert.equal(refs[0]?.slug, 'migrations-no-auto-apply');
  });

  test('node with §section', () => {
    const refs = parseReadingRefs('node greenfield-target-mode §FIX');
    assert.equal(refs[0]?.type, 'node');
    assert.equal(refs[0]?.slug, 'greenfield-target-mode');
    assert.equal(refs[0]?.section, 'FIX');
  });

  test('legacy T4/decision/playbook map to node by slug', () => {
    assert.equal(parseReadingRefs('T4 anthropic-key-leak')[0]?.type, 'node');
    assert.equal(parseReadingRefs('T4 anthropic-key-leak')[0]?.slug, 'anthropic-key-leak');
    assert.equal(parseReadingRefs('decision composer-as-predispatch-compiler')[0]?.slug, 'composer-as-predispatch-compiler');
    assert.equal(parseReadingRefs('playbook applying-prod-migrations')[0]?.slug, 'applying-prod-migrations');
  });

  test('legacy T2/T3 path maps to node by basename', () => {
    const r = parseReadingRefs('T3 apps/foo/CLAUDE.md §Routes');
    assert.equal(r[0]?.type, 'node');
    assert.equal(r[0]?.slug, 'CLAUDE');
    assert.equal(r[0]?.section, 'Routes');
  });

  test('bare token resolves as a node id', () => {
    const refs = parseReadingRefs('self-task-merge-no-origin');
    assert.equal(refs[0]?.type, 'node');
    assert.equal(refs[0]?.slug, 'self-task-merge-no-origin');
  });

  test('multiple comma-separated references', () => {
    const refs = parseReadingRefs('T1 §3.1, node some-node');
    assert.equal(refs.length, 2);
    assert.equal(refs[0]?.type, 'T1');
    assert.equal(refs[1]?.type, 'node');
    assert.equal(refs[1]?.slug, 'some-node');
  });

  test('ignores empty tokens from extra commas', () => {
    assert.equal(parseReadingRefs('node my-node,').length, 1);
  });

  test('malformed T1 reference throws', () => {
    assert.throws(() => parseReadingRefs('T1 garbage'), /malformed T1/);
  });
});

// ─── resolveReadingRefs ──────────────────────────────────────────────────────

describe('resolveReadingRefs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'nyx-reading-test-'));
    _setNodesDir(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    _setNodesDir(null);
  });

  function writeNode(slug: string, body: string): void {
    writeFileSync(resolve(tmpDir, `${slug}.md`), body, 'utf8');
  }

  test('node found → full content returned', () => {
    writeNode('hello', 'hello world');
    const ref: ReadingReference = { type: 'node', slug: 'hello', raw: 'node hello' };
    const { resolved, missing } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 1);
    assert.equal(missing.length, 0);
    assert.equal(resolved[0]?.content, 'hello world');
  });

  test('node missing → in missing[]', () => {
    const ref: ReadingReference = { type: 'node', slug: 'nonexistent-zzz', raw: 'node nonexistent-zzz' };
    const { resolved, missing } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 0);
    assert.equal(missing.length, 1);
  });

  test('section found → section content returned, not whole node', () => {
    writeNode('doc', [
      '# Top', '', '## Pre-amble', '', 'ignored preamble', '',
      '## Target Section', '', 'section content here', 'more content', '',
      '## Next Section', '', 'should not appear',
    ].join('\n'));
    const ref: ReadingReference = { type: 'node', slug: 'doc', section: 'Target Section', raw: 'node doc §Target Section' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.ok(resolved[0]?.content.includes('section content here'));
    assert.ok(!resolved[0]?.content.includes('ignored preamble'));
    assert.ok(!resolved[0]?.content.includes('should not appear'));
  });

  test('section extraction stops at same-level heading', () => {
    writeNode('doc', ['## Section A', 'content A', '## Section B', 'content B'].join('\n'));
    const ref: ReadingReference = { type: 'node', slug: 'doc', section: 'Section A', raw: 'node doc §Section A' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.ok(resolved[0]?.content.includes('content A'));
    assert.ok(!resolved[0]?.content.includes('content B'));
  });

  test('subsections are included within a parent section', () => {
    writeNode('doc', ['## Parent', 'parent text', '### Child', 'child text', '## Sibling', 'sibling text'].join('\n'));
    const ref: ReadingReference = { type: 'node', slug: 'doc', section: 'Parent', raw: 'node doc §Parent' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.ok(resolved[0]?.content.includes('parent text'));
    assert.ok(resolved[0]?.content.includes('child text'));
    assert.ok(!resolved[0]?.content.includes('sibling text'));
  });

  test('section matching is case-insensitive', () => {
    writeNode('doc', '## My Section\ncontent');
    const ref: ReadingReference = { type: 'node', slug: 'doc', section: 'my section', raw: 'node doc §my section' };
    const { resolved } = resolveReadingRefs([ref]);
    assert.equal(resolved.length, 1);
  });

  test('mixed found and missing refs', () => {
    writeNode('found', 'found content');
    const refs: ReadingReference[] = [
      { type: 'node', slug: 'found', raw: 'node found' },
      { type: 'node', slug: 'totally-missing-xyz', raw: 'node totally-missing-xyz' },
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
      { ref: { type: 'node', slug: 'my-node', raw: 'node my-node' }, content: 'content one' },
    ];
    const block = buildRequiredContextBlock(resolved);
    assert.ok(block.includes('### node my-node'));
    assert.ok(block.includes('content one'));
  });

  test('block ends with --- divider', () => {
    const resolved: ResolvedReading[] = [
      { ref: { type: 'node', slug: 's', raw: 'node s' }, content: 'c' },
    ];
    const block = buildRequiredContextBlock(resolved);
    assert.ok(block.trimEnd().endsWith('---'));
  });
});
