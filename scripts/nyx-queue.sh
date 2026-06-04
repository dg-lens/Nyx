#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
QUEUE="$NYX_DATA_DIR/nyx.md"
SHOW_COMPLETED=0
[[ "${1:-}" == "--all" ]] && SHOW_COMPLETED=1

if [[ ! -f "$QUEUE" ]]; then
  echo "queue not found: $QUEUE" >&2
  exit 1
fi

awk -v show_completed="$SHOW_COMPLETED" '
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

function flush() {
  if (pending_id == "") return
  type = get_tag(pending_tags, "type"); if (type == "") type = "?"
  prio = get_tag(pending_tags, "priority"); if (prio == "") prio = "normal"
  model = get_tag(pending_tags, "model"); if (model == "") model = "-"
  slot_v = get_tag(pending_tags, "slot")
  every_v = get_tag(pending_tags, "every")
  gate_v = get_tag(pending_tags, "gate"); if (gate_v == "") gate_v = "-"
  if (slot_v != "")       { sched = "slot " slot_v; bucket = "slotted" }
  else if (every_v != "") { sched = "every " every_v; bucket = "cadence" }
  else                    { sched = "standing"; bucket = "standing" }

  marker = (pending_checked == "x") ? "x" : " "
  desc_short = pending_desc
  if (length(desc_short) > 56) desc_short = substr(desc_short, 1, 53) "..."

  row = sprintf("  [%s] %-22s  %-10s  %-7s  %-7s  %-14s  %s", \
                marker, pending_id, type, prio, model, sched, desc_short)
  printf "%s|%s|%s\n", bucket, pending_section, row

  pending_id = ""; pending_desc = ""; pending_tags = ""; pending_checked = " "
}

BEGIN { in_comment = 0; section = "none" }
{
  line = $0
  if (in_comment) {
    if (line ~ /-->/) in_comment = 0
    next
  }
  if (line ~ /^<!--/) {
    if (line !~ /-->/) in_comment = 1
    next
  }
  if (line ~ /^## Active Tasks/)         { flush(); section = "active"; next }
  if (line ~ /^## Completed/)            { flush(); section = "completed"; next }
  if (line ~ /^## /)                     { flush(); section = "none"; next }
  if (section == "none") next

  if (line ~ /^- \[[ xX]\] /) {
    flush()
    pending_section = section
    pending_checked = tolower(substr(line, 4, 1))
    rest = line
    sub(/^- \[[ xX]\] /, "", rest)
    pending_id = rest
    sub(/[ ]+[—-].*$/, "", pending_id)
    em_idx = index(rest, " — ")
    en_idx = index(rest, " – ")
    hy_idx = index(rest, " - ")
    if      (em_idx > 0) pending_desc = substr(rest, em_idx + 5)
    else if (en_idx > 0) pending_desc = substr(rest, en_idx + 5)
    else if (hy_idx > 0) pending_desc = substr(rest, hy_idx + 3)
    else                 pending_desc = rest
    pending_tags = ""
  } else if (pending_id != "") {
    pending_tags = pending_tags " " line
    pending_desc = pending_desc " " line
  }
}
END { flush() }
' "$QUEUE" | sort -t'|' -k2,2 -k1,1 -k3,3 | awk -F'|' -v show_completed="$SHOW_COMPLETED" '
BEGIN { last_section = ""; last_bucket = "" }
{
  section = $1; bucket = $2; row = $3
  if (section == "completed" && !show_completed) next
  if (section != last_section) {
    printf "\n\033[1m── %s ──\033[0m\n", toupper(section)
    last_section = section
    last_bucket = ""
  }
  if (bucket != last_bucket) {
    printf "\n\033[2m%s\033[0m\n", bucket
    last_bucket = bucket
  }
  print row
}
END { printf "\n" }
'
