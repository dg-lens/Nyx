/**
 * Nyx plugin host — a long-lived process that loads `host`/`both`-runtime
 * plugins and holds their connections (e.g. Slack Socket Mode) open, routing
 * inbound action-intent signals into the pending_actions control surface the
 * per-tick dispatcher drains. Run under launchd with KeepAlive. It never writes
 * the audit chain (that stays single-writer in the tick dispatcher).
 */
import { config } from '../config.js';
import { makePluginContext } from '../plugins/context.js';
import { defineBuiltinHooks, _setHookErrorHandler } from '../plugins/hooks.js';
import { _setIoErrorHandler, _setIoRoute } from '../plugins/io.js';
import { loadPlugins } from '../plugins/loader.js';
import { enqueueAction, type ActionKind } from '../control/db.js';

async function main(): Promise<void> {
  defineBuiltinHooks();
  _setHookErrorHandler((hook, plugin, err) =>
    console.error(`[nyx-host] hook ${hook} (${plugin}):`, (err as Error).message),
  );
  _setIoErrorHandler((where, err) => console.error(`[nyx-host] io ${where}:`, (err as Error).message));
  _setIoRoute((signal) => {
    if (signal.kind === 'action') {
      const p = signal.payload as { action: ActionKind; params?: Record<string, unknown> };
      const id = enqueueAction(p.action, p.params ?? {}, signal.source, Date.now());
      console.log(`[nyx-host] action #${id} from ${signal.source}: ${p.action}`);
    }
  });

  const ev = {
    loaded: (name: string) => console.log(`[nyx-host] loaded ${name}`),
    skipped: () => {},
  };
  const stock = await loadPlugins(config.stockPluginsDir, makePluginContext, ev, 'host');
  const local = await loadPlugins(config.pluginsDir, makePluginContext, ev, 'host');
  const total = stock.length + local.length;

  if (total === 0) {
    console.log('[nyx-host] no host-runtime plugins; nothing to hold.');
    return;
  }
  console.log(`[nyx-host] ${total} persistent plugin(s) loaded; holding connections.`);
  setInterval(() => {}, 1 << 30);
}

main().catch((err: unknown) => {
  console.error('[nyx-host] fatal:', (err as Error).stack ?? (err as Error).message);
  process.exit(1);
});
