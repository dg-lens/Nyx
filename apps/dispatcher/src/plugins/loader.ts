/**
 * Plugin loader — scans `Plugins/*`, validates each manifest, dynamic-imports
 * the built entry, and calls `setup(ctx)`. Invalid/incompatible/unbuilt
 * plugins are skipped, never fatal. See docs/plugin-architecture.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NyxPlugin, PluginContext, PluginManifest } from './sdk.js';
import { SDK_VERSION } from './sdk.js';
import { config } from '../config.js';

/** Core's running version, compared against a plugin manifest's `coreVersion` range. */
export const CORE_VERSION = '0.3.0';

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Minimal semver range check: supports a single comparator
 * (`>=`, `>`, `<=`, `<`, `=`) plus bare versions and `*`. A range we cannot
 * parse returns `true` (fail-open) so an unknown format never blocks a load.
 */
function satisfiesCoreVersion(range: string, core: string): boolean {
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;
  const coreV = parseSemver(core);
  if (!coreV) return true;
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed);
  if (!m) return true;
  const op = m[1] ?? '=';
  const target = parseSemver(m[2] ?? '');
  if (!target) return true;
  const c = cmpSemver(coreV, target);
  switch (op) {
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '=': return c === 0;
    default: return true;
  }
}

export interface LoadedPlugin {
  name: string;
  manifest: PluginManifest;
}

export interface LoaderEvents {
  loaded: (name: string, manifest: PluginManifest) => void;
  skipped: (name: string, reason: string) => void;
}

export async function loadPlugins(
  pluginsDir: string,
  makeCtx: (name: string, runtime: 'tick' | 'host') => PluginContext,
  ev: LoaderEvents,
  runtime: 'tick' | 'host' = 'tick',
): Promise<LoadedPlugin[]> {
  const loaded: LoadedPlugin[] = [];
  if (!existsSync(pluginsDir)) return loaded;

  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    return loaded;
  }

  for (const dirName of entries) {
    const dir = resolve(pluginsDir, dirName);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      ev.skipped(dirName, 'unreadable entry (dangling symlink or permission denied)');
      continue;
    }

    const manifestPath = resolve(dir, 'nyx-plugin.json');
    if (!existsSync(manifestPath)) {
      ev.skipped(dirName, 'no nyx-plugin.json');
      continue;
    }

    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest;
    } catch {
      ev.skipped(dirName, 'malformed manifest');
      continue;
    }

    if (!manifest.name || !manifest.sdkVersion) {
      ev.skipped(dirName, 'manifest missing name or sdkVersion');
      continue;
    }
    if (manifest.sdkVersion.split('.')[0] !== SDK_VERSION) {
      ev.skipped(manifest.name, `sdkVersion ${manifest.sdkVersion} incompatible with core SDK ${SDK_VERSION}`);
      continue;
    }
    if (manifest.coreVersion && !satisfiesCoreVersion(manifest.coreVersion, CORE_VERSION)) {
      ev.skipped(manifest.name, `coreVersion ${manifest.coreVersion} incompatible with core ${CORE_VERSION}`);
      continue;
    }
    if (config.settings.plugins.disabled.includes(manifest.name)) {
      ev.skipped(manifest.name, 'disabled in settings');
      continue;
    }

    const pluginRuntime = manifest.runtime ?? 'tick';
    if (pluginRuntime !== runtime && pluginRuntime !== 'both') continue;

    const entry = ['dist/index.js', 'index.js'].map((e) => resolve(dir, e)).find((p) => existsSync(p));
    if (!entry) {
      ev.skipped(manifest.name, 'no dist/index.js or index.js entry');
      continue;
    }

    try {
      const mod = (await import(pathToFileURL(entry).href)) as { default?: NyxPlugin; plugin?: NyxPlugin };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin || typeof plugin.setup !== 'function') {
        ev.skipped(manifest.name, 'entry has no default NyxPlugin export');
        continue;
      }
      await plugin.setup(makeCtx(manifest.name, runtime));
      ev.loaded(manifest.name, manifest);
      loaded.push({ name: manifest.name, manifest });
    } catch (err) {
      ev.skipped(manifest.name, `setup threw: ${(err as Error).message}`);
    }
  }

  return loaded;
}
