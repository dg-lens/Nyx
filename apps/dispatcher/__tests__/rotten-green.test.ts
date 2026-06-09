/**
 * Tests for the rotten-green oracle (P7 deterministic test-quality tier).
 *
 * A green gate proves the suite ran, not that the new tests assert anything.
 * These assert that the three rotten shapes (no-assertions / skip-only /
 * blank-identifier-sink) are detected AND that healthy tests + non-test files
 * are NOT flagged (the flag-for-review policy must not cry wolf on honest work).
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  analyzeTestSource,
  assessRottenGreen,
  isTestFile,
  stripComments,
} from '../src/rotten-green.js';

describe('isTestFile', () => {
  test('recognizes JS/TS test conventions', () => {
    assert.ok(isTestFile('src/foo.test.ts'));
    assert.ok(isTestFile('src/foo.spec.tsx'));
    assert.ok(isTestFile('apps/x/__tests__/foo.ts'));
    assert.ok(isTestFile('tests/foo.js'));
  });
  test('recognizes Python test conventions', () => {
    assert.ok(isTestFile('tests/test_foo.py'));
    assert.ok(isTestFile('foo_test.py'));
  });
  test('does not flag production source', () => {
    assert.equal(isTestFile('src/foo.ts'), false);
    assert.equal(isTestFile('src/index.py'), false);
    assert.equal(isTestFile('README.md'), false);
  });
});

describe('analyzeTestSource — JS', () => {
  test('healthy test with assertions is clean', () => {
    const src = `
      import { test } from 'node:test';
      test('adds', () => { expect(add(1,2)).toBe(3); });
      test('subs', () => { expect(sub(2,1)).toBe(1); });
    `;
    const f = analyzeTestSource('foo.test.ts', src);
    assert.equal(f.reasons.length, 0);
    assert.equal(f.testCount, 2);
    assert.ok(f.assertionCount >= 2);
  });

  test('no-assertions: tests that check nothing', () => {
    const src = `
      test('runs without throwing', () => { doThing(); });
      test('also runs', () => { doOther(); });
    `;
    const f = analyzeTestSource('foo.test.ts', src);
    assert.ok(f.reasons.includes('no-assertions'));
    assert.equal(f.assertionCount, 0);
  });

  test('skip-only: every test skipped', () => {
    const src = `
      test.skip('a', () => { expect(1).toBe(1); });
      it.skip('b', () => { expect(2).toBe(2); });
    `;
    const f = analyzeTestSource('foo.test.ts', src);
    assert.ok(f.reasons.includes('skip-only'));
  });

  test('blank-identifier sink: result discarded into _', () => {
    const src = `
      test('does a thing', () => {
        const _ = computeImportantValue();
        expect(true).toBe(true);
      });
    `;
    const f = analyzeTestSource('foo.test.ts', src);
    assert.ok(f.reasons.includes('blank-identifier-sink'));
  });

  test('assertions only inside a comment do NOT count', () => {
    const src = `
      test('fake', () => {
        // expect(foo()).toBe(bar)
        doThing();
      });
    `;
    const f = analyzeTestSource('foo.test.ts', src);
    assert.ok(f.reasons.includes('no-assertions'));
  });
});

describe('analyzeTestSource — Python', () => {
  test('healthy pytest is clean', () => {
    const src = [
      'def test_add():',
      '    assert add(1, 2) == 3',
      'def test_sub():',
      '    assert sub(2, 1) == 1',
    ].join('\n');
    const f = analyzeTestSource('tests/test_math.py', src);
    assert.equal(f.reasons.length, 0);
    assert.equal(f.testCount, 2);
  });

  test('no-assertions pytest is flagged', () => {
    const src = ['def test_runs():', '    do_thing()', 'def test_more():', '    do_other()'].join('\n');
    const f = analyzeTestSource('tests/test_x.py', src);
    assert.ok(f.reasons.includes('no-assertions'));
  });

  test('skip-only pytest is flagged', () => {
    const src = [
      '@pytest.mark.skip',
      'def test_a():',
      '    assert True',
    ].join('\n');
    const f = analyzeTestSource('tests/test_a.py', src);
    assert.ok(f.reasons.includes('skip-only'));
  });
});

describe('analyzeTestSource — fixtures', () => {
  test('a file with no test declarations is never rotten', () => {
    const src = `export const fixture = { a: 1 }; const _ = helper();`;
    const f = analyzeTestSource('tests/fixtures.ts', src);
    assert.equal(f.reasons.length, 0);
  });
});

describe('stripComments', () => {
  test('removes block, line, and python comments', () => {
    const out = stripComments('a /* x */ b // y\nc # z');
    assert.ok(!out.includes('x'));
    assert.ok(!out.includes('y'));
    assert.ok(!out.includes('z'));
    assert.ok(out.includes('a'));
    assert.ok(out.includes('c'));
  });
});

describe('assessRottenGreen — disk + aggregation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'rotten-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('aggregates only changed test files; ignores prod + absent', () => {
    mkdirSync(resolve(dir, 'tests'), { recursive: true });
    writeFileSync(resolve(dir, 'tests', 'bad.test.ts'), `test('a', () => { doThing(); });`);
    writeFileSync(resolve(dir, 'tests', 'good.test.ts'), `test('a', () => { expect(1).toBe(1); });`);
    writeFileSync(resolve(dir, 'src.ts'), `const _ = foo();`);
    const r = assessRottenGreen(dir, [
      'tests/bad.test.ts',
      'tests/good.test.ts',
      'src.ts',
      'tests/deleted.test.ts',
    ]);
    assert.deepEqual(r.paths, ['tests/bad.test.ts']);
  });

  test('no changed test files → empty', () => {
    const r = assessRottenGreen(dir, ['src/a.ts', 'README.md']);
    assert.deepEqual(r.findings, []);
  });
});
