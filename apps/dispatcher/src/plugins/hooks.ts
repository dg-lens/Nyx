/**
 * Hook plane runtime — the registry plugins use to affect Core. Built-in
 * hook-emit points live in Core; plugins may also define their own. Every
 * handler runs isolated (try/catch) so a plugin error never breaks a tick.
 */
import type { HookKind, HookHandler, HookRegistry } from './sdk.js';

interface HookEntry {
  kind: HookKind;
  handlers: { plugin: string; fn: HookHandler }[];
}

const registry = new Map<string, HookEntry>();
let onError: (hook: string, plugin: string, err: unknown) => void = () => {};

export function _setHookErrorHandler(fn: (hook: string, plugin: string, err: unknown) => void): void {
  onError = fn;
}

export function _resetHooks(): void {
  registry.clear();
}

export function defineHook(name: string, kind: HookKind): void {
  if (!registry.has(name)) registry.set(name, { kind, handlers: [] });
}

export function onHook(name: string, fn: HookHandler, plugin = 'core'): void {
  let entry = registry.get(name);
  if (!entry) {
    entry = { kind: 'observe', handlers: [] };
    registry.set(name, entry);
  }
  entry.handlers.push({ plugin, fn });
}

export async function emitHook<T>(name: string, ctx: T): Promise<T> {
  const entry = registry.get(name);
  if (!entry || entry.handlers.length === 0) return ctx;
  if (entry.kind === 'filter') {
    let cur: T = ctx;
    for (const h of entry.handlers) {
      try {
        const result = await h.fn(cur);
        if (result !== undefined) cur = result as T;
      } catch (err) {
        onError(name, h.plugin, err);
      }
    }
    return cur;
  }
  for (const h of entry.handlers) {
    try {
      await h.fn(ctx);
    } catch (err) {
      onError(name, h.plugin, err);
    }
  }
  return ctx;
}

export function hookRegistryFor(plugin: string): HookRegistry {
  return {
    define: (n, k) => defineHook(n, k),
    on: (n, fn) => onHook(n, fn as HookHandler, plugin),
    emit: (n, c) => emitHook(n, c),
  };
}

/** Core's public hook surface — see docs/plugin-architecture.md. */
export function defineBuiltinHooks(): void {
  defineHook('tick.before', 'observe');
  defineHook('tick.after', 'observe');
  defineHook('task.beforeSpawn', 'observe');
  defineHook('task.promptBuild', 'filter');
  defineHook('task.afterComplete', 'observe');
  defineHook('audit.append', 'observe');
  defineHook('pipeline.gateReached', 'observe');
  defineHook('merge.before', 'gate');
  defineHook('finalize.deployRequired', 'observe');
}
