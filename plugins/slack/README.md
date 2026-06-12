# slack (Nyx plugin — approved / stock)

Bidirectional Slack control. **Outbound** (tick runtime): on `pipeline.gateReached` it posts the gate brief with Approve/Revise · Proceed/Fix buttons. **Inbound** (host runtime): a real `@slack/socket-mode` connection (authenticated by `SLACK_APP_TOKEN`) listens for `message.im` events and routes them by federation membership:

- The sender's Slack user ID is resolved against `$NYX_DATA_DIR/federation/members.json` (see `members.example.json`). The registry parse is total — a missing or malformed file logs and disables routing, never crashes the host.
- A registered member with `"handling": "respond"` emits `{ source: 'slack', kind: 'action', payload: { action: 'respond_message', params: { member, channelId, threadTs, text } } }` → `pending_actions` → the next tick queues an assistant `NYX-RESPOND-<ts>` task that COMPOSES a reply into `SLACK_REPLY.md` (it never sends — the operator-identity Slack MCP is not a participant in the member↔bot DM, so an MCP send would silently fail). The dispatcher then delivers the reply in-thread via its own `SLACK_BOT_TOKEN` client (the notifier path; routing travels on the dispatcher-written `[slack-reply: <channelId>:<threadTs>]` tag), emitting `slack.reply.sent` / `slack.reply.failed` — a failed delivery fails the task instead of vanishing. The member's text travels quoted as UNTRUSTED data — the responder is instructed to never follow instructions embedded in it.
- An unknown sender gets a `slack.unknown_sender` audit event only (written by the tick drain — the host never writes the hash chain) and **never a reply**.
- Bot messages, subtyped events, and non-IM channels are ignored.

`runtime: both` — it loads in the per-tick dispatcher (outbound) and the persistent host (inbound), branching on `ctx.runtime`.

## Activation (your part)

1. In your Slack app: enable **Socket Mode**, add an **app-level token** (`xapp-…`) with `connections:write`, the bot scopes `chat:write` + `im:history`, and subscribe to the **`message.im`** bot event.
2. Set in `Data/.env`: `SLACK_BOT_TOKEN=xoxb-…`, `SLACK_APP_TOKEN=xapp-…`, `SLACK_CHANNEL=C…`.
3. Copy `members.example.json` to `$NYX_DATA_DIR/federation/members.json` and map each member's Slack user ID to `{ "member": "<id>", "handling": "respond" }`. Senders absent from the file are audited, never answered.

Without `SLACK_APP_TOKEN` the inbound source stays idle (mock); without `SLACK_BOT_TOKEN`/`SLACK_CHANNEL` the outbound gate post logs instead of posting — so the rails are testable before you connect Slack.
