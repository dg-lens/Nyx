#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG_DIR="$NYX_DATA_DIR/logs"
TODAY_LOG="$LOG_DIR/dispatch-$(date +%Y-%m-%d).log"
LAUNCHD_OUT="$LOG_DIR/launchd.out.log"
LAUNCHD_ERR="$LOG_DIR/launchd.err.log"

if [[ "${1:-}" == "--launchd" ]]; then
  echo "=== launchd stdout ($LAUNCHD_OUT) ==="
  [[ -f "$LAUNCHD_OUT" ]] && tail -30 "$LAUNCHD_OUT" || echo "(empty)"
  echo
  echo "=== launchd stderr ($LAUNCHD_ERR) ==="
  [[ -f "$LAUNCHD_ERR" ]] && tail -30 "$LAUNCHD_ERR" || echo "(empty)"
  exit 0
fi

if [[ "${1:-}" == "-f" ]]; then
  [[ -f "$TODAY_LOG" ]] || { echo "no log for today yet: $TODAY_LOG"; exit 1; }
  exec tail -f "$TODAY_LOG"
fi

N="${1:-50}"
if [[ ! -f "$TODAY_LOG" ]]; then
  echo "no log for today: $TODAY_LOG" >&2
  echo
  echo "available logs:" >&2
  ls -lt "$LOG_DIR"/dispatch-*.log 2>/dev/null | head -5 >&2 || echo "  (none)" >&2
  exit 1
fi

tail -n "$N" "$TODAY_LOG"
