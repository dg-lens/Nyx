# memory (Nyx plugin — approved / stock)

The config point for Nyx's memory backend. By default it points at a **local Obsidian vault** under `Data/memory/`; it can also be configured for remote connections. Set `NYX_MEMORY_BACKEND` in `Data/.env` (default `local-obsidian`).

It attaches a `task.promptBuild` **filter** that tells code/analysis agents a memory graph is available, replacing the deprecated memory-MCP integration that used to live in Core. The backend engine (vault read/write/search, following the v2 memory design) is developed alongside Nyx.

- `nyx-plugin.json` — manifest (tier `approved`, `sdkVersion 1`).
- `dist/index.js` — the loaded entry. Restructure to a `src/` + TypeScript build against the SDK types when extending it.
