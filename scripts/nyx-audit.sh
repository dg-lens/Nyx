#!/usr/bin/env bash
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DB="$NYX_ROOT/data/nyx.db"

N=30
EVENT=""
TASKID=""
DO_CHAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) N="$2"; shift 2 ;;
    -e) EVENT="$2"; shift 2 ;;
    -t) TASKID="$2"; shift 2 ;;
    --chain) DO_CHAIN=1; shift ;;
    -h|--help) sed -n '1,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$DB" ]]; then
  echo "audit db not found: $DB" >&2
  exit 1
fi

if [[ $DO_CHAIN -eq 1 ]]; then
  python3 - "$DB" <<'PY'
import hashlib, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
cur = db.execute("SELECT id, at, event, actor, payload, row_hash, prev_hash FROM system_audit ORDER BY id")
expected = "0" * 64
total = 0
for r in cur:
    total += 1
    rid, at, event, actor, payload, row_hash, prev_hash = r
    if prev_hash != expected:
        print(f"BROKEN at row {rid}: prev_hash mismatch (expected {expected[:12]}…, got {prev_hash[:12]}…)")
        sys.exit(2)
    h = hashlib.sha256(f"{at}\n{event}\n{actor}\n{payload}\n{prev_hash}".encode()).hexdigest()
    if h != row_hash:
        print(f"BROKEN at row {rid}: row_hash mismatch")
        sys.exit(2)
    expected = row_hash
print(f"chain OK across {total} rows")
PY
  exit 0
fi

WHERE_CLAUSES=()
PARAMS=()

if [[ -n "$EVENT" ]]; then
  if [[ "$EVENT" == *%* ]]; then
    WHERE_CLAUSES+=("event LIKE '$EVENT'")
  else
    WHERE_CLAUSES+=("event = '$EVENT'")
  fi
fi
if [[ -n "$TASKID" ]]; then
  WHERE_CLAUSES+=("json_extract(payload, '\$.taskId') = '$TASKID'")
fi

WHERE=""
if [[ ${#WHERE_CLAUSES[@]} -gt 0 ]]; then
  WHERE="WHERE $(IFS=' AND '; echo "${WHERE_CLAUSES[*]}")"
fi

sqlite3 -separator $'\t' "$DB" "
  SELECT id, at, event,
         coalesce(json_extract(payload, '\$.taskId'), '-') AS task,
         payload
  FROM system_audit
  $WHERE
  ORDER BY id DESC
  LIMIT $N;
" | awk -F'\t' '
function fmt_time(iso,    t, hms) {
  cmd = "date -j -u -f \"%Y-%m-%dT%H:%M:%S\" \"" substr(iso,1,19) "\" \"+%m-%d %H:%M:%S\" 2>/dev/null"
  cmd | getline t
  close(cmd)
  return (t == "") ? substr(iso, 6, 14) : t
}
function summarize_payload(p,    extras, k, v) {
  extras = ""
  if (match(p, /"exitCode":[0-9]+/))     { extras = extras " exit=" extract_num(p, "exitCode") }
  if (match(p, /"durationMs":[0-9]+/))   { extras = extras " ms=" extract_num(p, "durationMs") }
  if (match(p, /"slot":[0-9]+/))         { extras = extras " slot=" extract_num(p, "slot") }
  if (match(p, /"rows":[0-9]+/))         { extras = extras " rows=" extract_num(p, "rows") }
  if (match(p, /"passed":(true|false)/)) {
    val = substr(p, RSTART, RLENGTH); sub(/"passed":/, "", val); extras = extras " passed=" val
  }
  return extras
}
function extract_num(p, key,    val) {
  re = "\"" key "\":[0-9]+"
  if (match(p, re)) {
    val = substr(p, RSTART, RLENGTH)
    sub("\"" key "\":", "", val)
    return val
  }
  return ""
}
{
  id = $1; at = $2; event = $3; task = $4; payload = $5
  printf "%5s  %s  %-30s  %-22s %s\n", id, fmt_time(at), event, task, summarize_payload(payload)
}
' | tac 2>/dev/null || sqlite3 "$DB" "SELECT id, at, event, json_extract(payload,'\$.taskId') FROM system_audit ${WHERE} ORDER BY id DESC LIMIT $N;"
