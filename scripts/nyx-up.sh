#!/usr/bin/env bash
# nyx-up: start (or confirm) all Nyx daemons.
#
# Idempotent. Safe to run when things are already up — each subcommand is itself idempotent.
#
#   1. dispatcher (launchd, fires every 15 min)
#   2. sync daemon (local→Supabase mirror; only starts if Supabase creds set)
#
# The operator dashboard is at http://127.0.0.1:8767 (local; set your own host) (the portal).
# The local HTTP dashboard on port 8767 has been decommissioned (EMP-008).
#
# Use scripts/nyx-down.sh to stop everything.
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
# When installed via brew, NYX_DATA_DIR is set to ~/Nyx by the wrapper;
# for source installs both dirs are the same.
NYX_DATA_DIR="${NYX_DATA_DIR:-$NYX_ROOT}"
DISPATCHER_PLIST="$NYX_ROOT/config/launchd/com.nyx.dispatcher.plist"

# Source .env from the data dir (where operator keeps config, not the code dir).
if [[ -f "$NYX_DATA_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$NYX_DATA_DIR/.env"
  set +a
fi

cd "$NYX_ROOT"

echo "── 1. dispatcher (launchd) ──────────────────────────────"
if launchctl list 2>/dev/null | grep -q nyx.dispatcher; then
  echo "  ✓ already loaded"
else
  launchctl load -w "$DISPATCHER_PLIST"
  echo "  ✓ loaded"
fi

echo
echo "── 2. sync daemon ───────────────────────────────────────"
if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
  echo "  ⊘ skipped (SUPABASE_URL / SUPABASE_SERVICE_KEY not set in .env)"
  echo "    see DEPLOY.md to wire up Supabase, then re-run this command"
else
  bash "$NYX_ROOT/scripts/nyx-sync.sh" start
fi

echo
echo "── status ──────────────────────────────────────────────"
bash "$NYX_ROOT/scripts/nyx-status.sh"
