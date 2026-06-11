import { strict as assert } from 'node:assert';
import { describe, test, afterEach } from 'node:test';

import { permissionArgs, buildSpawnInvocation, buildAgentEnv, buildPrompt } from '../src/task-runner.js';
import { _resetCache } from '../src/mcp-discovery.js';
import { REGISTRY } from '@nyx/assistant';
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

describe('buildAgentEnv (H2 GitHub-PAT leak guard)', () => {
  test('strips GITHUB_TOKEN and GH_TOKEN from the spawned agent env', () => {
    const saved = { gh: process.env['GITHUB_TOKEN'], ghAlt: process.env['GH_TOKEN'] };
    try {
      process.env['GITHUB_TOKEN'] = 'ghp_secret_write_pat';
      process.env['GH_TOKEN'] = 'gho_secret';
      const env = buildAgentEnv({});
      assert.equal(env['GITHUB_TOKEN'], undefined, 'GITHUB_TOKEN stripped');
      assert.equal(env['GH_TOKEN'], undefined, 'GH_TOKEN stripped');
      // Non-secret inherited env (e.g. PATH) is preserved — we strip creds, not all env.
      assert.equal(env['PATH'], process.env['PATH']);
    } finally {
      if (saved.gh === undefined) delete process.env['GITHUB_TOKEN']; else process.env['GITHUB_TOKEN'] = saved.gh;
      if (saved.ghAlt === undefined) delete process.env['GH_TOKEN']; else process.env['GH_TOKEN'] = saved.ghAlt;
    }
  });

  test('preserves Bitwarden extraEnv (BWS_ACCESS_TOKEN passes through)', () => {
    const env = buildAgentEnv({ BWS_ACCESS_TOKEN: 'bws-token' });
    assert.equal(env['BWS_ACCESS_TOKEN'], 'bws-token');
  });
});

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

describe('buildPrompt template resolution', () => {
  test('explicit task.template wins over the id-prefix auto-match', () => {
    // id auto-matches MORNING-BRIEF, but the explicit template overrides to the
    // competitor-brief builder — the produced prompt is the competitor one.
    const t = task('assistant', { id: 'MORNING-BRIEF', description: 'desc', template: 'BRIEF-COMPETITOR' });
    const got = buildPrompt(t);
    assert.equal(got, REGISTRY['BRIEF-COMPETITOR']!('desc'));
    assert.ok(got.includes('Competitor Brief'));
    assert.notEqual(got, REGISTRY['MORNING-BRIEF']!('desc'));
  });

  test('no template tag falls back to exactly the id auto-match (unchanged)', () => {
    const t = task('assistant', { id: 'MORNING-BRIEF-DAILY', description: 'desc' });
    const got = buildPrompt(t);
    // Prefix match resolves MORNING-BRIEF-DAILY -> MORNING-BRIEF builder.
    assert.equal(got, REGISTRY['MORNING-BRIEF']!('desc'));
  });

  test('explicit template resolves even when the id matches no family', () => {
    const t = task('assistant', { id: 'AD-HOC-123', description: 'desc', template: 'INBOX-TRIAGE' });
    const got = buildPrompt(t);
    assert.equal(got, REGISTRY['INBOX-TRIAGE']!('desc'));
  });
});
