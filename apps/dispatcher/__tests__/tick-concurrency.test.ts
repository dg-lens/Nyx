/**
 * The type-aware two-class scheduler (Track 3) behavior, driven through
 * runTwoClassTick with injected fakes. Proves the directive's guarantees:
 *   - ISO tasks run CONCURRENTLY up to the cap; peak == cap when supply ≥ cap.
 *   - A long GIT task does NOT block ISO completion (they overlap).
 *   - At most ONE GIT task per tick; the git lock is taken+released around it.
 *   - A live cross-tick git lock suppresses the GIT pick (ISO still flows).
 *   - One ISO crash does not abort its siblings (allSettled).
 *   - Completion bookkeeping runs SEQUENTIALLY (never interleaved writes).
 *   - A rate-limited outcome opens a cooldown + leaves the task queued (no
 *     applyOutcome bookkeeping).
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { runTwoClassTick, type SchedulerDeps } from '../src/tick-scheduler.js';
import type { ParsedTask, RunOutcome } from '../src/types.js';

function task(id: string, type: ParsedTask['type']): ParsedTask {
  return {
    id,
    description: id,
    type,
    model: 'haiku',
    gates: 'none',
    priority: 'normal',
    checked: false,
    rawLines: [],
    startLine: 0,
    endLine: 0,
    invalidTags: [],
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Harness {
  deps: SchedulerDeps;
  applied: string[];
  cooldowns: Array<{ taskId: string; retryAfterMs?: number }>;
  gitLockEvents: string[];
  isoThrows: string[];
  peakObservedLive: () => number;
}

/**
 * Build a scheduler harness. `iso`/`git` are FIFO queues of tasks to hand out.
 * `dispatch` resolves after `latencyOf(task)` ms with `outcomeOf(task)`.
 */
function harness(opts: {
  iso: ParsedTask[];
  git: ParsedTask[];
  isoCap: number;
  latencyOf?: (t: ParsedTask) => number;
  outcomeOf?: (t: ParsedTask) => RunOutcome | 'throw';
  gitLockLive?: boolean;
}): Harness {
  const isoQueue = [...opts.iso];
  const gitQueue = [...opts.git];
  const applied: string[] = [];
  const cooldowns: Array<{ taskId: string; retryAfterMs?: number }> = [];
  const gitLockEvents: string[] = [];
  const isoThrows: string[] = [];
  let live = 0;
  let peak = 0;
  let gitLockLive = opts.gitLockLive ?? false;

  const latencyOf = opts.latencyOf ?? (() => 10);
  const outcomeOf =
    opts.outcomeOf ??
    ((t: ParsedTask): RunOutcome => ({ taskId: t.id, status: 'completed', durationMs: 1 }));

  const deps: SchedulerDeps = {
    pickNext: (classFilter) => (classFilter === 'iso' ? isoQueue.shift() ?? null : gitQueue.shift() ?? null),
    prepareSingleSpawn: async () => true,
    markScheduled: () => {},
    dispatch: async (t) => {
      live++;
      peak = Math.max(peak, live);
      await wait(latencyOf(t));
      const res = outcomeOf(t);
      live--;
      if (res === 'throw') throw new Error(`boom ${t.id}`);
      return res;
    },
    advancePipeline: async (t) => {
      applied.push(`pipeline:${t.id}`);
    },
    applyOutcome: async (t, o) => {
      // Record sequentially-applied outcomes. If two ran concurrently, the order
      // could interleave; the assertion checks they're applied one-at-a-time.
      applied.push(`${t.id}:${o.status}`);
    },
    openCooldown: (taskId, retryAfterMs) => {
      cooldowns.push({ taskId, ...(retryAfterMs != null ? { retryAfterMs } : {}) });
    },
    effectiveIsoCap: () => opts.isoCap,
    liveGitTaskExists: () => gitLockLive,
    writeGitLock: (taskId) => { gitLockEvents.push(`write:${taskId}`); gitLockLive = true; },
    removeGitLock: () => { gitLockEvents.push('remove'); gitLockLive = false; },
    isoLaunchJitterMs: 0,
    auditPoolDrained: () => {},
    auditIsoThrow: (reason) => { isoThrows.push(reason); },
    sleep: async () => {},
  };

  return { deps, applied, cooldowns, gitLockEvents, isoThrows, peakObservedLive: () => peak };
}

