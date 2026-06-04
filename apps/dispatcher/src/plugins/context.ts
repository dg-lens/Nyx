/** Builds the runtime `ctx` injected into each plugin's `setup()`. */
import type { PluginContext } from './sdk.js';
import { hookRegistryFor } from './hooks.js';
import { ioRegistryFor } from './io.js';

export function makePluginContext(name: string, runtime: 'tick' | 'host'): PluginContext {
  return {
    runtime,
    hooks: hookRegistryFor(name),
    io: ioRegistryFor(name),
    config: process.env,
    log: (msg: string) => console.log(`[plugin:${name}] ${msg}`),
  };
}
