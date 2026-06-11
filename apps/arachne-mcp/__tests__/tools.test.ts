import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { IndexCache } from '../src/vault.js';
import {
  loadTool,
  neighborsTool,
  packTool,
  searchTool,
  surveyTool,
  validateTool,
  writeTool,
} from '../src/tools.js';

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'arachne-mcp-'));
  const dir = join(root, 'memory');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  mkdirSync(join(dir, 'moc'), { recursive: true });
  const node = (sub: string, id: string, fm: string, body: string) =>
    writeFileSync(join(dir, sub, id + '.md'), `---\n${fm}\n---\n\n${body}\n`);

  node(
    'nodes',
    'spawn-kill-group',
    'id: spawn-kill-group\nkind: invariant\ntitle: Kill the process group\nsummary: claude spawns grandchildren that hold pipes — kill the whole process group, not the leader\nloc: [stack.nyx.dispatch]\nconcern: [spawn]\nload: match\naudience: [coder]\nweight: 8\ntriggers: ["spawn timeout", "process group", "duration overshoot", "SIGTERM"]\npaths: ["apps/dispatcher/src/spawn-helpers.ts"]\nprovenance: operator\nconfidence: high\nstatus: active\nedges:\n  relates: [secret-redaction]',
    'SYMPTOM: duration overshoot.\nFIX: process.kill(-pid).\nCHECK: detached true.\nANTI: child.kill leaves grandchildren.',
  );
  node(
    'nodes',
    'secret-redaction',
    'id: secret-redaction\nkind: invariant\ntitle: Redact secrets in logs\nsummary: never log bitwarden tokens; scrub before any audit write\nloc: [stack.nyx]\nconcern: [secrets]\nload: always\naudience: [coder]\nweight: 9\ntriggers: ["secret", "token", "redact"]\nprovenance: operator\nconfidence: high\nstatus: active',
    'RULE: scrub tokens before logging.',
  );
  node(
    'moc',
    'moc-dispatch',
    'id: moc-dispatch\nkind: moc\ntitle: Dispatch map\nsummary: router for the dispatch subsystem\nloc: [stack.nyx.dispatch]\nload: entry\naudience: [all]\nweight: 8\nprovenance: operator\nconfidence: high\nstatus: active',
    'map of the dispatch scope.',
  );
  node(
    'nodes',
    'agent-pending-spawn',
    'id: agent-pending-spawn\nkind: lesson\ntitle: Agent-authored spawn note\nsummary: spawn timeout grandchildren process group lesson learned by an agent run\nloc: [stack.nyx.dispatch]\nconcern: [spawn]\nload: match\naudience: [coder]\nweight: 5\ntriggers: ["spawn timeout", "process group"]\nprovenance: agent\nconfidence: medium\nstatus: active\nreview: pending',
    'SYMPTOM: spawn timeout.\nFIX: kill the group.',
  );
  writeFileSync(
    join(dir, 'nodes', 'corrupt-node.md'),
    '---\nid: corrupt-node\nkind: lesson\ntitle: broken\nsummary: "unterminated quote\nloc: [stack.nyx\n---\n\nbody.\n',
  );
  return dir;
}

