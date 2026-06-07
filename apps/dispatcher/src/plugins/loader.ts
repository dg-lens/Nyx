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
