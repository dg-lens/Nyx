# Changelog

**Nyx** — a drop-in autonomous agent-management framework.

## v1.4.0 — 2026-06-10

### Arachne memory MCP server
- New workspace `apps/arachne-mcp/` — a **thin stdio MCP front over the existing vault engine** (`apps/dispatcher/src/memory/arachne.ts`); no retrieval logic is reimplemented. Exposes eight tools: `memory_pack` (hot-path scoped pack via `deriveLoc`+`assemble`+`renderPack`, inheriting the `isInjectable` provenance gate so `review:pending` agent nodes are never injected), `memory_survey` (ranked stubs, no bodies), `memory_load` (≤10 full bodies, `sanitizeBody`+`orderBodySections`), `memory_search` (frontmatter matches; pending agent nodes returnable but flagged with provenance/review/`injectable`), `memory_neighbors` (typed edge traversal), `memory_write` (`classifyWrite` dedup/provenance chokepoint first — duplicate/conflict is a structured refusal naming the existing id, only a clean `ADD` persists), `memory_validate` (corruption detector that surfaces every parse failure `buildIndex` silently swallows, plus index-vs-file count), and `memory_reload`.
- In-process index cache (`IndexCache`); `memory_write`/`memory_reload` invalidate it. Vault path resolves via `memoryDir(NYX_DATA_DIR)` replicating the dispatcher's env fallback without importing its stateful config.
- New launcher `scripts/nyx-arachne-mcp.sh` + `arachne-mcp` wired into `nyx` help. The Formula installs a `bin/nyx-arachne-mcp.sh` wrapper and the caveats document the `claude mcp add --scope user arachne -- bash /opt/homebrew/opt/nyx/bin/nyx-arachne-mcp.sh` registration.
- Touched: `apps/arachne-mcp/**`, `tsconfig.json`, `scripts/nyx`, `scripts/nyx-arachne-mcp.sh`, `Formula/nyx.rb`, `pnpm-lock.yaml`.

## v1.3.1 — 2026-06-10

### Memory engine
- Added `ruleset` to the Arachne engine's **closed** node-kind vocabulary (`apps/dispatcher/src/memory/arachne.ts`). The kind vocabulary is now an explicit `NodeKind` union + `VALID_KINDS` set (`invariant`/`lesson`/`decision`/`playbook`/`proposal`/`overview`/`reference`/`ruleset`/`moc`), exported alongside an `isValidKind` guard. `parseNode` drops, and `writeNode` rejects, any node whose kind is outside the set — the enum stays CLOSED; unknown kinds (e.g. `regulation`) are not accepted. `NodeMeta.kind`, `WriteInput.kind`, and `SearchQuery.kind` are typed `NodeKind`. The wisdom layer's advisory kinds (`procedure`→`playbook`, `aesthetic`→`invariant`) now normalize onto the closed vocabulary before write. `isInjectable` is unchanged (provenance/review-based, kind-agnostic).
- Touched: `apps/dispatcher/src/memory/arachne.ts`, `apps/dispatcher/src/wisdom-capture.ts`, `apps/dispatcher/__tests__/arachne.test.ts`.

## v1.3.0 — 2026-06-09

### Composer normalizer (shadow stage)
- The composer grows its intended canonical role — a **pre-dispatch spec normalizer/compiler** — as a first cut that runs **shadow-mode only**. For a code task it computes a tightened spec (exact paths/symbols verified against the actual repo, concrete acceptance criteria, anti-examples), compiles the `[depends:]` dependency DAG (Kahn topo-sort + cycle detection), predicts merge conflicts (planned-file-set intersection ∪ `git merge-tree` probe), and derives a `would_reject` verdict for un-normalizable specs.
- **Shadow only:** the normalizer **computes + persists + audit-logs** and returns control unchanged. It does **not** halt, reject, re-park, alter the spec the executor sees, or change any task's control flow. The new `would_reject` boolean is recorded for operator review; **enforcement is a future flag-flip** (`config.composer.normalizer.enforced`, default `false`, read but not acted on).
- **Now wired into the live code-task dispatch path** — but **OFF by default.** The shadow phase (`runShadowNormalizePhase`) is invoked from `attemptTask` (`cli/run-once.ts`) via `maybeRunShadowNormalize` as a **pre-dispatch** step, before the main execution spawn. It is fully additive and guarded: the call only runs for `type: code` tasks when `config.composer.normalizer.enabled` is true, and a throw can never affect dispatch (the function is void + internally guarded, double-wrapped at the call site). `config.composer.normalizer.enabled` now **defaults to `false`** (was `true`) — set `COMPOSER_NORMALIZER_ENABLED=true` to begin shadow observation. Until then the shipped config runs nothing new and the dispatch path is behaviorally identical to before this change. `COMPOSER_NORMALIZER_ENFORCED` remains a separate, future enforcement flag.
- **Cost when enabled:** each `type: code` task incurs **one extra sonnet planning spawn** (the read-only normalizer spawn) before its execution spawn. Off by default precisely so this cost is opt-in.
- New: `composer/dag.ts` (pure DAG compiler), `composer/normalizer-spawner.ts` (read-only Read/Glob/Grep claude spawn → `.nyx/normalized-spec.json`), `composer/normalizer.ts` (assembler), a `composer_normalizations` table, and a `nyx composer normalizations [--limit N]` review command.
- New audit events: `composer.normalize.completed`, `composer.normalize.skipped`.
- Touched: `apps/dispatcher/src/composer/{types,db,orchestrate,chain-context}.ts`, `apps/dispatcher/src/config.ts`, `apps/dispatcher/src/audit.ts`, `apps/dispatcher/src/cli/{run-once,composer-normalizations}.ts`, `scripts/nyx`, `scripts/nyx-composer.sh`.

