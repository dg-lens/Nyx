import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

import { config } from '../src/config.js';
import { appDestination, appSlug, isGreenfield, isGreenfieldVariant, isValidRepoTag, targetMode } from '../src/pipeline/target.js';

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

describe('isValidRepoTag (C2 command-injection guard)', () => {
  test('owner/name + greenfield keywords are valid', () => {
    for (const ok of ['org/repo', 'lens-cx/employee-portal', 'a.b-c/d_e.f', 'local', 'GREENFIELD']) {
      assert.equal(isValidRepoTag(ok), true, ok);
    }
  });

  test('shell-metacharacter / malformed repo strings are rejected', () => {
    const evil = [
      'a";echo INJECTED > /tmp/marker;"b',
      'org/repo";rm -rf ~;"',
      'org/repo$(touch /tmp/x)',
      'org/repo`id`',
      'org/repo name',
      '--upload-pack=touch /tmp/x',
      'org/repo\n[type: code]',
      'https://github.com/org/repo',
      'employee-portal',
    ];
    for (const e of evil) assert.equal(isValidRepoTag(e), false, e);
  });
});

describe('app:<slug> sentinel', () => {
  test('app:<slug> with a strict [a-z0-9-]+ slug → app', () => {
    for (const ok of ['app:noted', 'app:my-app', 'app:a', 'app:a2-b3', '  app:padded  ']) {
      assert.equal(targetMode(ok), 'app', ok);
      assert.equal(isValidRepoTag(ok.trim()), true, ok);
    }
  });

  test('empty / uppercase / path-bearing / metachar slugs → invalid', () => {
    const bad = [
      'app:',
      'app:UPPER',
      'app:a/b',
      'APP:lower',
      'app:a_b',
      'app:a.b',
      'app:a b',
      'app:..',
      'app:~root',
      'app:a;rm -rf ~',
      'app:a$(touch /tmp/x)',
      'app:a`id`',
      'app:slug\n[type: code]',
    ];
    for (const e of bad) {
      assert.equal(targetMode(e), 'invalid', e);
      assert.equal(isValidRepoTag(e), false, e);
    }
  });

  test('app:a/b classifies invalid, never leaks into external (":" is outside OWNER_NAME)', () => {
    assert.equal(targetMode('app:a/b'), 'invalid');
    assert.notEqual(targetMode('app:a/b'), 'external');
  });

  test('appSlug extracts the slug for app mode only', () => {
    assert.equal(appSlug('app:my-app'), 'my-app');
    assert.equal(appSlug(' app:noted '), 'noted');
    assert.equal(appSlug('app:UPPER'), null);
    assert.equal(appSlug('local'), null);
    assert.equal(appSlug('org/repo'), null);
    assert.equal(appSlug(null), null);
  });

  test('appDestination resolves appsDir/<slug> verbatim; throws on non-app repos', () => {
    assert.equal(appDestination('app:my-app'), resolve(config.appsDir, 'my-app'));
    assert.throws(() => appDestination('local'), /non-app repo/);
    assert.throws(() => appDestination(null), /non-app repo/);
  });

  test('isGreenfieldVariant covers greenfield + app; isGreenfield stays greenfield-only', () => {
    assert.equal(isGreenfieldVariant('local'), true);
    assert.equal(isGreenfieldVariant('app:noted'), true);
    assert.equal(isGreenfieldVariant('org/repo'), false);
    assert.equal(isGreenfieldVariant(null), false);
    assert.equal(isGreenfieldVariant('employee-portal'), false);
    assert.equal(isGreenfield('app:noted'), false, 'app mode is NOT plain greenfield');
  });

  test('existing modes are untouched by the new sentinel', () => {
    assert.equal(targetMode('org/repo'), 'external');
    assert.equal(targetMode(''), 'self');
    assert.equal(targetMode('local'), 'greenfield');
    assert.equal(targetMode('employee-portal'), 'invalid');
  });
});
