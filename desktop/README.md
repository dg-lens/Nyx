# Nyx Desktop (native macOS)

A native SwiftUI menu-bar + window app — your local control surface for Nyx. No web tech, no server: it reads the same SQLite DB and `nyx.md` the dispatcher uses, and writes operator decisions into the `pending_actions` control table that the next tick drains.

## What it shows

- **Gates** — pipeline runs paused at a preview/review gate, as cards. Approve / Revise (preview) or Proceed / Fix (review), with an optional note. The decision writes a `pipeline_decision` action and fires a tick so it applies immediately.
- **Dispatch** — describe work in natural language; it's queued (a `queue_task` action) for the dispatcher to decompose on the next tick. Pick the task type and an optional repo.
- **Monitor** — the live queue (parsed from `nyx.md`) and the most recent `system_audit` events.

The menu-bar extra shows the waiting-gate count and lets you approve the top gates or force a tick without opening the window.

## How it talks to Nyx

It never writes the audit chain (single-writer = the tick). All control flows through the local `pending_actions` table — the *same* surface the Slack and remoteactions plugins use:

| Action | Written when |
|---|---|
| `pipeline_decision` `{runId, decision, note?}` | a gate button is pressed |
| `queue_task` `{text, type, repo?}` | Dispatch → Queue |

Paths resolve from `NYX_DATA_DIR` / `NYX_REPO_ROOT` (falling back to `~/Nyx/Data` and `~/Nyx/Core`), so it follows the Core/Plugins/Data layout automatically.

## Build & run

Requires the Swift toolchain (full Xcode recommended; Command Line Tools alone ship a partial SwiftPM that can't link the manifest).

```sh
cd Core/desktop
swift run            # or: swift build && .build/debug/NyxDesktop
```

To make it a dock-less menu-bar-only agent, set `LSUIElement` in the app's Info.plist (or call `NSApp.setActivationPolicy(.accessory)` at launch) — left off in the draft so the window is reachable during development.

## Status

Draft. Reads and writes are live against `Data/`; the gate/dispatch/monitor flows are wired end-to-end. Not yet wrapped as a signed `.app` bundle or added to login items — `swift run` from here is the dev path.
