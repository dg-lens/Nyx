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
echo "Nyx installed: Core in the keg, Data + Plugins under ~/Nyx, desktop app in"
echo "/Applications (built by bootstrap if Xcode CLT is present). Next — in the app:"
echo "  1) Open Nyx (Applications). Everything below is in the Settings tab."
echo "  2) Auth — this box needs Claude Code logged in (Max plan) so spawned 'claude -p'"
echo "     uses OAuth, OR set ANTHROPIC_API_KEY (Settings → Environment & Secrets)."
echo "  3) Co-located box (already running other claude workers)?"
echo "     Settings → Dispatcher → Concurrency guard = Own."
echo "  4) Start: Settings → Daemon → Start   (or: nyx up).  Verify: nyx status."
echo "  5) Update later: nyx update"
