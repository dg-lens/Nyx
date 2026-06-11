import { strict as assert } from 'node:assert';
import { describe, test, afterEach } from 'node:test';

import { _setAppsDir, config, validateConfig } from '../src/config.js';

afterEach(() => {
  _setAppsDir(null);
});

describe('validateConfig — appsDir overlap guard', () => {
  test('does not throw when appsDir is a distinct path', () => {
    _setAppsDir('/tmp/valid-nyx-apps-dir');
    assert.doesNotThrow(() => validateConfig());
  });

  test('throws when appsDir starts with cloneRootPrefix', () => {
    _setAppsDir(`${config.cloneRootPrefix}my-apps`);
    assert.throws(
      () => validateConfig(),
      (e: unknown) => e instanceof Error && /cloneRootPrefix/.test((e as Error).message),
      'must mention cloneRootPrefix in the error',
    );
  });

  test('does not falsely flag a path that merely contains the cloneRootPrefix substring elsewhere', () => {
    _setAppsDir('/some/nyx-clone-like/apps');
    assert.doesNotThrow(() => validateConfig());
  });

  test('throws when appsDir equals projectsDir', () => {
    _setAppsDir(config.projectsDir);
    assert.throws(
      () => validateConfig(),
      (e: unknown) => e instanceof Error && /projectsDir/.test((e as Error).message),
      'must mention projectsDir in the error',
    );
  });

  test('throws when appsDir is a subdirectory of projectsDir', () => {
    _setAppsDir(`${config.projectsDir}/sub`);
    assert.throws(
      () => validateConfig(),
      (e: unknown) => e instanceof Error && /projectsDir/.test((e as Error).message),
    );
  });

  test('throws when projectsDir is inside appsDir (reverse overlap)', () => {
    // config.projectsDir = resolve(config.dataDir, 'projects'), so setting
    // appsDir = config.dataDir makes projectsDir a subdir of appsDir.
    _setAppsDir(config.dataDir);
    assert.throws(
      () => validateConfig(),
      (e: unknown) => e instanceof Error && /projectsDir/.test((e as Error).message),
    );
  });

  test('does not falsely flag a sibling path (shares a common prefix string but no containment)', () => {
    _setAppsDir(`${config.projectsDir}-extra`);
    assert.doesNotThrow(() => validateConfig());
  });
});
