# Changelog

**Nyx** — a drop-in autonomous agent-management framework.

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
