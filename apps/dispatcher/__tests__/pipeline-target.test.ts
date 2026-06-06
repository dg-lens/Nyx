import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { isGreenfield, targetMode } from '../src/pipeline/target.js';

describe('targetMode', () => {
  test('owner/name → external', () => {
    assert.equal(targetMode('lens-cx/employee-portal'), 'external');
    assert.equal(targetMode('org/repo'), 'external');
    assert.equal(targetMode('a.b-c/d_e.f'), 'external');
  });

  test('empty / null / whitespace → self', () => {
    assert.equal(targetMode(null), 'self');
    assert.equal(targetMode(undefined), 'self');
    assert.equal(targetMode(''), 'self');
    assert.equal(targetMode('   '), 'self');
  });

  test('greenfield keywords (case-insensitive) → greenfield', () => {
    for (const kw of ['local', 'LOCAL', 'New', 'greenfield', 'scratch']) {
      assert.equal(targetMode(kw), 'greenfield', kw);
      assert.equal(isGreenfield(kw), true, kw);
    }
  });

  test('non-owner/name, non-keyword → invalid (likely a typo, not silently greenfield)', () => {
    assert.equal(targetMode('employee-portal'), 'invalid');
    assert.equal(targetMode('org/repo/extra'), 'invalid');
    assert.equal(targetMode('https://github.com/org/repo'), 'invalid');
    assert.equal(isGreenfield('employee-portal'), false);
  });
});
