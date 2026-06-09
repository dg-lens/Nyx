import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { classOf, ISO_TYPES } from '../src/concurrency.js';
import type { TaskType } from '../src/types.js';

describe('classOf — the two-class split', () => {
  test('code + pipeline are GIT-class (single-flight, touch the shared repo/push)', () => {
    assert.equal(classOf('code'), 'git');
    assert.equal(classOf('pipeline'), 'git');
  });

  test('analysis + assistant + content are ISO-class (concurrent, output-isolated)', () => {
    assert.equal(classOf('analysis'), 'iso');
    assert.equal(classOf('assistant'), 'iso');
    assert.equal(classOf('content'), 'iso');
  });

  test('ISO_TYPES is exactly the non-GIT set', () => {
    assert.deepEqual([...ISO_TYPES].sort(), ['analysis', 'assistant', 'content']);
    for (const t of ISO_TYPES) assert.equal(classOf(t), 'iso');
  });

  test('every TaskType maps to exactly one class (no gaps)', () => {
    const all: TaskType[] = ['code', 'content', 'analysis', 'assistant', 'pipeline'];
    for (const t of all) {
      const c = classOf(t);
      assert.ok(c === 'git' || c === 'iso', `${t} should map to git|iso, got ${c}`);
    }
  });
});
