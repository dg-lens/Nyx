#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

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