describe('arachne-mcp tools', () => {
  test('search-by-trigger returns the matching node', () => {
    const cache = new IndexCache(vault());
    const hits = searchTool(cache, { triggers: ['process group'] });
    const ids = hits.map((h) => h.id);
    assert.ok(ids.includes('spawn-kill-group'), 'trigger surfaces the operator node');
  });

  test('search returns the review:pending agent node WITH provenance/review fields', () => {
    const cache = new IndexCache(vault());
    const hits = searchTool(cache, { triggers: ['process group'] });
    const pending = hits.find((h) => h.id === 'agent-pending-spawn');
    assert.ok(pending, 'pending agent node IS returnable by search');
    assert.equal(pending!.provenance, 'agent');
    assert.equal(pending!.review, 'pending');
    assert.equal(pending!.confidence, 'medium');
    assert.equal(pending!.injectable, false, 'flagged non-injectable');
  });

  test('pack EXCLUDES the review:pending agent node it would otherwise match', () => {
    const cache = new IndexCache(vault());
    const pack = packTool(cache, {
      repo: 'dg-lens/Nyx',
      paths: ['apps/dispatcher/src/cli/run-once.ts'],
      triggers: ['process group', 'spawn timeout'],
      audience: 'coder',
      budget: 5000,
    });
    assert.equal(pack.directive.loc, 'stack.nyx.dispatch');
    assert.ok(pack.ids.includes('spawn-kill-group'), 'injectable operator match is packed');
    assert.ok(!pack.ids.includes('agent-pending-spawn'), 'pending agent node never injected');
    assert.ok(!pack.text.includes('agent-pending-spawn'), 'pending node not rendered into MEMORY block');
  });

  test('near-duplicate write is REFUSED by classifyWrite, naming the existing id', () => {
    const cache = new IndexCache(vault());
    const before = cache.get().length;
    const res = writeTool(cache, cache.vault, {
      id: 'spawn-kill-group',
      kind: 'invariant',
      title: 'Kill the process group',
      summary: 'claude spawns grandchildren that hold pipes — kill the whole process group, not the leader',
      loc: ['stack.nyx.dispatch'],
      concern: ['spawn'],
      body: 'duplicate of the spawn kill lesson.',
    });
    assert.equal(res.written, false, 'duplicate not written');
    assert.equal(res.conflictingId, 'spawn-kill-group', 'refusal names the existing node');
    assert.equal(cache.get().length, before, 'index did not grow on a refused write');
  });

  test('clean write round-trips and the index grows', () => {
    const cache = new IndexCache(vault());
    const before = cache.get().length;
    const res = writeTool(cache, cache.vault, {
      id: 'launchd-tick-cadence',
      kind: 'reference',
      title: 'launchd tick cadence',
      summary: 'the host plist ticks every five minutes; activation needs a launchctl reload',
      loc: ['stack.nyx.desktop'],
      body: 'WHAT: launchd fires the dispatcher.\nGOTCHAS: reload required after edits.',
    });
    assert.equal(res.written, true, 'clean ADD persisted');
    assert.equal(res.action, 'ADD');
    assert.equal(cache.get().length, before + 1, 'index grew by one');
    const loaded = loadTool(cache, ['launchd-tick-cadence']);
    assert.equal(loaded.nodes.length, 1, 'written node is loadable');
    assert.match(loaded.nodes[0]!.body, /launchd fires/);
  });

  test('validate reports exactly the corrupted file and a count mismatch', () => {
    const cache = new IndexCache(vault());
    const result = validateTool(cache);
    assert.equal(result.ok, false, 'corruption present → not ok');
    assert.equal(result.parseFailures.length, 1, 'exactly one bad file');
    assert.equal(result.parseFailures[0]!.file, 'corrupt-node.md');
    assert.equal(result.fileCount - result.indexCount, 1, 'index is exactly one short of the file count');
  });

  test('load returns ordered, sanitized bodies (FIX/CHECK before ANTI)', () => {
    const cache = new IndexCache(vault());
    const { nodes } = loadTool(cache, ['spawn-kill-group']);
    assert.equal(nodes.length, 1);
    const body = nodes[0]!.body;
    assert.ok(body.indexOf('FIX:') < body.indexOf('ANTI:'), 'FIX rendered before ANTI');
    assert.ok(body.indexOf('CHECK:') < body.indexOf('ANTI:'), 'CHECK rendered before ANTI');
  });

  test('load caps at 10 ids', () => {
    const cache = new IndexCache(vault());
    const ids = Array.from({ length: 15 }, (_, i) => `id-${i}`);
    const { missing } = loadTool(cache, ids);
    assert.ok(missing.length <= 10, 'never resolves more than 10 ids');
  });

  test('survey returns ranked stubs without bodies', () => {
    const cache = new IndexCache(vault());
    const stubs = surveyTool(cache, { scope: 'stack.nyx.dispatch', audience: 'coder' });
    assert.ok(stubs.length >= 1);
    assert.ok(stubs.every((s) => !('body' in s)), 'no bodies leaked into survey');
    assert.ok(stubs.some((s) => s.id === 'spawn-kill-group'));
  });

  test('neighbors traverses typed edges and resolves targets', () => {
    const cache = new IndexCache(vault());
    const { neighbors } = neighborsTool(cache, 'spawn-kill-group');
    const rel = neighbors.find((n) => n.id === 'secret-redaction');
    assert.ok(rel, 'relates edge traversed');
    assert.equal(rel!.rel, 'relates');
    assert.ok(rel!.resolved, 'edge target resolved to a stub');
  });
});
