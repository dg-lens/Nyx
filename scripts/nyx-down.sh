#!/usr/bin/env bash
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DISPATCHER_PLIST="$NYX_ROOT/config/launchd/com.nyx.dispatcher.plist"

cd "$NYX_ROOT"

echo "── 1. dispatcher (launchd) ──────────────────────────────"
if launchctl list 2>/dev/null | grep -q nyx.dispatcher; then
  launchctl unload -w "$DISPATCHER_PLIST"
  echo "  ✓ unloaded"
else
  echo "  ⊘ not loaded"
fi

echo
echo "── 2. sync daemon ───────────────────────────────────────"
bash "$NYX_ROOT/scripts/nyx-sync.sh" stop

echo
echo "── 3. dashboard ─────────────────────────────────────────"
bash "$NYX_ROOT/scripts/nyx-dashboard.sh" stop

echo
echo "all stopped."
