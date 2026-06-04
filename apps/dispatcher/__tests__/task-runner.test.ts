import { strict as assert } from 'node:assert';
import { describe, test, afterEach } from 'node:test';

import { permissionArgs, buildSpawnInvocation } from '../src/task-runner.js';
import { _resetCache } from '../src/mcp-discovery.js';
import type { ParsedTask } from '../src/types.js';

const BASE: Omit<ParsedTask, 'type'> = {
  id: 'X',
  description: 'x',
  model: 'haiku',
  gates: 'none',
  priority: 'normal',
  checked: false,
  rawLines: [],
  startLine: 0,
  endLine: 0,
  invalidTags: [],
};

function task(type: ParsedTask['type'], extra: Partial<ParsedTask> = {}): ParsedTask {
  return { ...BASE, type, ...extra };
}

// We never actually exec `claude mcp list` in tests — the discovery module is
// allowed to return [] when it can't run, which is fine for the per-type shape
// tests below.

afterEach(() => _resetCache());

describe('permissionArgs', () => {
  test('assistant gets --allowed-tools with read-only + MCPs', () => {
    const args = permissionArgs(task('assistant'));
    assert.ok(args.includes('--allowed-tools'));
    const list = args[args.indexOf('--allowed-tools') + 1] ?? '';
    assert.match(list, /\bRead\b/);
    assert.match(list, /\bWebFetch\b/);
    // Bash must NOT be in the assistant set.
    assert.doesNotMatch(list, /(^| )Bash($| )/);
  });

  test('content gets --allowed-tools without Bash AND without MCPs', () => {
    const args = permissionArgs(task('content'));
    const list = args[args.indexOf('--allowed-tools') + 1] ?? '';
    assert.match(list, /\bRead\b/);
    assert.doesNotMatch(list, /(^| )Bash($| )/);
    assert.doesNotMatch(list, /mcp__/);
  });

  test('analysis gets --allowed-tools with Bash and MCPs', () => {
    const args = permissionArgs(task('analysis'));
    const list = args[args.indexOf('--allowed-tools') + 1] ?? '';
    assert.match(list, /\bBash\b/);
  });

  test('code has no --allowed-tools flag at all', () => {
    const args = permissionArgs(task('code'));
    assert.equal(args.indexOf('--allowed-tools'), -1);
  });

  test('every task type still passes --permission-mode', () => {
    for (const t of ['assistant', 'content', 'analysis', 'code'] as const) {
      const args = permissionArgs(task(t));
      assert.ok(args.includes('--permission-mode'), `missing for ${t}`);
    }
  });
});

describe('buildSpawnInvocation', () => {
  test('no bw-project tag, no repo → plain claude', () => {
    const t = task('assistant');
    const { command, args, extraEnv } = buildSpawnInvocation(t, ['-p', 'hi']);
    assert.equal(command, 'claude');
    assert.deepEqual(args, ['-p', 'hi']);
    assert.deepEqual(extraEnv, {});
  });

  test('unresolvable bw-project tag → plain claude (no secrets)', () => {
    const t = task('code', { rawLines: ['  [bw-project: nonexistent]'] });
    const { command, extraEnv } = buildSpawnInvocation(t, ['-p', 'hi']);
    assert.equal(command, 'claude');
    assert.equal(Object.keys(extraEnv).length, 0);
  });
});
