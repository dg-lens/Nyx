import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, beforeEach } from 'node:test';

import { defineHook, onHook, emitHook, _resetHooks, _setHookErrorHandler } from '../src/plugins/hooks.js';
import { loadPlugins, CORE_VERSION, satisfiesCoreVersion } from '../src/plugins/loader.js';
import { makePluginContext } from '../src/plugins/context.js';

beforeEach(() => {
  _resetHooks();
  _setHookErrorHandler(() => {});
});

describe('hook registry', () => {
  test('observe runs every handler in order', async () => {
    defineHook('t.observe', 'observe');
    const calls: number[] = [];
    onHook('t.observe', () => { calls.push(1); });
    onHook('t.observe', () => { calls.push(2); });
    await emitHook('t.observe', {});
    assert.deepEqual(calls, [1, 2]);
  });

  test('filter chains transforms through handlers', async () => {
    defineHook('t.filter', 'filter');
    onHook('t.filter', (c: { n: number }) => ({ n: c.n + 1 }));
    onHook('t.filter', (c: { n: number }) => ({ n: c.n * 10 }));
    const out = await emitHook('t.filter', { n: 1 });
    assert.deepEqual(out, { n: 20 });
  });

  test('a throwing handler is isolated — chain continues, error reported', async () => {
    defineHook('t.iso', 'filter');
    const errored: string[] = [];
    _setHookErrorHandler((hook) => errored.push(hook));
    onHook('t.iso', () => { throw new Error('boom'); }, 'badplugin');
    onHook('t.iso', (c: { n: number }) => ({ n: c.n + 5 }));
    const out = await emitHook('t.iso', { n: 0 });
    assert.deepEqual(out, { n: 5 });
    assert.deepEqual(errored, ['t.iso']);
  });

  test('emit with no handlers returns ctx unchanged', async () => {
    const out = await emitHook('t.none', { x: 1 });
    assert.deepEqual(out, { x: 1 });
  });

  test('a plugin can define a new hook and another can attach to it', async () => {
    defineHook('plugin.defined', 'observe');
    let hit = false;
    onHook('plugin.defined', () => { hit = true; });
    await emitHook('plugin.defined', {});
    assert.equal(hit, true);
  });
});

describe('loadPlugins', () => {
  function tmpPlugins(): string {
    return mkdtempSync(resolve(tmpdir(), 'nyx-plugins-'));
  }
  function writePlugin(base: string, dir: string, manifest: object, indexJs: string | null): void {
    const d = resolve(base, dir);
    mkdirSync(resolve(d, 'dist'), { recursive: true });
    writeFileSync(resolve(d, 'nyx-plugin.json'), JSON.stringify(manifest));
    writeFileSync(resolve(d, 'package.json'), JSON.stringify({ name: dir, type: 'module' }));
    if (indexJs !== null) writeFileSync(resolve(d, 'dist', 'index.js'), indexJs);
  }

  test('loads a valid plugin and runs its setup', async () => {
    const base = tmpPlugins();
    writePlugin(base, 'good', { name: 'good', version: '0.1.0', sdkVersion: '1', tier: 'local' },
      'export default { setup(ctx) { ctx.hooks.on("custom.x", () => {}); } };');
    const loaded: string[] = [];
    const result = await loadPlugins(base, makePluginContext, {
      loaded: (n) => loaded.push(n),
      skipped: () => {},
    });
    assert.deepEqual(loaded, ['good']);
    assert.equal(result.length, 1);
    assert.equal(result[0].manifest.tier, 'local');
    rmSync(base, { recursive: true, force: true });
  });

  test('skips a plugin with an incompatible sdkVersion major', async () => {
    const base = tmpPlugins();
    writePlugin(base, 'future', { name: 'future', version: '1.0.0', sdkVersion: '2', tier: 'local' },
      'export default { setup() {} };');
    const skipped: string[] = [];
    await loadPlugins(base, makePluginContext, { loaded: () => {}, skipped: (_n, r) => skipped.push(r) });
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /sdkVersion/);
    rmSync(base, { recursive: true, force: true });
  });

  test('skips a directory with no manifest', async () => {
    const base = tmpPlugins();
    mkdirSync(resolve(base, 'nomanifest'), { recursive: true });
    const skipped: string[] = [];
    await loadPlugins(base, makePluginContext, { loaded: () => {}, skipped: (_n, r) => skipped.push(r) });
    assert.deepEqual(skipped, ['no nyx-plugin.json']);
    rmSync(base, { recursive: true, force: true });
  });

  test('skips a plugin whose entry throws in setup', async () => {
    const base = tmpPlugins();
    writePlugin(base, 'boom', { name: 'boom', version: '0.1.0', sdkVersion: '1', tier: 'local' },
      'export default { setup() { throw new Error("nope"); } };');
    const skipped: string[] = [];
    await loadPlugins(base, makePluginContext, { loaded: () => {}, skipped: (_n, r) => skipped.push(r) });
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /setup threw/);
    rmSync(base, { recursive: true, force: true });
  });

  test('runtime filter: a host plugin is skipped under tick, loaded under host', async () => {
    const base = tmpPlugins();
    writePlugin(base, 'sock', { name: 'sock', version: '0.1.0', sdkVersion: '1', tier: 'local', runtime: 'host' },
      'export default { setup() {} };');
    const tickLoaded: string[] = [];
    await loadPlugins(base, makePluginContext, { loaded: (n) => tickLoaded.push(n), skipped: () => {} });
    assert.deepEqual(tickLoaded, []);
    const hostLoaded: string[] = [];
    await loadPlugins(base, makePluginContext, { loaded: (n) => hostLoaded.push(n), skipped: () => {} }, 'host');
    assert.deepEqual(hostLoaded, ['sock']);
    rmSync(base, { recursive: true, force: true });
  });

  test('returns empty when pluginsDir does not exist', async () => {
    const result = await loadPlugins(resolve(tmpdir(), 'nyx-absent-plugins-xyz'), makePluginContext, {
      loaded: () => {},
      skipped: () => {},
    });
    assert.deepEqual(result, []);
  });
});

describe('CORE_VERSION <-> stock-plugin coreVersion gate (P0 regression)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  test('CORE_VERSION tracks the root package.json version (drift guard)', () => {
    const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string };
    assert.equal(
      CORE_VERSION,
      rootPkg.version,
      `CORE_VERSION (${CORE_VERSION}) must equal root package.json (${rootPkg.version}); a stale value silently skips every stock plugin`,
    );
  });

  test('every stock plugin manifest is satisfied by CORE_VERSION (zero version-skips)', () => {
    const pluginsDir = resolve(repoRoot, 'plugins');
    assert.ok(existsSync(pluginsDir), 'stock plugins dir exists');
    const stock = readdirSync(pluginsDir).filter((d) => existsSync(resolve(pluginsDir, d, 'nyx-plugin.json')));
    assert.ok(stock.length >= 3, `expected stock plugins (memory, memory-surface, slack); found: ${stock.join(', ')}`);
    for (const d of stock) {
      const m = JSON.parse(readFileSync(resolve(pluginsDir, d, 'nyx-plugin.json'), 'utf8')) as {
        name: string;
        coreVersion?: string;
      };
      if (!m.coreVersion) continue;
      assert.ok(
        satisfiesCoreVersion(m.coreVersion, CORE_VERSION),
        `stock plugin "${m.name}" declares coreVersion ${m.coreVersion}, which CORE_VERSION ${CORE_VERSION} does NOT satisfy -> it would be skipped (memory injection / Slack dead)`,
      );
    }
  });
});
