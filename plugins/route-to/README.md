# route-to (Nyx plugin — approved / stock)

Cross-surface file delivery, ported from Iris's `route-to` CLI. Reads a surface registry
and registers **one `io.sink` per surface**. A signal sent to a surface sink delivers the
referenced artifact to that surface's inbox over the surface's transport.

`runtime: both` — sinks register only in the **host** runtime (the long-lived process that
holds the io plane), branching on `ctx.runtime`; the per-tick dispatcher is a no-op.

## Transports (by surface `kind`)

| kind | delivery |
|---|---|
| `ssh-local` | local `cp` into `inbox` + `/usr/bin/open [-a <open_app>]` — no network |
| `ssh` | `mkdir -p` remote inbox → `scp` the file → remote `open [-a <open_app>]` via the `address` `~/.ssh/config` alias |
| `icloud` | `cp` into the iCloud Drive `inbox`; sync propagates to signed-in devices |
| `telegram` | `sendDocument` multipart upload to the bot's chat |

Every transport is **isolated and best-effort**: a failed delivery logs via `ctx.log` and
**never throws** — one dead surface cannot break the tick or a sibling sink. Tokens and
addresses are never logged.

## Configuration (your part)

`surfaces.json` is **instance config** — it lives at `$NYX_DATA_DIR/route-to/surfaces.json`
and is **not** committed to Core. Copy [`surfaces.example.json`](surfaces.example.json) there
and edit it; the schema is documented in that file's `_doc`. Each top-level key under
`surfaces` becomes a sink name.

For the `telegram` kind (and any surface with `notify: true`), set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` in `Data/.env`. Without them the telegram path logs and no-ops; the other
kinds need no env. With no registry file (or zero valid surfaces) the plugin registers nothing
and logs a hint.

## Sending to a surface

Emit a signal to the surface's sink with the artifact path in the payload:

```js
ctx.io.send('mba', { source: 'pipeline', kind: 'route', payload: { path: '/abs/path/to/doc.md' } });
```

`payload.path` (or `payload.file`) must be an existing absolute path; a missing path is a
logged no-op.
