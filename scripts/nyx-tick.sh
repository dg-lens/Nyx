#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/Library/pnpm:$HOME/.claude/local:$HOME/.npm-global/bin:/usr/bin:/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  CLAUDE_PATH="$(${SHELL:-/bin/zsh} -lc 'command -v claude' 2>/dev/null | tail -1)"
  if [ -n "$CLAUDE_PATH" ] && [ -x "$CLAUDE_PATH" ]; then
    export PATH="$(dirname "$CLAUDE_PATH"):$PATH"
  fi
fi

if [[ "${1:-}" != "--no-build" ]]; then
  echo "→ building dispatcher..."
  pnpm --filter @nyx/dispatcher build >/dev/null
fi

echo "→ running one tick..."
exec node apps/dispatcher/dist/cli/run-once.js
