# T5 — Arachne as the shared inter-system backbone

> **Status: proposal (forward-looking).** What IS built: the memory engine
> (`apps/arachne-server`, undeployed) and the gate relay (PR #15). What this doc
> proposes: how Arachne generalizes from "shared memory + gate relay" into **the
> single backend every Nyx/AI system talks to each other through**, and exactly
> how that rides the *current* architecture without changing Core.
>
> Read before scoping any cross-instance feature (remote review, overseer, fleet
> coordination). Cite as `[T5 scaffold/arachne-shared-backbone.md]`.

---

## 1. The role: a hub, not a mesh

Arachne is **one always-on service** (`lens-arachne` on Fly + dedicated Postgres,
`min_machines_running=1`) that every system connects to. Systems never talk
peer-to-peer; they all talk to the hub. "James's Nyx reviews with the operator,"
"the overseer assigns work," "two instances share a diagnostic lesson" — every one
of these is *A → Arachne → B*, never *A → B*.

Why hub-and-spoke: instances are behind NAT, sleep, and come and go (a pm2 worker,
a laptop). A hub gives durable mailbox semantics (post now, the other side polls
when it's up), one auth model, and one place the operator governs.

```
   Nyx (operator)      Nyx (James)        Iris swarm        employee-portal
        │                   │                  │                   │
        │  bearer token     │ bearer token     │ thin client       │ bearer token
        └─────────┬─────────┴────────┬─────────┴─────────┬─────────┘
                  ▼                   ▼                   ▼
            ┌───────────────────────────────────────────────┐
            │  ARACHNE  (lens-arachne.fly.dev)               │
            │  relay + shared store — runs no agents         │
            └───────────────────────────────────────────────┘
                              │
                        Fly Postgres
```

## 2. The planes (what flows through the hub)

Arachne carries typed, independently-scoped "planes." Each is a table set + a few
endpoints + a scope. New capability = new plane, never a new service.

| Plane | Endpoints | Scope(s) | State |
|---|---|---|---|
| **Memory** | `/pack /search /node /usage` | `read` `write` | built (undeployed) |
| **Gate relay** | `/gate /gate/inbox /gate/:id/decision /gate/decided /gate/:id/consume` | `gate_push` `gate_review` | built (PR #15) |
| **Coordination** (proposed) | `/msg` (send) · `/msg/inbox` · `/msg/:id/ack` | `action_send` `action_recv` | design only |
| **Identity / registry** | the `platforms` table (+ a future `/registry`) | n/a (admin) | partial (platforms exists) |
| **Presence / telemetry** (proposed) | `/heartbeat` · `/fleet` | `presence` | design only (feeds the deferred overseer) |

The gate relay *is* a specialization of the coordination plane: origin posts a
message addressed to a reviewer, the reviewer replies, the origin acks/consumes.
Build coordination by generalizing the gate model — same shape, free-form payload.

## 3. How it maps onto the CURRENT architecture (the important part)

**Core does not change. Arachne stays a dumb relay. The adapter is a host plugin.**
Every Nyx instance already has the two seams this needs — see
[`docs/plugin-architecture.md`]:

- **Outbound** = a **hook** observer → `ctx.io.sink`. Core already emits
  `pipeline.gateReached` (and `task.afterComplete`, `tick.after`, …). A host plugin
  does `ctx.hooks.on('pipeline.gateReached', …)` and POSTs to Arachne via a sink.
- **Inbound** = `ctx.io.source` → `pending_actions` → the tick executor. A host
  plugin polls Arachne, and for each result `emit({ kind: 'action', payload })`.
  The action lands in `pending_actions` and the next tick drains it through the
  existing executor verbs (`pipeline_decision`, `queue_task`, `resume_task`,
  `force_tick`) → `submitDecision` / `queueTask`. **No new Core code path.**
- **Identity** = the `platforms` table (sha256 bearer token + `scopes[]`). Each
  system gets one platform row, provisioned by the operator's admin tool
  (`node dist/admin.js add-platform <id> <name> <scopes>`). Scope = capability.
- **The `remoteactions` plugin stub** (`Plugins/remoteactions/`, today a no-op that
  logs "wire your remote transport") is the canonical template for *every*
  Arachne-backed inbound. The gate-relay plugin is the first real instance of it.

So the integration surface is: **host-runtime plugins + the `platforms` registry.**
Nothing touches the dispatcher tick, the audit chain, or the spawn model.

```
Core (per instance)                         Arachne (hub)
  hooks: pipeline.gateReached ──▶ io.sink ──── POST /gate ───▶ gates table
  pending_actions ◀── io.source ◀── poll ───── GET /gate/decided
        │                                       (decision rows)
        └─▶ tick executor ─▶ submitDecision ─▶ pipeline resumes
```

## 4. Invariants (what Arachne must NOT become)

- **Not an orchestrator.** Arachne stores and relays; it never spawns `claude`,
  never runs a tick, never decides. Compute stays on the instances. A relay that
  starts orchestrating becomes a single point of failure for everyone's work.
- **Never an instance's source of truth.** Each instance keeps its **hash-chained
  audit DB, single-writer, local** (the host already never writes the chain). Arachne
  is eventually-consistent *shared* state. An instance must run (degraded) with
  Arachne down.
- **Remote-primary + local cache, per plane.** Memory reads serve from a periodic
  local snapshot when the hub is unreachable; gate/coordination decisions queue
  locally and flush on reconnect. A hub outage degrades, never halts.
- **Operator-governed membership.** Only the owner (`dg-lens`) provisions platforms
  and grants scopes. Capability is the intersection of a token's scopes and the
  plane it calls. No self-registration.
- **Least-privilege scopes.** A memory-only platform never gets `gate_*`; a reviewer
  gets `gate_review`, not `gate_push`. The `platforms.scopes[]` array is the whole
  authorization model — keep it that way.

## 5. How non-Nyx systems join

- **Iris (James's pm2 `claude -p` swarm)** is not a Nyx instance and must not be
  overhauled. Two options: (a) it gets a **thin Arachne client** — a tiny poster/poller
  with its own platform token, no Nyx Core; or (b) it rides through James's co-located
  Nyx instance as a bridge (Iris writes intents to that Nyx's `pending_actions`; the
  Nyx host plugin relays). Prefer (b) first — zero new Iris code.
- **employee-portal** becomes an Arachne client with its own token: a `gate_review`
  surface (review relayed gates from a phone) and later a memory browser. Cross-repo,
  so it lands after the desktop/Slack surfaces.
- **Future team-agent platform (deferred #3)** is just more platforms on the hub,
  with `presence` + `action_recv` scopes; the overseer reads the presence/telemetry
  plane.

## 6. Build / migration order

- **A — engines (done):** memory engine + gate relay code, per-platform auth, admin
  tool, deploy bundle. `[apps/arachne-server]`, `[apps/arachne-server/DEPLOY.md]`.
- **B — deploy (next, gating):** `fly` up `lens-arachne` + Postgres; provision
  `operator` (`gate_review`) and `james` (`gate_push`) tokens. Until this lands,
  nothing is actually always-on.
- **C — host-plugin adapters:** implement the gate-relay plugin (push on
  `pipeline.gateReached`, poll `/gate/decided` → `pipeline_decision` → consume) and
  re-point the memory plugins to remote-primary + cache. This replaces the
  `remoteactions` stub with real transports. Desktop Local/Remote gate tabs + the
  Slack surface consume the same endpoints.
- **D — coordination plane:** generalize the gate model into `/msg` (free-form,
  addressed, ack'd) so any instance can hand work or status to another. Foundation
  for the overseer.
- **E — presence / telemetry:** `/heartbeat` + `/fleet`; the deferred overseer reads
  it. Transparent posture (a user sees their own reports) per the prior decision.

## 7. Open decisions (resolve before the relevant phase)

- **Per-pair authorization** (phase D): is `action_send` global, or must the operator
  authorize each origin→target edge? The gate plane sidesteps this today by letting
  the origin name its `reviewer`; coordination needs an explicit answer.
- **Coordination payload schema** (D): typed envelopes vs opaque JSON + a `kind`.
- **Dedup / idempotency** (C/D): message ids + consume semantics (the gate plane
  already models `open → decided → consumed`; reuse it).
- **Cache/snapshot cadence + staleness bounds** (C): how stale may a memory pack be.
- **Rate limits / quotas per platform** (D+): protect the hub from a runaway swarm.

## 8. See also
- `[apps/arachne-server/README.md]` — endpoints + scopes (memory + gate relay).
- `[apps/arachne-server/DEPLOY.md]` — phase B runbook.
- `[docs/plugin-architecture.md]` — the host/io/hook seams this rides.
- `[T3 apps/dispatcher/src/pipeline/CLAUDE.md]` — pipeline gates (the first relay producer).
