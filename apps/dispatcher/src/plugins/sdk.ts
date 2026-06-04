/**
 * The Nyx plugin SDK — the stable public contract a plugin builds against.
 * Plugins import THESE TYPES only; the live registries are injected at load
 * via `ctx`. Extracts to a standalone versioned `@nyx/plugin-sdk` package when
 * external-plugin packaging ships. See docs/plugin-architecture.md.
 */

export interface Signal<P = unknown> {
  source: string;
  kind: string;
  payload: P;
  meta?: Record<string, unknown>;
}

export type HookKind = 'observe' | 'filter' | 'gate';
export type HookHandler<T = unknown> = (ctx: T) => T | void | Promise<T | void>;

export interface HookRegistry {
  define(name: string, kind: HookKind): void;
  on<T = unknown>(name: string, handler: HookHandler<T>): void;
  emit<T = unknown>(name: string, ctx: T): Promise<T>;
}

export type SignalEmitter = (signal: Signal) => void;

export interface IoRegistry {
  source(name: string, start: (emit: SignalEmitter) => void | (() => void)): void;
  sink(name: string, handler: (signal: Signal) => void | Promise<void>): void;
  send(sink: string, signal: Signal): Promise<void>;
}

export interface PluginContext {
  /** Which runtime this plugin instance is loaded in (see PluginRuntime). */
  runtime: 'tick' | 'host';
  hooks: HookRegistry;
  io: IoRegistry;
  config: Record<string, string | undefined>;
  log: (msg: string) => void;
}

export interface NyxPlugin {
  setup(ctx: PluginContext): void | Promise<void>;
}

export type PluginTier = 'approved' | 'local';

/**
 * Where a plugin runs. `tick` (default) loads in the per-tick dispatcher;
 * `host` loads in the long-lived host (for connection-holding sources like
 * Slack Socket Mode); `both` loads in either.
 */
export type PluginRuntime = 'tick' | 'host' | 'both';

export interface PluginManifest {
  name: string;
  version: string;
  sdkVersion: string;
  tier: PluginTier;
  coreVersion?: string;
  runtime?: PluginRuntime;
  capabilities?: {
    hooksAttached?: { name: string; kind: HookKind }[];
    hooksDefined?: string[];
    ioSources?: string[];
    ioSinks?: string[];
    env?: string[];
    mcpServers?: string[];
  };
}

export function definePlugin(plugin: NyxPlugin): NyxPlugin {
  return plugin;
}

/** Contract major. A plugin's manifest `sdkVersion` major must match this. */
export const SDK_VERSION = '1';
