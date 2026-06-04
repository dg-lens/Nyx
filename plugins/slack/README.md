# slack (Nyx plugin — approved / stock)

Bidirectional Slack control. **Outbound** (tick runtime): on `pipeline.gateReached` it posts the gate brief with Approve/Revise · Proceed/Fix buttons. **Inbound** (host runtime): a Socket Mode source turns a button click into a `pipeline_decision` action signal → `pending_actions` → the next tick applies it (`nyx pipeline go && nyx tick`, from Slack).

`runtime: both` — it loads in the per-tick dispatcher (outbound) and the persistent host (inbound), branching on `ctx.runtime`.

## Activation (your part)

1. In your Slack app: enable **Socket Mode**, add an **app-level token** (`xapp-…`) with `connections:write`, the bot scopes `chat:write`, and **Interactivity** enabled.
2. Set in `Data/.env`: `SLACK_BOT_TOKEN=xoxb-…`, `SLACK_APP_TOKEN=xapp-…`, `SLACK_CHANNEL=C…`.
3. Wire the live socket where `index.js` says *"Socket Mode would connect here"*: `npm i @slack/socket-mode`, open `SocketModeClient`, and on a button interaction parse `value` `{runId, decision}` then `emit({ source: 'slack', kind: 'action', payload: { action: 'pipeline_decision', params: { runId, decision } } })`.

Without tokens it runs as a **mock** — outbound logs the post, inbound is idle — so the rails are testable before you connect Slack.
