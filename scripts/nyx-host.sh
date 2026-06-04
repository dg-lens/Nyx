#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -u

if [ -f "$NYX_DATA_DIR/.env" ]; then
  set -a
  . "$NYX_DATA_DIR/.env"
  set +a
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
cd "$NYX_REPO_ROOT" || exit 1

HOST_DIST="$NYX_REPO_ROOT/apps/dispatcher/dist/cli/host.js"
if [ -f "$HOST_DIST" ]; then
  exec node "$HOST_DIST"
elif command -v pnpm >/dev/null 2>&1; then
  exec pnpm --filter @nyx/dispatcher exec tsx src/cli/host.ts
else
  echo "[nyx-host] not built and pnpm missing" >&2
  exit 1
fi
