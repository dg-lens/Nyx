#!/usr/bin/env bash
# nyx-slots: 96-slot day visualization showing what's bound to each slot
# and which tasks fired today.
#
# Usage:  ./scripts/nyx-slots.sh
#
# Slot N covers wall-clock [N*15 min, (N+1)*15 min). Current slot is highlighted.
# Slot-bound tasks: shown at their fixed slot. Every-K tasks: shown at every slot
# that's a multiple of K. Fired-today: marked with ⏺.
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
QUEUE="$NYX_ROOT/nyx.md"
DB="$NYX_ROOT/data/nyx.db"

if [[ ! -f "$QUEUE" ]]; then
  echo "queue not found: $QUEUE" >&2
  exit 1
fi

NOW_SLOT=$(date "+%-H %-M" | awk '{ print $1*4 + int($2/15) }')

# Step 1: extract slot/every assignments from the queue.
# Output one line per (slot, taskId, kind) where kind is "fixed" or "every".
BINDINGS=$(awk '
function get_tag(text, name,    re, val) {
  re = "\\[" name ": *[^]]+\\]"
  if (match(text, re)) {
    val = substr(text, RSTART, RLENGTH)
    sub("^\\[" name ": *", "", val)
    sub(/\]$/, "", val)
    return val
  }
  return ""
}
function every_to_slots(every_str,    n, unit, step) {
  # Returns step in slot units (15-min). Returns 0 if unparseable.
  if (match(every_str, /^[0-9]+(m|h|d)$/)) {
    s = substr(every_str, RSTART, RLENGTH)
    if (match(s, /m$/)) {
      n = s; sub(/m$/, "", n) + 0
      return (n % 15 == 0) ? (n / 15) : 0
    } else if (match(s, /h$/)) {
      n = s; sub(/h$/, "", n) + 0
      return n * 4
    } else if (match(s, /d$/)) {
      n = s; sub(/d$/, "", n) + 0
      return n * 96
    }
  }
  return 0
}
function flush() {
  if (pending_id == "") return
  if (pending_section == "active") {
    slot_v = get_tag(pending_tags, "slot")
    every_v = get_tag(pending_tags, "every")
    type_v = get_tag(pending_tags, "type"); if (type_v == "") type_v = "?"
    if (slot_v != "") {
      printf "%d|%s|%s|fixed\n", slot_v+0, pending_id, type_v
    } else if (every_v != "") {
      step = every_to_slots(every_v)
      if (step > 0) {
        for (s = 0; s < 96; s += step) {
          printf "%d|%s|%s|every-%s\n", s, pending_id, type_v, every_v
        }
      }
    }
  }
  pending_id = ""; pending_tags = ""
}
BEGIN { section = "none"; in_comment = 0 }
{
  if (in_comment) { if ($0 ~ /-->/) in_comment = 0; next }
  if ($0 ~ /^<!--/) { if ($0 !~ /-->/) in_comment = 1; next }
  if ($0 ~ /^## Active Tasks/)      { flush(); section = "active"; next }
  if ($0 ~ /^## Completed/)         { flush(); section = "completed"; next }
  if ($0 ~ /^## /)                  { flush(); section = "none"; next }
  if (section != "active") next
  if ($0 ~ /^- \[[ xX]\] /) {
    flush()
    pending_section = section
    rest = $0; sub(/^- \[[ xX]\] /, "", rest)
    pending_id = rest; sub(/[ ]+[—-].*$/, "", pending_id)
    pending_tags = ""
  } else if (pending_id != "") {
    pending_tags = pending_tags " " $0
  }
}
END { flush() }
' "$QUEUE")

# Step 2: which task ids fired today (completed or failed in [today 00:00, now])?
FIRED_TODAY=""
if [[ -f "$DB" ]]; then
  TODAY_UTC_START=$(date -j -v0H -v0M -v0S "+%Y-%m-%dT%H:%M:%S")
  FIRED_TODAY=$(sqlite3 "$DB" "
    SELECT DISTINCT json_extract(payload, '\$.taskId')
    FROM system_audit
    WHERE event IN ('task.completed','task.failed')
      AND at >= '${TODAY_UTC_START}'
      AND json_extract(payload, '\$.taskId') IS NOT NULL;
  " 2>/dev/null || true)
fi

printf "\n\033[1mSlot grid — current slot: %d  (now %s)\033[0m\n" "$NOW_SLOT" "$(date '+%H:%M')"
printf "\n"

for slot in $(seq 0 95); do
  hour=$((slot / 4))
  min=$(((slot % 4) * 15))
  wall=$(printf "%02d:%02d" "$hour" "$min")

  bindings=$(echo "$BINDINGS" | awk -F'|' -v s="$slot" '$1 == s { print $2 " (" $3 ") " $4 }')

  if [[ -z "$bindings" ]]; then
    if [[ "$slot" -eq "$NOW_SLOT" ]]; then
      printf "  \033[33m▶\033[0m %s  slot %2d   \033[2m(empty — would pull from standing list)\033[0m\n" "$wall" "$slot"
    fi
    continue
  fi

  marker="  "
  if [[ "$slot" -eq "$NOW_SLOT" ]]; then marker="\033[33m▶ \033[0m"; fi

  first=1
  echo "$bindings" | while IFS= read -r b; do
    task_id=$(echo "$b" | cut -d' ' -f1)
    fired=""
    if [[ "$FIRED_TODAY" == *"$task_id"* ]]; then fired=" \033[32m⏺\033[0m"; fi
    if [[ $first -eq 1 ]]; then
      printf "%b%s  slot %2d   %s%b\n" "$marker" "$wall" "$slot" "$b" "$fired"
      first=0
    else
      printf "             %s%b\n" "$b" "$fired"
    fi
  done
done

printf "\n\033[2m▶ current slot   ⏺ already fired today\033[0m\n"
