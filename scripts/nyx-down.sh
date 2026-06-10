#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DISPATCHER_PLIST="$NYX_DATA_DIR/com.nyx.dispatcher.plist"

cd "$NYX_ROOT"

echo "── 1. dispatcher (launchd) ──────────────────────────────"
if launchctl list 2>/dev/null | grep -q nyx.dispatcher; then
  launchctl unload -w "$DISPATCHER_PLIST"
  echo "  ✓ unloaded"
else
  echo "  ⊘ not loaded"
fi

WATCHDOG_PLIST="$NYX_DATA_DIR/com.nyx.watchdog.plist"
echo
echo "── 2. watchdog (launchd) ────────────────────────────────"
if launchctl list 2>/dev/null | grep -q nyx.watchdog; then
  launchctl unload -w "$WATCHDOG_PLIST"
  echo "  ✓ unloaded"
else
  echo "  ⊘ not loaded"
fi

echo
echo "── 3. sync daemon ───────────────────────────────────────"
bash "$NYX_ROOT/scripts/nyx-sync.sh" stop

echo
echo "── 4. dashboard ─────────────────────────────────────────"
bash "$NYX_ROOT/scripts/nyx-dashboard.sh" stop

echo
echo "all stopped."
