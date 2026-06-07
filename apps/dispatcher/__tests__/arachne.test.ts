import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildIndex, assemble, search, writeNode, deriveLoc, renderPack } from '../src/memory/arachne.js';

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'arachne-'));
  const dir = join(root, 'memory');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  mkdirSync(join(dir, 'moc'), { recursive: true });
  const node = (sub: string, id: string, fm: string, body: string) =>
    writeFileSync(join(dir, sub, id + '.md'), `---\n${fm}\n---\n\n${body}\n`);

  node('nodes', 'spine-secret', 'id: spine-secret\nkind: invariant\ntitle: Redact secrets\nsummary: scrub tokens\nloc: [stack.nyx]\nconcern: [secrets]\nload: always\naudience: [coder]\nweight: 9', 'RULE: redact.');
  node('nodes', 'redux-merge', 'id: redux-merge\nkind: invariant\ntitle: Merge authority\nsummary: P2 clears suspect\nloc: [stack.nyx.pipeline.redux]\nload: match\naudience: [coder]\nweight: 7\npaths: [apps/dispatcher/src/pipeline/redux.ts]\ntriggers: [decideMerges, semantic_suspect]', 'RULE: P2 arbitrates.');
  node('nodes', 'shipping-only', 'id: shipping-only\nkind: invariant\ntitle: Install deps\nsummary: install before smoke\nloc: [stack.nyx.pipeline.shipping]\nload: match\naudience: [coder]\nweight: 6\npaths: [apps/dispatcher/src/pipeline/shipping.ts]', 'RULE: install.');
  node('nodes', 'planner-overview', 'id: planner-overview\nkind: overview\ntitle: Pipeline overview\nsummary: the map\nloc: [stack.nyx.pipeline]\nload: entry\naudience: [planner]\nweight: 9', 'FLOW: ...');
  node('moc', 'moc-pipe', 'id: moc-pipe\nkind: moc\ntitle: Pipeline map\nsummary: router\nloc: [stack.nyx.pipeline]\nload: entry\naudience: [all]\nweight: 8', 'map');
  return dir;
}

describe('arachne engine', () => {
  test('buildIndex parses frontmatter + computes tokens', () => {
    const idx = buildIndex(vault());
    assert.equal(idx.length, 5);
    const m = idx.find((n) => n.id === 'redux-merge')!;
    assert.equal(m.kind, 'invariant');
    assert.deepEqual(m.loc, ['stack.nyx.pipeline.redux']);
    assert.ok(m.tokens > 0);
    assert.deepEqual(m.triggers, ['decideMerges', 'semantic_suspect']);
  });

  test('assemble scopes a redux coder task precisely', () => {
    const idx = buildIndex(vault());
    const pack = assemble(idx, {
      loc: 'stack.nyx.pipeline.redux',
      role: 'coder',
      paths: ['apps/dispatcher/src/pipeline/redux.ts'],
      text: 'fix decideMerges semantic_suspect',
      budget: 5000,
    });
    const ids = new Set(pack.ids);
    assert.ok(ids.has('spine-secret'), 'always-spine ancestor loaded');
    assert.ok(ids.has('redux-merge'), 'path/trigger match loaded');
    assert.ok(ids.has('moc-pipe'), 'entry MOC (audience all) loaded');
    assert.ok(!ids.has('shipping-only'), 'sibling segment excluded by scope');
    assert.ok(!ids.has('planner-overview'), 'planner-only entry excluded for coder role');
  });

  test('budget prunes under the ceiling but keeps the highest weight', () => {
    const idx = buildIndex(vault());
    const dir = { loc: 'stack.nyx.pipeline.redux', role: 'coder' as const, paths: ['apps/dispatcher/src/pipeline/redux.ts'], text: 'decideMerges' };
    const big = assemble(idx, { ...dir, budget: 5000 });
    const small = assemble(idx, { ...dir, budget: 6 });
    assert.ok(small.ids.length < big.ids.length, 'budget pruned at least one node');
    assert.ok(small.tokens <= 6, 'respects the ceiling');
    assert.ok(small.ids.includes('spine-secret'), 'highest-weight node survives');
    assert.equal(assemble(idx, { ...dir, budget: 0 }).ids.length, 0, 'budget 0 → empty');
  });

  test('deriveLoc maps repo + refines by path', () => {
    assert.equal(deriveLoc(null, []), 'stack.nyx');
    assert.equal(deriveLoc('lens-cx/employee-portal', []), 'stack.employee-portal');
    assert.equal(deriveLoc(null, ['apps/dispatcher/src/pipeline/redux.ts']), 'stack.nyx.pipeline');
  });

  test('writeNode emits a re-parseable agent-provenance leaf', () => {
    const dir = vault();
    const p = writeNode(dir, {
      id: 'Test Lesson!',
      kind: 'lesson',
      title: 'A test lesson',
      summary: 'when X do Y',
      loc: ['stack.nyx'],
      triggers: ['xyz'],
      body: 'SYMPTOM: x\nFIX: y',
    });
    assert.ok(p.endsWith('test-lesson-.md'));
    const idx = buildIndex(dir);
    const w = idx.find((n) => n.id === 'test-lesson-')!;
    assert.equal(w.provenance, 'agent');
    assert.equal(w.kind, 'lesson');
    assert.deepEqual(w.triggers, ['xyz']);
  });

  test('renderPack produces an injectable block or empty string', () => {
    const idx = buildIndex(vault());
    const pack = assemble(idx, { loc: 'stack.nyx.pipeline.redux', role: 'coder', paths: ['apps/dispatcher/src/pipeline/redux.ts'], text: 'decideMerges', budget: 5000 });
    assert.match(renderPack(pack), /## MEMORY/);
    assert.equal(renderPack({ nodes: [], ids: [], tokens: 0, reasons: {} }), '');
  });
});
