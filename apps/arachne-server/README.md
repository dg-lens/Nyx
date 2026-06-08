# arachne-server — shared collective memory (Fly + Postgres)

The Arachne engine reworked into a multi-platform remote service: one always-on
listener every AI agent platform (Nyx, Iris, …) reads/writes with per-platform
auth, so all platforms build on one shared diagnostic-memory graph.

Decisions (locked): **Fly + dedicated Postgres** store · clients are
**remote-primary with a local cache + write queue** (an agent still has memory if
the service is down) · oversight/sharing is **transparent** (a #3 concern, later).

## Architecture
- **Store:** Postgres (`migrations/0001_init.sql`) — `nodes` (array columns for
  loc/concern/paths/triggers + GIN indexes), `edges`, `platforms` (auth),
  `node_usage` (outcome feedback → weight tuning), `write_log` (provenance trail).
- **Engine:** the assemble/search/write logic from `apps/dispatcher/src/memory/arachne.ts`,
  re-pointed at Postgres (array-overlap `&&` queries for scope/trigger/path match;
  budget + U-order in the app layer — unchanged).
- **Clients:** the `memory` + `memory-surface` plugins become thin HTTP clients;
  remote-primary, with a periodic scope-snapshot cached to disk so `assemble` runs
  locally on outage, and writes queued + flushed on reconnect.

## API (bearer token per platform; token_hash in `platforms`, raw token in Bitwarden)
- `POST /pack`    `{loc, role, paths, text, budget}` → assembled, budgeted, U-ordered pack
- `POST /search`  `{text?, loc?, kind?, limit?}` → ranked stubs
- `GET  /node/:id`                              → full node (or `?section=`)
- `POST /node`    `{node}`                      → write (provenance `platform:<id>`, review pending)
- `POST /usage`   `{node_ids[], cited?, outcome?}` → outcome feedback
- `GET  /health`                               → liveness

## Build phases
1. **Schema** — `migrations/0001_init.sql`. ✅
2. **Server + auth** — Fastify (matches the Python/FastAPI sub-app posture, or Node), the engine-over-Postgres, bearer middleware, the endpoints above. Local-testable against a docker Postgres.
3. **Client cache/queue** — rewrite the two plugins to remote-primary + local snapshot/queue.
4. **Deploy + import** — Fly app (region `ord`, like outreach-api), Fly Postgres, Bitwarden→Fly secret mirror, one-time importer of the current 152-node vault → Postgres.

## Status
Phase 1 done. Phase 2 next.