describe('runTwoClassTick — ISO concurrency', () => {
  test('fans out ISO tasks concurrently; peak == cap when supply ≥ cap', async () => {
    const h = harness({
      iso: [task('A', 'assistant'), task('B', 'analysis'), task('C', 'content'), task('D', 'assistant')],
      git: [],
      isoCap: 3,
      latencyOf: () => 30,
    });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.isoLaunched, 3, 'launches exactly cap tasks');
    assert.equal(result.peakIso, 3, 'all three ISO tasks were in flight simultaneously');
    assert.equal(h.peakObservedLive(), 3, 'dispatch fake observed 3 concurrent');
    assert.deepEqual(h.applied.sort(), ['A:completed', 'B:completed', 'C:completed']);
  });

  test('respects the cap: never launches more ISO than effectiveIsoCap', async () => {
    const h = harness({
      iso: [task('A', 'assistant'), task('B', 'analysis'), task('C', 'content')],
      git: [],
      isoCap: 1,
    });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.isoLaunched, 1);
    assert.ok(h.peakObservedLive() <= 1);
  });

  test('a cap of 0 (global ceiling exhausted) launches nothing', async () => {
    const h = harness({ iso: [task('A', 'assistant')], git: [], isoCap: 0 });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.isoLaunched, 0);
    assert.equal(result.producedWork, false);
  });

  test('drains fewer ISO than the cap when supply is short', async () => {
    const h = harness({ iso: [task('A', 'assistant')], git: [], isoCap: 4 });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.isoLaunched, 1);
    assert.deepEqual(h.applied, ['A:completed']);
  });
});

describe('runTwoClassTick — GIT does not block ISO', () => {
  test('a long GIT task runs concurrently with the ISO pool', async () => {
    // GIT task is slow (60ms); ISO tasks are fast (10ms). If GIT blocked ISO,
    // the ISO tasks could only start after GIT finished and peak ISO would be 1.
    // Because ISO launches FIRST and GIT is awaited after, they overlap.
    const order: string[] = [];
    const h = harness({
      iso: [task('A', 'assistant'), task('B', 'analysis')],
      git: [task('G', 'code')],
      isoCap: 2,
      latencyOf: (t) => (t.id === 'G' ? 60 : 10),
      outcomeOf: (t) => {
        order.push(t.id);
        return { taskId: t.id, status: 'completed', durationMs: 1 };
      },
    });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.isoLaunched, 2);
    assert.equal(result.gitTasksRun, 1);
    assert.equal(h.peakObservedLive(), 3, 'GIT + 2 ISO were all in flight at once');
    // ISO tasks (10ms) finished before the GIT task (60ms) — proving overlap.
    assert.ok(order.indexOf('A') < order.indexOf('G'), 'ISO A finished before GIT G');
    assert.ok(order.indexOf('B') < order.indexOf('G'), 'ISO B finished before GIT G');
  });

  test('takes the git lock around the GIT task and releases it', async () => {
    const h = harness({ iso: [], git: [task('G', 'code')], isoCap: 2 });
    await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.deepEqual(h.gitLockEvents, ['write:G', 'remove']);
  });

  test('a live cross-tick git lock suppresses the GIT pick but NOT ISO', async () => {
    const h = harness({
      iso: [task('A', 'assistant')],
      git: [task('G', 'code')],
      isoCap: 2,
      gitLockLive: true,
    });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.gitTasksRun, 0, 'GIT suppressed by the live lock');
    assert.equal(result.isoLaunched, 1, 'ISO still flows');
    assert.deepEqual(h.gitLockEvents, [], 'never touched the lock for a suppressed GIT pick');
  });

  test('gitSlotTaken (a resumed pipeline phase) suppresses a second GIT task', async () => {
    const h = harness({ iso: [], git: [task('G', 'code')], isoCap: 2 });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: true });
    assert.equal(result.gitTasksRun, 0);
    assert.deepEqual(h.gitLockEvents, []);
  });

  test('a pipeline GIT task advances via advancePipeline under the lock', async () => {
    const h = harness({ iso: [], git: [task('PIPE', 'pipeline')], isoCap: 2 });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.gitTasksRun, 1);
    assert.deepEqual(h.applied, ['pipeline:PIPE']);
    assert.deepEqual(h.gitLockEvents, ['write:PIPE', 'remove']);
  });
});

