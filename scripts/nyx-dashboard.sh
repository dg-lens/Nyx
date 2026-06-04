#!/usr/bin/env bash
# nyx-dashboard: start / stop / status the dashboard server.
#
# Usage:
#   ./scripts/nyx-dashboard.sh start    — boot the server in the background
#   ./scripts/nyx-dashboard.sh stop     — kill the running server
#   ./scripts/nyx-dashboard.sh restart  — rebuild + restart
#   ./scripts/nyx-dashboard.sh status   — show pid + endpoints
#   ./scripts/nyx-dashboard.sh fg       — run in the foreground (Ctrl-C to stop)
#
# Server listens on http://127.0.0.1:8767 by default. Open in a browser, or
# expose via Tailscale by setting DASHBOARD_HOST=0.0.0.0 in .env (and trusting
# the network — there is no auth).
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PIDFILE="/tmp/nyx-dashboard.pid"
LOGFILE="$NYX_ROOT/logs/dashboard.log"

# Load .env so DASHBOARD_HOST / DASHBOARD_PORT / etc. propagate to the node process.
# `set -a` exports every variable assigned by the source; `set +a` turns that off.
if [[ -f "$NYX_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$NYX_ROOT/.env"
  set +a
fi

PORT="${DASHBOARD_PORT:-8767}"

cd "$NYX_ROOT"

# Is port $PORT held by anything? Print "<pid> <command>" if so, empty otherwise.
# Works whether or not the holder is one of our processes.
#
# Note: `lsof` exits non-zero when no matching line is found (the very case we
# care about). With `set -e` + `pipefail` upstream, that would kill the script
# silently. Trailing `|| true` keeps "no listener" looking the same as success.
port_holder() {
  if command -v lsof >/dev/null 2>&1; then
    { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -F pc 2>/dev/null \
        | awk '/^p/{pid=substr($0,2)} /^c/{print pid, substr($0,2); exit}'; } \
      || true
  fi
}

# Quick check: anything (orphan, dispatcher, unrelated app) listening on our port?
ensure_port_free() {
  local holder
  holder=$(port_holder) || true
  if [[ -n "$holder" ]]; then
    echo "✗ port $PORT is already in use by: $holder" >&2
    echo "  if that's a stale dashboard, run: $0 stop" >&2
    echo "  otherwise change DASHBOARD_PORT (in .env or the launchd plist)" >&2
    exit 1
  fi
}

cmd_start() {
  mkdir -p "$NYX_ROOT/logs"

  if [[ -f "$PIDFILE" ]]; then
    PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
      echo "already running, pid $PID"
      exit 0
    fi
    rm -f "$PIDFILE"
  fi

  # No pidfile (or stale one) — but a previous run may have left a process
  # without a pidfile. Check the port directly.
  ensure_port_free

  if [[ ! -f "$NYX_ROOT/apps/dashboard/dist/cli/serve.js" ]]; then
    echo "→ building dashboard..."
    pnpm --filter @nyx/dashboard build >/dev/null
  fi

  echo "→ starting dashboard on port $PORT..."
  nohup node "$NYX_ROOT/apps/dashboard/dist/cli/serve.js" \
    >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  sleep 1
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "✓ dashboard running, pid $PID"
    echo "  http://127.0.0.1:$PORT/"
    echo "  log: $LOGFILE"
  else
    echo "✗ dashboard failed to start — check $LOGFILE"
    exit 1
  fi
}

cmd_stop() {
  if [[ ! -f "$PIDFILE" ]]; then
    # belt-and-braces: also look up by command line, in case the pidfile got lost
    if pgrep -fl 'dashboard/dist/cli/serve' >/dev/null; then
      echo "no pidfile but found running server — killing"
      pkill -f 'dashboard/dist/cli/serve' || true
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
    echo "  http://127.0.0.1:$PORT/"
    echo "  log: $LOGFILE"
    if command -v curl >/dev/null 2>&1; then
      curl -s "http://127.0.0.1:$PORT/api/health" || echo "  (health check failed)"
      echo
    fi
  else
    echo "not running"
  fi
}

cmd_restart() {
  cmd_stop || true
  sleep 1
  echo "→ rebuilding..."
  pnpm --filter @nyx/dashboard build >/dev/null
  cmd_start
}

cmd_fg() {
  ensure_port_free
  if [[ ! -f "$NYX_ROOT/apps/dashboard/dist/cli/serve.js" ]]; then
    echo "→ building dashboard..."
    pnpm --filter @nyx/dashboard build >/dev/null
  fi
  exec node "$NYX_ROOT/apps/dashboard/dist/cli/serve.js"
}

case "${1:-status}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  fg)      cmd_fg ;;
  *) echo "usage: $0 {start|stop|restart|status|fg}"; exit 1 ;;
esac
