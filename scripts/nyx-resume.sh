#!/usr/bin/env bash
# nyx-resume: clear a task.halted_for_review state so the dispatcher will
# pick the task up again on the next tick.
#
# Usage:
#   ./scripts/nyx-resume.sh <TASK-ID> [--note "free text"] [--keep-worktree]
#   ./scripts/nyx-resume.sh --help
#
# By default this rebuilds the dispatcher first (in case sources changed). Pass
# --no-build if you've just built and want to skip the recompile.
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
