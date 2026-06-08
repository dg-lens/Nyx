import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { assemble, search, type NodeMeta } from '../src/assemble.js';

const N = (o: Partial<NodeMeta>): NodeMeta => ({
  id: 'x', kind: 'invariant', title: '', summary: '', body: 'b',
  loc: ['stack'], concern: [], load: 'match', audience: ['all'], weight: 5,
  paths: [], symbols: [], triggers: [], status: 'active', tokens: 10, ...o,
});

describe('arachne-server assemble (PG-independent core)', () => {
  test('scope ancestry + always-spine + match; excludes siblings and role-mismatch', () => {
    const idx = [
      N({ id: 'spine', loc: ['stack.nyx'], load: 'always', audience: ['coder'], weight: 9 }),
      N({ id: 'redux', loc: ['stack.nyx.pipeline.redux'], load: 'match', paths: ['redux.ts'], triggers: ['decideMerges'], audience: ['coder'], weight: 7 }),
      N({ id: 'shipping', loc: ['stack.nyx.pipeline.shipping'], load: 'match', paths: ['shipping.ts'], audience: ['coder'], weight: 6 }),
      N({ id: 'plannerdoc', loc: ['stack.nyx.pipeline'], load: 'entry', audience: ['planner'], weight: 8 }),
    ];
    const p = assemble(idx, { loc: 'stack.nyx.pipeline.redux', role: 'coder', paths: ['redux.ts'], text: 'decideMerges', budget: 5000 });
    const ids = new Set(p.ids);
    assert.ok(ids.has('spine'), 'always-spine ancestor loaded');
    assert.ok(ids.has('redux'), 'path/trigger match loaded');
    assert.ok(!ids.has('shipping'), 'sibling segment excluded by scope');
    assert.ok(!ids.has('plannerdoc'), 'planner-only entry excluded for a coder');
  });

  test('budget caps by weight; search filters by text/loc', () => {
    const idx = [
      N({ id: 'a', weight: 9, tokens: 100, load: 'always', loc: ['stack'] }),
      N({ id: 'b', weight: 1, tokens: 100, load: 'always', loc: ['stack'] }),
    ];
    assert.deepEqual(assemble(idx, { loc: 'stack', role: 'all', paths: [], text: '', budget: 100 }).ids, ['a']);

    const hits = search(
      [N({ id: 'auth-rule', title: 'auth', loc: ['stack.nyx'] }), N({ id: 'other', title: 'zzz', loc: ['stack'] })],
      { text: 'auth' },
    );
    assert.deepEqual(hits.map((n) => n.id), ['auth-rule']);
  });
});