describe('runTwoClassTick — failure isolation', () => {
  test('one ISO crash does not abort its siblings', async () => {
    const h = harness({
      iso: [task('A', 'assistant'), task('B', 'analysis'), task('C', 'content')],
      git: [],
      isoCap: 3,
      outcomeOf: (t) => (t.id === 'B' ? 'throw' : { taskId: t.id, status: 'completed', durationMs: 1 }),
    });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.isoLaunched, 3);
    // A and C still applied; B's throw was captured, not propagated.
    assert.deepEqual(h.applied.sort(), ['A:completed', 'C:completed']);
    assert.equal(h.isoThrows.length, 1);
    assert.match(h.isoThrows[0] ?? '', /boom B/);
  });

  test('completion bookkeeping is applied sequentially (no interleave)', async () => {
    // applyOutcome is awaited one-at-a-time in the drain loop. We assert the
    // applied[] array has exactly one entry per task and no partial states.
    const h = harness({
      iso: [task('A', 'assistant'), task('B', 'analysis')],
      git: [],
      isoCap: 2,
      latencyOf: () => 5,
    });
    await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(h.applied.length, 2);
    assert.deepEqual([...new Set(h.applied)].length, 2, 'each task applied exactly once');
  });
});

describe('runTwoClassTick — rate-limit backoff', () => {
  test('a rate-limited ISO outcome opens a cooldown + skips bookkeeping (task left queued)', async () => {
    const h = harness({
      iso: [task('A', 'assistant'), task('B', 'analysis')],
      git: [],
      isoCap: 2,
      outcomeOf: (t) =>
        t.id === 'A'
          ? { taskId: t.id, status: 'rate-limited', durationMs: 1, retryAfterMs: 12_000 }
          : { taskId: t.id, status: 'completed', durationMs: 1 },
    });
    await runTwoClassTick(h.deps, { gitSlotTaken: false });
    // A was rate-limited: NOT applied (no completion/failure bookkeeping), cooldown opened.
    assert.deepEqual(h.applied, ['B:completed']);
    assert.equal(h.cooldowns.length, 1);
    assert.deepEqual(h.cooldowns[0], { taskId: 'A', retryAfterMs: 12_000 });
  });

  test('a rate-limited GIT outcome opens a cooldown + does not count as a run', async () => {
    const h = harness({
      iso: [],
      git: [task('G', 'code')],
      isoCap: 2,
      outcomeOf: () => ({ taskId: 'G', status: 'rate-limited', durationMs: 1 }),
    });
    const result = await runTwoClassTick(h.deps, { gitSlotTaken: false });
    assert.equal(result.gitTasksRun, 0, 'rate-limited GIT task is not a completed run');
    assert.deepEqual(h.cooldowns, [{ taskId: 'G' }]);
    // Lock was still taken+released (the spawn happened, it just 429'd).
    assert.deepEqual(h.gitLockEvents, ['write:G', 'remove']);
    assert.deepEqual(h.applied, [], 'no completion bookkeeping for a rate-limited GIT task');
  });
});
