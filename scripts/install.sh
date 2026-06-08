#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew required: https://brew.sh" >&2
  exit 1
fi

brew tap dg-lens/nyx https://github.com/dg-lens/Nyx 2>/dev/null || true
brew install --HEAD dg-lens/nyx/nyx
nyx bootstrap

echo
echo "Nyx installed (Core in the keg; Data + Plugins under ~/Nyx). Next:"
echo "  1) Auth — this box needs Claude Code logged in (Max plan) so spawned 'claude -p'"
echo "     uses OAuth, OR set ANTHROPIC_API_KEY in ~/Nyx/Data/.env for API billing."
echo "  2) Co-located box (already running other claude workers)? add to ~/Nyx/Data/settings.json:"
echo '       { "dispatcher": { "concurrencyGuard": "own" } }'
echo "  3) Start:  brew services start dg-lens/nyx/nyx    (or: nyx up)"
echo "  4) Verify: nyx status"
echo "  5) Update later: brew uninstall nyx && brew install --HEAD dg-lens/nyx/nyx"
