#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NYX_DATA_DIR="${NYX_DATA_DIR:-$NYX_ROOT}"
DISPATCHER_PLIST="$NYX_DATA_DIR/com.nyx.dispatcher.plist"

if [[ ! -f "$DISPATCHER_PLIST" ]]; then
  echo "✗ launchd plist not found at $DISPATCHER_PLIST" >&2
  echo "  run 'nyx bootstrap' first." >&2
  exit 1
fi

if [[ -f "$NYX_DATA_DIR/.env" ]]; then
  set -a
  . "$NYX_DATA_DIR/.env"
  set +a
fi

cd "$NYX_ROOT"

echo "── dispatcher (launchd) ──"
if launchctl list 2>/dev/null | grep -q nyx.dispatcher; then
  echo "  ✓ already loaded"
else
  launchctl load -w "$DISPATCHER_PLIST"
  echo "  ✓ loaded"
fi

HOST_PLIST="$NYX_DATA_DIR/com.nyx.host.plist"
if [[ -f "$HOST_PLIST" ]]; then
  echo
  echo "── plugin host (launchd) ──"
  if launchctl list 2>/dev/null | grep -q nyx.host; then
    echo "  ✓ already loaded"
  else
    launchctl load -w "$HOST_PLIST"
    echo "  ✓ loaded"
  fi
fi

WATCHDOG_PLIST="$NYX_DATA_DIR/com.nyx.watchdog.plist"
if [[ -f "$WATCHDOG_PLIST" ]]; then
  echo
  echo "── watchdog (launchd) ──"
  if launchctl list 2>/dev/null | grep -q nyx.watchdog; then
    echo "  ✓ already loaded"
  else
    launchctl load -w "$WATCHDOG_PLIST"
    echo "  ✓ loaded"
  fi
fi

echo
echo "── status ──"
bash "$NYX_ROOT/scripts/nyx-status.sh"
