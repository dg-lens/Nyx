#!/usr/bin/env bash
# nyx-status: one-screen health summary.
#
# Reports: launchd state, last tick, last success, failure count (24h),
# audit chain integrity, queue stats, lockfile state.
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
QUEUE="$NYX_ROOT/nyx.md"
DB="$NYX_ROOT/data/nyx.db"
LOCKFILE="/tmp/nyx-dispatch.lock"
SH_LOCK="/tmp/nyx-dispatch.sh.lock"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$*"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$*"; }
info() { printf "    %s\n" "$*"; }

printf "\n\033[1mNyx Status\033[0m  (%s)\n\n" "$(date '+%Y-%m-%d %H:%M:%S')"

# launchd
printf "\033[1mlaunchd\033[0m\n"
LAUNCHD_LINE=$(launchctl list 2>/dev/null | grep nyx.dispatcher || true)
if [[ -n "$LAUNCHD_LINE" ]]; then
  PID=$(echo "$LAUNCHD_LINE" | awk '{print $1}')
  EXIT_CODE=$(echo "$LAUNCHD_LINE" | awk '{print $2}')
  if [[ "$PID" != "-" ]]; then
    ok "loaded — currently running (pid $PID)"
  elif [[ "$EXIT_CODE" == "0" ]]; then
    ok "loaded — last exit 0"
  else
    warn "loaded — last exit $EXIT_CODE"
  fi
else
  warn "not loaded — run: launchctl load -w $NYX_ROOT/config/launchd/com.nyx.dispatcher.plist"
fi
NEXT_TICK=$(date -v +15M "+%H:%M" | awk -F: '{ m = int($2/15) * 15; printf "%s:%02d\n", $1, m }')
info "next quarter-hour mark: $NEXT_TICK (current slot: $(date "+%-H %-M" | awk '{ print $1*4 + int($2/15) }'))"

# lockfile
printf "\n\033[1mlockfile\033[0m\n"
if [[ -f "$LOCKFILE" ]]; then
  LOCK_PID=$(cat "$LOCKFILE" 2>/dev/null || echo "?")
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    warn "held by live pid $LOCK_PID — dispatcher is running"
  else
    bad "stale lock (pid $LOCK_PID is dead) — next tick will auto-recover"
  fi
else
  ok "available"
fi
[[ -e "$SH_LOCK" ]] && warn "shell-lock dir still present: $SH_LOCK" || true

# audit DB
printf "\n\033[1maudit db\033[0m\n"
if [[ -f "$DB" ]]; then
  TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM system_audit;")
  LAST_TICK=$(sqlite3 "$DB" "SELECT at FROM system_audit WHERE event='dispatch.tick' ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo "")
  LAST_SUCCESS=$(sqlite3 "$DB" "SELECT at, json_extract(payload,'\$.taskId') FROM system_audit WHERE event='task.completed' ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo "")
  DAY_AGO=$(date -u -v -1d "+%Y-%m-%dT%H:%M:%S")
  FAILURES_24H=$(sqlite3 "$DB" "SELECT COUNT(*) FROM system_audit WHERE event='task.failed' AND at > '$DAY_AGO';")

  ok "$TOTAL audit rows"
  if [[ -n "$LAST_TICK" ]]; then
    info "last tick:    $LAST_TICK"
  else
    info "last tick:    never"
  fi
  if [[ -n "$LAST_SUCCESS" ]]; then
    info "last success: $LAST_SUCCESS"
  else
    info "last success: never"
  fi
  if [[ "$FAILURES_24H" -gt 0 ]]; then
    warn "failures in last 24h: $FAILURES_24H"
  else
    ok "0 failures in last 24h"
  fi

  # Verify the hash chain quickly (Python — same logic as ./nyx-audit.sh --chain).
  if python3 - "$DB" <<'PY' >/dev/null 2>&1
import hashlib, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
cur = db.execute("SELECT at,event,actor,payload,row_hash,prev_hash FROM system_audit ORDER BY id")
expected = "0" * 64
for r in cur:
    at,event,actor,payload,row_hash,prev_hash = r
    if prev_hash != expected: sys.exit(2)
    h = hashlib.sha256(f"{at}\n{event}\n{actor}\n{payload}\n{prev_hash}".encode()).hexdigest()
    if h != row_hash: sys.exit(2)
    expected = row_hash
PY
  then
    ok "hash chain intact"
  else
    bad "HASH CHAIN BROKEN — run ./scripts/nyx-audit.sh --chain to find the break"
  fi
else
  warn "audit db does not exist yet — first tick will create it"
fi

# queue
printf "\n\033[1mqueue\033[0m\n"
if [[ -f "$QUEUE" ]]; then
  STATS=$(awk '
    function flush() {
      if (pending == "") return
      if (pending_sec == "active") {
        if (match(pending, /\[slot: *[0-9]+\]/)) slot_n++
        else if (match(pending, /\[every: *[^]]+\]/)) every_n++
        else standing_n++
        active_n++
      } else if (pending_sec == "completed") completed_n++
      pending = ""
    }
    BEGIN { active_n = 0; standing_n = 0; slot_n = 0; every_n = 0; completed_n = 0; section = "none"; in_comment = 0 }
    {
      if (in_comment) { if ($0 ~ /-->/) in_comment = 0; next }
      if ($0 ~ /^<!--/) { if ($0 !~ /-->/) in_comment = 1; next }
      if ($0 ~ /^## Active Tasks/) { flush(); section = "active"; next }
      if ($0 ~ /^## Completed/)    { flush(); section = "completed"; next }
      if ($0 ~ /^## /)             { flush(); section = "none"; next }
      if (section == "none") next
      if ($0 ~ /^- \[[ xX]\] /) {
        flush(); pending = $0; pending_sec = section
      } else if (pending != "") {
        pending = pending " " $0
      }
    }
    END {
      flush()
      printf "%d|%d|%d|%d|%d", active_n, slot_n, every_n, standing_n, completed_n
    }
  ' "$QUEUE")
  IFS='|' read -r ACTIVE SLOTS EVERYS STANDING COMPLETED <<< "$STATS"
  ok "$ACTIVE active  ($SLOTS slot-bound, $EVERYS cadence, $STANDING standing) · $COMPLETED completed"
else
  bad "queue file missing: $QUEUE"
fi

printf "\n"
