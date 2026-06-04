#!/usr/bin/env bash
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "→ building dispatcher..."
  pnpm --filter @nyx/dispatcher build >/dev/null
fi

echo "→ running one tick..."
exec node apps/dispatcher/dist/cli/run-once.js
