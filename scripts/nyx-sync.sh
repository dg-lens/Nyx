#!/usr/bin/env bash
# nyx-sync: start / stop / status the local→Supabase sync daemon.
#
# Usage:
#   ./scripts/nyx-sync.sh start    — boot in the background
#   ./scripts/nyx-sync.sh stop     — kill the running daemon
#   ./scripts/nyx-sync.sh restart  — rebuild + restart
#   ./scripts/nyx-sync.sh status   — pid + log path
#   ./scripts/nyx-sync.sh once     — run one sync cycle and exit
#   ./scripts/nyx-sync.sh fg       — run in the foreground (Ctrl-C to stop)
#
# Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in .env. See DEPLOY.md.
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PIDFILE="/tmp/nyx-sync.pid"
LOGFILE="$NYX_ROOT/logs/sync.log"

# Source .env so SUPABASE_URL / SUPABASE_SERVICE_KEY propagate to the node process.
if [[ -f "$NYX_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$NYX_ROOT/.env"
  set +a
fi

cd "$NYX_ROOT"

cmd_start() {
  mkdir -p "$NYX_ROOT/logs"

  if [[ -f "$PIDFILE" ]]; then
    PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      echo "already running, pid $PID"
      return 0
    fi
    rm -f "$PIDFILE"
  fi

  # Check for unmanaged orphans before launching.
  if pgrep -fl 'sync/dist/cli/sync' >/dev/null 2>&1; then
    echo "✗ another sync process is already running (no pidfile)"
    echo "  kill with: $0 stop"
    exit 1
  fi

  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
    echo "✗ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env"
    echo "  see DEPLOY.md for how to get these from your Supabase project"
    exit 1
  fi

  if [[ ! -f "$NYX_ROOT/apps/sync/dist/cli/sync.js" ]]; then
    echo "→ building sync app..."
    pnpm --filter @nyx/sync build >/dev/null
  fi

  echo "→ starting sync daemon..."
  nohup node "$NYX_ROOT/apps/sync/dist/cli/sync.js" \
    >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "✓ sync running, pid $PID"
    echo "  log: $LOGFILE"
  else
    echo "✗ sync failed to start — check $LOGFILE"
    tail -10 "$LOGFILE" 2>/dev/null
    exit 1
  fi
}

cmd_stop() {
  if [[ ! -f "$PIDFILE" ]]; then
    if pgrep -fl 'sync/dist/cli/sync' >/dev/null; then
      echo "no pidfile but found running sync — killing"
      pkill -f 'sync/dist/cli/sync' || true
    else
      echo "not running"
    fi
    return 0
  fi
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "✓ stopped pid $PID"
  else
    echo "stale pidfile (pid $PID dead)"
  fi
  rm -f "$PIDFILE"
  return 0
}

cmd_status() {
  if [[ -f "$PIDFILE" ]] && PID=$(cat "$PIDFILE" 2>/dev/null) && kill -0 "$PID" 2>/dev/null; then
    echo "✓ running, pid $PID"
    echo "  log: $LOGFILE"
    echo
    echo "  recent log lines:"
    tail -5 "$LOGFILE" 2>/dev/null | sed 's/^/    /'
  else
    echo "not running"
  fi
}

cmd_restart() {
  cmd_stop || true
  sleep 1
  echo "→ rebuilding..."
  pnpm --filter @nyx/sync build >/dev/null
  cmd_start
}

cmd_once() {
  if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_KEY:-}" ]]; then
    echo "✗ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env"
    exit 1
  fi
  if [[ ! -f "$NYX_ROOT/apps/sync/dist/cli/sync.js" ]]; then
    pnpm --filter @nyx/sync build >/dev/null
  fi
  exec node "$NYX_ROOT/apps/sync/dist/cli/sync.js" --once
}

cmd_fg() {
  if [[ -f "$PIDFILE" ]] && PID=$(cat "$PIDFILE" 2>/dev/null) && kill -0 "$PID" 2>/dev/null; then
    echo "✗ sync is already running (pid $PID). Run: $0 stop first."
    exit 1
  fi
  if [[ ! -f "$NYX_ROOT/apps/sync/dist/cli/sync.js" ]]; then
    pnpm --filter @nyx/sync build >/dev/null
  fi
  exec node "$NYX_ROOT/apps/sync/dist/cli/sync.js"
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  once)    cmd_once ;;
  fg)      cmd_fg ;;
  *) echo "usage: $0 {start|stop|restart|status|once|fg}"; exit 1 ;;
esac
