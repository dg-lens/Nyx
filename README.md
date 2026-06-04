# Nyx

A drop-in autonomous agent-management framework. Nyx drains a scheduled task queue and spawns sandboxed `claude -p` subprocesses to do code, analysis, assistant, content, and multi-step pipeline work — recording every action on a hash-chained audit log. It runs entirely on your local machine.

> **v1.0 is local-only.** Remote monitoring, a Supabase state mirror, and a web dashboard are a planned remote plugin — not part of the base install.

## Requirements

- macOS (the dispatcher is scheduled via `launchd`)
- Node ≥ 20 and `pnpm`
- The `claude` CLI (Claude Code), authenticated one of two ways:
  - **OAuth** — signed in to a Claude subscription (`~/.claude`); leave `ANTHROPIC_API_KEY` unset, or
  - **API key** — set `ANTHROPIC_API_KEY` in `.env` (pay-per-token)
- `git`, plus `gh` for tasks that target GitHub repos
- Optional: Bitwarden Secrets Manager (`bws`) for per-project secret injection; Slack for notifications

## Quickstart

```
git clone https://github.com/dg-lens/Nyx.git ~/Nyx/Core
cd ~/Nyx/Core
bash scripts/nyx-bootstrap.sh     # creates ~/Nyx/{Data,Plugins}, seeds config, builds
$EDITOR ../Data/.env              # set GIT_AUTHOR_*, choose auth (key or OAuth)
bash scripts/nyx-up.sh            # load the dispatcher into launchd
bash scripts/nyx-status.sh        # confirm it is running
```

Put `scripts/` on your `PATH` (or symlink `scripts/nyx`) to use the wrapper:
`nyx bootstrap | up | status | tick | queue | slots | logs | audit | resume | pipeline | down`.

## How it works

- **Queue + schedule.** Tasks live in `nyx.md` under `## Active Tasks`. The day is a 96-slot grid; a task fires by `[slot: N]` or `[every: K]`, or joins a standing list. A `launchd` job ticks the dispatcher.
- **Task types.** `code`, `analysis`, `assistant`, `content`, and `pipeline` — each spawned with a scoped tool set and working directory.
- **Pipeline.** `[type: pipeline]` turns one prompt into a PR-ready feature via parallel coders + self-reconciliation between two human gates (preview always; review only if unresolved).
- **Composer.** A pre-dispatch spec normalizer that tightens task specs before execution.
- **Audit.** Every action appends to a hash-chained log; `nyx audit --chain` verifies integrity.
- **Secrets.** Optional per-task Bitwarden injection; tokens are never logged.

The configurable instance name is `NAME` in `.env` (read everywhere as the system name). The full operator + engineering reference is [`CLAUDE.md`](CLAUDE.md).

## Configuration

- `.env` — per-install config (copied from `.env.example`): `NAME`, `GIT_AUTHOR_*`, auth, and optional Slack / Bitwarden settings.
- `nyx.md` — your task queue (seeded from `nyx.md.example`).

Both are per-install and gitignored.

## Layout

A Nyx install is three sibling directories under `~/Nyx`:

- **`Core/`** — this repo (stock framework code). `nyx update` reverts it to `origin/main`; it holds no personal data.
- **`Plugins/`** — plugins that extend the core; kept across Core updates.
- **`Data/`** — your `.env`, `nyx.md`, task DBs, `logs/`, `outputs/`, `memory/`, and `documents/`. **Never touched by a Core update.**

Inside `Core/`:

- `apps/dispatcher` — the engine: scheduler, spawner, audit chain, composer, pipeline, secrets
- `apps/assistant` — assistant-task prompt templates
- `apps/analyzer` — repo-scan library
- `scripts/` — the `nyx` CLI wrapper + `launchd` helpers
- `config/` — Homebrew formula + `launchd` plist template

## Updating

`nyx update` fetches and hard-resets `Core/` to `origin/main`, then rebuilds. `Data/` and `Plugins/` are siblings of `Core/` and are never touched, so a core update reverts to stock without disturbing your data or plugins.

## Homebrew (optional)

A formula is provided at `config/Formula/nyx.rb` for a `brew`-managed install that separates code (libexec) from data (`~/Nyx`). Source install via the Quickstart above is the supported path for v1.0.