## v1.2.1 — 2026-06-09

### Fixed
- **Plugin loader version gate (P0).** `CORE_VERSION` + the `package.json` versions were stale at `0.3.0` while every stock plugin manifest (`memory`, `memory-surface`, `slack`) declares `coreVersion: ">=1.2.0"` — so the loader silently skipped all three on **every** install, disabling `## MEMORY` injection, the memory-surface write/query plane, and Slack gate notifications stack-wide (only a `plugin.skipped` audit line surfaced it). Aligned the core version to the shipping `1.2.x` line and added a regression test that pins `CORE_VERSION` to the root `package.json` version and asserts every stock manifest is satisfied (zero version-skips), so it can't drift out of range again.

## v1.2.0 — 2026-06-04

### Plugin system
- A **plugin loader**: drop a plugin in `Plugins/` (a manifest + a built entry) and it is discovered, validated against the SDK version, and loaded at dispatcher startup — isolated so a plugin error never breaks a tick.
- A stable **plugin SDK** (`NyxPlugin`, `Signal`, manifest types + `definePlugin`) — the public contract plugins build against, independent of Core internals.
- **Hook plane** — a runtime registry plugins use to affect Core: `observe` / `filter` (chained transforms) / `gate` handlers, plus plugin-defined hooks. Core ships built-in emit points at `tick.before`/`tick.after`, `task.promptBuild`, and more.
- **I/O plane** — plugin-registered sources (external → normalized signal) and sinks (signal → external).
- **Local control surface** — a `pending_actions` table any producer (CLI, desktop, a plugin source) writes to and the dispatcher drains each tick: `queue_task`, `resume_task`, `pipeline_decision`, `force_tick`.

## v1.1.0 — 2026-06-04

### Core / Plugins / Data layout
- An install is three sibling directories: `Core/` (stock code), `Plugins/` (extensions, kept across updates), and `Data/` (`.env`, the task queue, task DBs, logs, outputs, memory, documents).
- The dispatcher reads every personal path from `Data/` — set by the launchd plist, the `nyx` wrapper, or sibling auto-detection — cleanly separating code from data.
- **`nyx update`** hard-resets `Core/` to stock `origin/main` and rebuilds, leaving `Data/` and `Plugins/` untouched.

## v1.0.0 — 2026-06-04

First release.

### Dispatch & scheduling
- Autonomous task dispatcher that drains a Markdown task queue (`nyx.md`) and runs work on a 96-slot/day grid. Tasks schedule with `[slot: N]` (daily at a fixed slot), `[every: K]` (fixed cadence), or join a standing list. Driven by `launchd`.
- Five task types, each spawned with a scoped tool set and working directory: `code`, `analysis`, `assistant`, `content`, and `pipeline`.
- Per-task controls: `[model:]`, `[gate:]`, `[priority:]`, `[repo:]`, and `[depends:]` chaining.

### Execution
- Sandboxed `claude -p` subprocess execution via a process-group-aware spawn helper (clean timeout with full subtree kill).
- Authentication chosen per install: subprocesses use `ANTHROPIC_API_KEY` when it is set, and the host's Claude OAuth when it is not — no configuration toggle.
- Pre-flight before every spawn: dependency install probe and declared env-var presence (`[env:]`).
- `[expects:]` artifact verification and `[reading:]` context injection into agent prompts.

### Composer
- A pre-dispatch spec normalizer that validates and tightens task specs — exact symbols, verbatim schemas, acceptance criteria — before any code is dispatched, persisting findings for review.

### Pipeline
- `[type: pipeline]` turns a single prompt into a PR-ready feature: planning → parallel coders in isolated git worktrees → automatic cross-worktree reconciliation → two human gates (preview always; review only when unresolved) → integration branch and pull request. Run state is durable across dispatcher ticks.

### Reliability & recovery
- Hash-chained, append-only audit log of every action, with chain-integrity verification (`nyx audit --chain`).
- Automatic failure triage: a heuristic classifier plus an Opus diagnostic agent that either completes the work or files a structured operator report; a halt blocks dependent tasks until the chain is resumed.
- Ambiguity escalation — agents surface an unresolved design decision for an operator call rather than guessing.
- Wisdom capture — agents record durable lessons after a task.
- Doc-sweep verification — declared documentation updates must actually land before a task commits.

### Secrets
- Optional Bitwarden Secrets Manager integration for per-task secret injection; secret values are never logged.

### Integrations
- MCP-backed Gmail, Calendar, Slack, and Notion access for assistant tasks.
- Per-repo targeting and production-deploy detection for code tasks run against external repositories.

### Operations
- `nyx bootstrap` — one-command first-run setup: runtime directories, `.env`, `nyx.md`, a machine-specific `launchd` plist, and a build.
- A `nyx` CLI wrapper: `up`, `down`, `status`, `tick`, `queue`, `slots`, `logs`, `audit`, `resume`, `pipeline`.
- Configurable instance name via `NAME`.
- Optional Homebrew install that separates code from per-user data.
