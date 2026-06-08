# Nyx — retired tier doc

This repo's knowledge is **not** maintained here anymore. It lives in the **Arachne
memory graph** at `~/Nyx/Data/memory` (atomic nodes + MOCs), read via the `memory_*`
MCP tools.

- **Enter at** `moc-nyx`, then the subsystem MOCs: `moc-nyx-dispatch`,
  `moc-nyx-pipeline` (+ `-redux`, `-shipping`), `moc-nyx-composer`, `moc-nyx-secrets`.
- **Global orientation + operator behavioral preferences** are in `~/.claude/CLAUDE.md`.
- The historical tier-2 content of this file is recoverable from git history.

## Repo hygiene — Core is code-only

This repo ships publicly (the `dg-lens/Nyx` repo + the Homebrew keg). **Do not commit
prose docs, design notes, ops/deploy runbooks, hand-off guides, or dev notes here** —
they leak to anyone who clones. Those live in `~/Nyx/Data/dev/` (local, not shipped).

Core keeps only code + minimal hygiene: top-level `README.md`, `CHANGELOG.md`,
`LICENSE`, per-package `README.md` documenting a shipped API, and
`docs/plugin-architecture.md` (the plugin SDK contract). When unsure → `Data/dev/`.
See the `core-is-code-only` invariant in the Arachne graph.
