#!/usr/bin/env bash
# nyx-tick: force a manual dispatcher tick now.
#
# Usage:  ./scripts/nyx-tick.sh [--no-build]
#
# By default this rebuilds the dispatcher first (in case sources changed), then
# runs one tick. The lockfile prevents collisions with a launchd-driven tick.
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "→ building dispatcher..."
  pnpm --filter @nyx/dispatcher build >/dev/null
fi

echo "→ running one tick..."
exec node apps/dispatcher/dist/cli/run-once.js
