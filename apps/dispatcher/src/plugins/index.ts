/**
 * Plugin subsystem entry — defines Core's built-in hooks, wires error +
 * routing, and loads plugins from `config.pluginsDir`. Called once at
 * dispatcher startup.
 */
import { audit } from '../audit.js';
import { config } from '../config.js';
import { makePluginContext } from './context.js';
import { defineBuiltinHooks, _setHookErrorHandler } from './hooks.js';
import { _setIoErrorHandler, _setIoRoute } from './io.js';
import { loadPlugins, type LoadedPlugin } from './loader.js';

export { emitHook } from './hooks.js';
export { sendSignal } from './io.js';

let initialized = false;

export async function initPlugins(): Promise<LoadedPlugin[]> {
  if (initialized) return [];
  initialized = true;

  defineBuiltinHooks();
  _setHookErrorHandler((hook, plugin, err) =>
    audit('plugin.hook.error', 'plugins', { hook, plugin, error: (err as Error).message }),
  );
  _setIoErrorHandler((where, err) =>
    audit('plugin.io.error', 'plugins', { where, error: (err as Error).message }),
  );
  // Step 2 routes inbound action-intent signals into the pending_actions table.
  _setIoRoute(() => {});

  return loadPlugins(config.pluginsDir, makePluginContext, {
    loaded: (name, m) => audit('plugin.loaded', 'plugins', { name, version: m.version, tier: m.tier }),
    skipped: (name, reason) => audit('plugin.skipped', 'plugins', { name, reason }),
  });
}
