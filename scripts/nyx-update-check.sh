#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -uo pipefail

REMOTE_URL="https://github.com/dg-lens/Nyx.git"

local_sha=""
if [ -d "$NYX_REPO_ROOT/.git" ]; then
  local_sha="$(git -C "$NYX_REPO_ROOT" rev-parse --short=7 HEAD 2>/dev/null || true)"
else
  real="$(cd "$NYX_REPO_ROOT" 2>/dev/null && pwd -P || true)"
  if [ -n "$real" ]; then
    keg="$(basename "$(dirname "$real")")"
    case "$keg" in HEAD-*) local_sha="${keg#HEAD-}";; esac
  fi
fi
local_sha="${local_sha:0:7}"

TO=""
if command -v timeout >/dev/null 2>&1; then
  TO="timeout 5"
elif command -v gtimeout >/dev/null 2>&1; then
  TO="gtimeout 5"
fi

remote_full="$(GIT_TERMINAL_PROMPT=0 $TO git ls-remote "$REMOTE_URL" refs/heads/main 2>/dev/null | awk 'NR==1{print $1}')"
remote_sha="${remote_full:0:7}"

if [ -z "$local_sha" ] || [ -z "$remote_sha" ]; then
  echo "unknown ${local_sha:-?} ${remote_sha:-?}"
  exit 20
fi
if [ "$local_sha" = "$remote_sha" ]; then
  echo "up-to-date $local_sha $remote_sha"
  exit 0
fi
echo "update-available $local_sha $remote_sha"
exit 10
