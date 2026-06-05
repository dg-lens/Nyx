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
| `decompose_task` `{text, type, model, priority, repo?}` | Dispatch → Decompose & Queue (a sonnet pass expands it into tagged tasks) |

Paths resolve from `NYX_DATA_DIR` / `NYX_REPO_ROOT` (falling back to `~/Nyx/Data` and `~/Nyx/Core`), so it follows the Core/Plugins/Data layout automatically.

## Build & run

Two paths, depending on your toolchain:

**Command Line Tools only** — use the direct `swiftc` build (`build.sh`). CLT 16.4 ships a broken SwiftPM (its `libPackageDescription` binary is out of sync with its headers, so `swift run`/`swift build` can't link *any* manifest) **and** a duplicate `SwiftBridging` modulemap that breaks every Swift compile. `build.sh` sidesteps SwiftPM entirely, but you must clear the duplicate modulemap once:

```sh
sudo rm /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap
cd Core/desktop
./build.sh
open *.app
```

(The removed file is a stale Aug-2023 leftover Apple's package ships alongside the current `bridging.modulemap`; a CLT update may restore it — re-run the `rm` if the SwiftBridging error returns.)

The bundle is named after your instance name (`NAME` in `Data/.env`) — `Nyx.app`, `Iris.app`, etc. Change the name in the Settings tab, then re-run `./build.sh` to rebrand the app.

**Full Xcode** — the bundled toolchain is consistent, so SwiftPM works normally:

```sh
cd Core/desktop
swift run
```

To make it a dock-less menu-bar-only agent, set `LSUIElement` in `Info.plist` (or call `NSApp.setActivationPolicy(.accessory)` at launch) — left off in the draft so the window is reachable during development.

## Status

Draft. Reads and writes are live against `Data/`; the gate/dispatch/monitor flows are wired end-to-end. `build.sh` produces `NyxDesktop.app` (unsigned, not yet added to login items). The `Package.swift` is kept for the full-Xcode path.
