# Nyx — integration primer for Iris

> **Audience: Iris** — the pm2-managed, multi-core `claude -p` swarm running on this
> Mac mini. **Nyx** is a second, co-resident autonomous agent system on the same machine.
> This document is the contract for sharing the box and interoperating. It is written for
> an agent: concrete paths, commands, and hard rules. Read it fully before acting on Nyx.

---

## 1. What Nyx is (and is not)

Nyx is an **autonomous task dispatcher**:
- A launchd daemon (`com.nyx.dispatcher`) wakes on a **5-minute tick**, reads a task queue, and spawns sandboxed `claude -p` subprocesses to execute typed tasks: `code`, `analysis`, `assistant`, `content`, `pipeline`.
- Every action appends to a **hash-chained, single-writer SQLite audit log** — tamper-evident; any out-of-band write breaks the chain and halts Nyx.
- Layout on this machine:
  - **Code (read-only, ships publicly):** `/opt/homebrew/opt/nyx/libexec`
  - **Operator data:** `~/Nyx/Data` — `nyx.md` (queue), `data/nyx.db` (audit + control), `logs/`, `.env`, `settings.json`, `memory/` (the Arachne vault)
  - **Plugins:** `~/Nyx/Plugins`

Nyx is **not** you, and not your controller. You and Nyx are independent peers sharing one machine and one Anthropic account. Neither owns or supervises the other.

---

## 2. Coexistence contract (the rules — read before anything else)

- **Shared Anthropic budget.** You and Nyx draw on the *same* account + rate limit. Do not assume exclusive capacity. Back off on 429/rate-limit responses; assume Nyx may be spending concurrently.
- **Process isolation.** Nyx is configured `concurrencyGuard: own` — it tracks only the `claude` PIDs *it* spawned and ignores yours, so it will not stall because your swarm is busy. **Reciprocate:** never kill, signal, or reap a `claude` process you did not spawn. Do not `pkill claude` or kill by name — you will take down Nyx's in-flight tasks.
- **Never touch Nyx's state.** Specifically:
  - Do **not** write `~/Nyx/Data/data/nyx.db` (single-writer hash-chained audit — an external write breaks verification and halts the dispatcher).
  - Do **not** modify `/opt/homebrew/opt/nyx/libexec` (code; replaced wholesale on update).
  - Do **not** `launchctl load/unload com.nyx.dispatcher` or `com.nyx.host`.
- **Read-only is fine.** You may run `nyx status`, read `~/Nyx/Data/logs/`, and read `~/Nyx/Data/nyx.md`.

---

## 3. How to hand work to Nyx (local seams, available today)

Ordered cleanest-first:

1. **The CLI** (stable public interface):
   - `nyx status` — health, tick cadence, queue + audit state.
   - `nyx queue` — inspect the queue. `nyx slots` — schedule grid.
   - `nyx tick` — force one dispatch now (don't wait for the 5-min boundary).
   - `nyx pipeline list | status <RUN>` — pipeline run state.
2. **The queue file** `~/Nyx/Data/nyx.md` — the durable, file-based handoff. Append a task block under `## Active Tasks`, then let the next tick pick it up. **Write atomically** (write a temp file, `rename` over `nyx.md`) so a tick never reads a half-written queue. Format:
   ```
   - [ ] IRIS-<id> — <one-line description>
         [type: code|analysis|assistant|content|pipeline]
         [repo: org/name]        # for code/analysis/pipeline against a repo
   ```
   Only lines under `## Active Tasks` are parsed; everything else (and fenced code blocks) is ignored.
3. **The control surface** `pending_actions` (in `data/nyx.db`) — the dispatcher drains it each tick (`queue_task`, `resume_task`, `pipeline_decision`, `force_tick`). It lives in the same DB as the audit chain, so **do not write it directly** — use the host-plugin seam (§4) instead, which is the supported producer.

---

## 4. The supported programmatic seam: a Nyx host plugin

Nyx runs a plugin host (`com.nyx.host`, a KeepAlive process) that converts inbound signals into `pending_actions` via `ctx.io.source((emit) => emit({ kind: 'action', payload }))`. The supported way for an external system to feed Nyx programmatically is a **Nyx host plugin that bridges your transport** (a socket / watched file / local HTTP) into that `emit`. This keeps Core untouched and the audit chain single-writer.

- Read **`docs/plugin-architecture.md`** (shipped alongside this file) for the plugin SDK — the `io` plane (`source`/`sink`) and the `hook` plane.
- The stub at **`Plugins/remoteactions/`** is the template to copy.
- Plugins live in `~/Nyx/Plugins` and load on the next host start. They depend only on the SDK, never on Core internals.

---

## 5. The real integration target: the Arachne backbone

The durable, governed way for you and Nyx to collaborate is **Arachne** — a shared hub (Fly app `lens-arachne` + Postgres) that every system talks **through** (hub-and-spoke; never peer-to-peer). Once you are registered as a platform (a per-platform bearer token + scopes, granted by the operator), you can:

- **Shared memory** — `pack` / `search` / `write` nodes. Read the collective lessons + invariants *before* a task; write what you learn *after*. Knowledge compounds across both systems instead of being re-learned. Memory model: `~/Nyx/Data/memory/ARACHNE.md`; the engine reads small markdown+frontmatter nodes scoped by `loc`/`concern`.
- **Coordination plane** (in progress) — send/receive addressed work + status between systems.
- **Gate relay** — relay a pipeline gate to a remote reviewer.

Invariant: Arachne is shared **state + relay**, never an orchestrator — it runs no agents and is never an instance's source of truth (each system keeps its own audit log). See the `arachne-shared-backbone` node in the memory graph for the full plan.

**Registering Iris as an Arachne platform is the recommended long-term integration.** Until the hub is live for you, use the local CLI/queue/host-plugin seams in §3–§4.

---

## 6. First actions

1. `nyx status` — confirm Nyx is up; note the tick cadence and queue path.
2. Read `~/Nyx/Data/memory/ARACHNE.md` (memory model) and `docs/plugin-architecture.md` (the plugin seam).
3. Pick your handoff mechanism: file-based (atomic append to `nyx.md`) for simple cases, a host plugin (§4) for programmatic flow.
4. Encode the §2 coexistence rules into your own scheduler: shared budget + back-off; never touch Nyx state or foreign `claude` PIDs.
5. Ask the operator for an Arachne platform token when the hub is live, then move memory + coordination onto it.

---

## 7. ANTI — do not

- Do not write `data/nyx.db`, edit `libexec`, or `launchctl` the Nyx agents.
- Do not kill `claude` processes you did not spawn (no `pkill claude`).
- Do not assume exclusive Anthropic capacity.
- Do not inject work by any path other than the queue / control / host-plugin seams (§3–§4) — anything else is unaudited and unsupported.
