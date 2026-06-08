#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

if [ ! -d "$NYX_REPO_ROOT/.git" ]; then
  echo "Nyx core at $NYX_REPO_ROOT is a Homebrew keg, not a git checkout."
  echo "Self-update doesn't apply — update via Homebrew instead:"
  echo
  echo "  brew uninstall nyx && brew install --HEAD dg-lens/nyx/nyx && nyx app"
  echo
  echo "Data ($NYX_DATA_DIR) and Plugins ($NYX_PLUGINS_DIR) are left untouched."
  exit 0
fi

cd "$NYX_REPO_ROOT"
echo "Updating Nyx core — $NYX_REPO_ROOT"
git fetch origin
git reset --hard origin/main
git clean -fd
pnpm install --prefer-offline
pnpm -r build
echo
echo "Core reverted to stock origin/main and rebuilt."
echo "Data ($NYX_DATA_DIR) and Plugins ($NYX_PLUGINS_DIR) were not touched."
