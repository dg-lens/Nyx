#!/usr/bin/env bash
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

ARGS=()
SKIP_BUILD=0
for a in "$@"; do
  case "$a" in
    --no-build) SKIP_BUILD=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

if [[ ${#ARGS[@]} -eq 0 ]]; then
  echo "Usage: nyx-resume.sh <TASK-ID> [--note \"free text\"] [--keep-worktree]"
  exit 1
fi

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "→ building dispatcher..."
  pnpm --filter @nyx/dispatcher build >/dev/null
fi

exec node apps/dispatcher/dist/cli/resume.js "${ARGS[@]}"
