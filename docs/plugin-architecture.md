# Nyx Plugin Architecture

The contract every plugin — first-party or third-party — builds against. Stable on purpose: plugins depend on this, never on Core internals.

## Governance & boundary

- **`Core/`** is maintained solely by the `dg-lens/Nyx` owner. `nyx update` hard-resets Core to `origin/main`, so any local Core edit is throwaway by design.
- **`Plugins/`** is a sibling of `Core/`, outside its git. It **persists across Core updates**; anyone may author plugins there.
- A plugin depends **only on the plugin SDK** (the types + `definePlugin` below) and the runtime `ctx` injected at load — never on Core internals. A plugin that touches only the SDK survives any Core update.
- The SDK is the stable, versioned public surface. Today it lives at `apps/dispatcher/src/plugins/sdk.ts`; it extracts to a standalone versioned `@nyx/plugin-sdk` package when external-plugin packaging + resolution ships. `SDK_VERSION` is the contract major.
- A plugin is **`approved`** (blessed by the owner — may ship as stock support, published for every instance) or **`local`** (runs on the author's instance only, never pushed to the remote). Only the owner pushes to the remote, so only the owner mints `approved` plugins.
- Need a Core capability that doesn't exist (a new hook-emit point)? That's a PR to the owner, who decides whether it becomes stock. Forking Core locally works but dies on the next `nyx update`.

## Plugin shape

`Plugins/<name>/` contains `package.json`, `nyx-plugin.json` (the manifest), and a built `dist/index.js` whose default export is a `NyxPlugin`:

```ts
import { definePlugin } from '@nyx/plugin-sdk';

export default definePlugin({
  async setup(ctx) {
    // hook plane — affect Core
    ctx.hooks.on('task.promptBuild', (c) => ({ ...c, prompt: c.prompt + '\n## extra context' }));
    // i/o plane — move data across the boundary
    ctx.io.sink('slack', async (sig) => { /* post sig.payload to Slack */ });
    ctx.io.source('slack', (emit) => { /* on a socket frame: */ /* emit({ source:'slack', kind:'action', payload }) */ });
  },
});
```

The loader injects `ctx` (the live registries) at runtime. The plugin imports the SDK only for **types** — so a plugin never has to resolve Core's modules.

## Two planes

### I/O plane (data piping)

Pure transport + normalization across the external boundary. It moves and shapes data; it never runs Core logic.

- Canonical unit: `Signal { source, kind, payload, meta? }` — raw external data, normalized into "information".
- `ctx.io.source(name, start)` — **ingest**: an external event → a normalized `Signal`, routed inward. Action-intent signals land in `pending_actions` (the control surface).
- `ctx.io.sink(name, handler)` — **emit**: a `Signal` → external (post Slack blocks, write a file, call an API).

### Hook plane (effects / extension)

Where a plugin **affects Core**, via a runtime registry — not a fixed compile-time interface, which is what lets plugins add their own hooks.

- `ctx.hooks.define(name, kind)` · `ctx.hooks.on(name, handler)` · `ctx.hooks.emit(name, ctx)`
- Kinds:
  - **`observe`** — fire-and-forget; return value ignored.
  - **`filter`** — handlers run in a chain; each may return a transformed ctx (e.g. `task.promptBuild`).
  - **`gate`** — may veto (reserved; observe semantics today).
- **Extensible:** a plugin may `define` and `emit` a new hook; other plugins `on` it. New extension points need no Core release.
- **Isolation:** every handler runs in try/catch — a plugin error never breaks a tick. (Errors audit `plugin.hook.error`.)

## Built-in hook-emit catalog (Core's public surface)

Every point Core ships an `emit` at is API the owner commits to maintain. Breadth here = what a local author can do without forking Core.

| Hook | Kind | Fires |
|---|---|---|
| `tick.before` / `tick.after` | observe | around each dispatch tick |
| `task.beforeSpawn` | observe | before a task's `claude -p` |
| `task.promptBuild` | filter | building the agent prompt (transform it) |
| `task.afterComplete` | observe | a task finished |
| `audit.append` | observe | every audit event |
| `pipeline.gateReached` | observe | a pipeline run hits a gate |
| `merge.before` | gate | before a self-task merge |
| `finalize.deployRequired` | observe | a deploy-required event |

## Manifest (`nyx-plugin.json`)

```json
{
  "name": "slack",
  "version": "0.1.0",
  "sdkVersion": "1",
  "tier": "approved",
  "coreVersion": ">=1.1.0",
  "capabilities": {
    "hooksAttached": [{ "name": "pipeline.gateReached", "kind": "observe" }],
    "hooksDefined": [],
    "ioSources": ["slack"],
    "ioSinks": ["slack"],
    "env": ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    "mcpServers": []
  }
}
```

The owner approves a plugin's manifest at install (the same allowlist ethos Nyx uses for spawned-agent tools). `sdkVersion` pins the contract; the (deferred) auto-update agent re-fits a plugin to a new SDK by editing the plugin in `Plugins/` — never Core.

## Loader

`loadPlugins(pluginsDir, ctx)` runs at dispatcher startup: scan `Plugins/*`, read each manifest, check SDK-major compatibility, dynamic-import `dist/index.js`, call `setup(ctx)` in try/catch, and audit `plugin.loaded` / `plugin.skipped`. An invalid, incompatible, or unbuilt plugin is **skipped, never fatal**.

## Control surface (step 2)

Inbound action-intent `Signal`s — from the Slack source, the desktop app, or the CLI — land in a local `pending_actions` table in `Data/`. A Core executor drains it each tick (`queue_task`, `resume_task`, `pipeline_decision`, `force_tick`). It is the local, SQLite version of the extracted `remote-actions` pattern, so a Slack "Approve" tap becomes "write `pipeline_decision: go` + kick a tick" — `nyx pipeline go && nyx tick`, driven from Slack.
