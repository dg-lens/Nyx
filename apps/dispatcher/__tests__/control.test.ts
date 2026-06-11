import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, beforeEach } from 'node:test';

import { _setAuditDb } from '../src/audit.js';
import {
  _setControlDb,
  enqueueAction,
  listPending,
  getAction,
} from '../src/control/db.js';
import {
  drainPendingActions,
  executeAction,
  insertUnderActiveTasks,
  type ActionDeps,
} from '../src/control/actions.js';
import { isValidRepoTag } from '../src/pipeline/target.js';

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  _setAuditDb(db);
  _setControlDb(db);
});

function stubDeps(log: string[]): ActionDeps {
  return {
    queueTask: (p) => { log.push(`queue:${JSON.stringify(p)}`); return 'queued'; },
    resumeTask: (p) => { log.push(`resume:${String(p.taskId)}`); return `resumed ${String(p.taskId)}`; },
    pipelineDecision: (p) => { log.push(`pipeline:${String(p.decision)}`); return `decided ${String(p.decision)}`; },
  };
}

describe('pending_actions table', () => {
  test('enqueue → listPending → markApplied', () => {
    const id = enqueueAction('force_tick', {}, 'cli', 1000);
    assert.ok(id > 0);
    const pending = listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].action, 'force_tick');
    assert.equal(pending[0].source, 'cli');
    assert.equal(pending[0].status, 'pending');
    assert.deepEqual(pending[0].params, {});
  });

  test('params round-trip as JSON', () => {
    enqueueAction('pipeline_decision', { runId: 'r1', decision: 'go', note: 'lgtm' }, 'slack', 1000);
    assert.deepEqual(listPending()[0].params, { runId: 'r1', decision: 'go', note: 'lgtm' });
  });
});

describe('insertUnderActiveTasks', () => {
  test('inserts under an existing header', () => {
    const out = insertUnderActiveTasks('# Queue\n\n## Active Tasks\n\n## Completed\n', '- [ ] X — do it');
    const lines = out.split('\n');
    const hdr = lines.findIndex((l) => l === '## Active Tasks');
    assert.equal(lines[hdr + 2], '- [ ] X — do it');
  });
  test('creates the header when absent', () => {
    const out = insertUnderActiveTasks('# Queue\n', '- [ ] Y — do it');
    assert.match(out, /## Active Tasks\n\n- \[ \] Y — do it/);
  });
});

describe('executeAction', () => {
  test('dispatches each kind to its dep', () => {
    const log: string[] = [];
    const deps = stubDeps(log);
    executeAction({ id: 1, action: 'queue_task', params: { raw: 'x' }, source: 'cli', status: 'pending', result: null, created_at: 0, applied_at: null }, deps);
    executeAction({ id: 2, action: 'resume_task', params: { taskId: 'T1' }, source: 'cli', status: 'pending', result: null, created_at: 0, applied_at: null }, deps);
    executeAction({ id: 3, action: 'pipeline_decision', params: { decision: 'go' }, source: 'cli', status: 'pending', result: null, created_at: 0, applied_at: null }, deps);
    assert.deepEqual(log, ['queue:{"raw":"x"}', 'resume:T1', 'pipeline:go']);
  });
  test('force_tick is a no-op marker', () => {
    const r = executeAction({ id: 1, action: 'force_tick', params: {}, source: 'slack', status: 'pending', result: null, created_at: 0, applied_at: null }, stubDeps([]));
    assert.equal(r, 'tick requested');
  });
});

describe('drainPendingActions', () => {
  test('applies all pending and marks them applied', () => {
    enqueueAction('pipeline_decision', { runId: 'r1', decision: 'go' }, 'slack', 1000);
    enqueueAction('resume_task', { taskId: 'T9' }, 'desktop', 1001);
    const log: string[] = [];
    const applied = drainPendingActions(stubDeps(log), () => 2000);
    assert.equal(applied, 2);
    assert.equal(listPending().length, 0);
    assert.equal(getAction(1)?.status, 'applied');
    assert.equal(getAction(2)?.status, 'applied');
    assert.deepEqual(log, ['pipeline:go', 'resume:T9']);
  });

  test('a throwing dep marks that action failed, others still apply', () => {
    enqueueAction('queue_task', {}, 'slack', 1000);
    enqueueAction('force_tick', {}, 'slack', 1001);
    const deps: ActionDeps = {
      queueTask: () => { throw new Error('bad task'); },
      resumeTask: () => 'r',
      pipelineDecision: () => 'p',
    };
    const applied = drainPendingActions(deps, () => 2000);
    assert.equal(applied, 1);
    assert.equal(getAction(1)?.status, 'failed');
    assert.match(getAction(1)?.result ?? '', /bad task/);
    assert.equal(getAction(2)?.status, 'applied');
  });

  test('queue_task type casing: Pipeline/PIPELINE accepted for app:<slug> repos after lowercasing', () => {
    // The run-once.ts queueTask boundary lowercases the type string before
    // calling isValidRepoTag so 'Pipeline' / 'PIPELINE' reach isValidRepoTag as
    // 'pipeline', which is the only value it accepts for app:<slug> repos.
    // This test mirrors that boundary: simulate fixed queueTask that lowercases.
    const buildQueueTask = (): ActionDeps['queueTask'] => (p) => {
      const raw = String(p['raw'] ?? '').trim();
      if (raw) return 'queued';
      const type = String(p['type'] ?? 'assistant').trim().toLowerCase();
      const repo = p['repo'] ? String(p['repo']) : null;
      if (repo && !isValidRepoTag(repo, type)) throw new Error(`invalid repo ${repo} for type ${type}`);
      return 'queued';
    };

    const queueTask = buildQueueTask();
    assert.doesNotThrow(() => queueTask({ type: 'pipeline', repo: 'app:my-app', text: 'build it' }), 'lowercase pipeline accepted');
    assert.doesNotThrow(() => queueTask({ type: 'Pipeline', repo: 'app:my-app', text: 'build it' }), 'capitalized Pipeline accepted');
    assert.doesNotThrow(() => queueTask({ type: 'PIPELINE', repo: 'app:my-app', text: 'build it' }), 'all-caps PIPELINE accepted');
    // Non-pipeline types still reject app:<slug>
    assert.throws(() => queueTask({ type: 'Code', repo: 'app:my-app', text: 'build it' }), /invalid repo/, 'non-pipeline type rejects app:<slug>');
  });

  test('pre-phase kinds (decompose_task, compose_template) survive the generic drain untouched', () => {
    enqueueAction('decompose_task', { text: 'build a thing' }, 'desktop', 1000);
    enqueueAction('compose_template', { prompt: 'a daily digest template', kind: 'task' }, 'desktop', 1001);
    enqueueAction('force_tick', {}, 'cli', 1002);
    const applied = drainPendingActions(stubDeps([]), () => 2000);
    assert.equal(applied, 1);
    assert.equal(getAction(1)?.status, 'pending');
    assert.equal(getAction(1)?.result, null);
    assert.equal(getAction(2)?.status, 'pending');
    assert.equal(getAction(2)?.result, null);
    assert.equal(getAction(3)?.status, 'applied');
    assert.deepEqual(listPending().map((a) => a.action), ['decompose_task', 'compose_template']);
  });
});
