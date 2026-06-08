#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

WANT_APP=0
for a in "$@"; do
  [ "$a" = "--app" ] && WANT_APP=1
done

if [ ! -d "$NYX_REPO_ROOT/.git" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Nyx core at $NYX_REPO_ROOT is a Homebrew keg but 'brew' is not on PATH." >&2
    echo "Update manually:  brew uninstall nyx && brew install --HEAD dg-lens/nyx/nyx" >&2
    exit 1
  fi

  LOG="$NYX_DATA_DIR/logs/update.log"
  mkdir -p "$NYX_DATA_DIR/logs"

  APP_STEP=""
  [ "$WANT_APP" = "1" ] && APP_STEP='nyx app || echo "nyx app failed (build the desktop app manually with: nyx app)"'

  echo "Nyx is a Homebrew keg — updating to latest origin/main HEAD via Homebrew."
  echo "Running detached so the update survives the keg being replaced mid-run."
  echo "  log:    $LOG"
  echo "  follow: tail -f \"$LOG\""
  [ "$WANT_APP" = "1" ] && echo "  will also rebuild the desktop app when done."

  nohup bash -c "
    set -x
    echo \"nyx update started: \$(date)\"
    brew uninstall nyx || true
    brew install --HEAD dg-lens/nyx/nyx
    $APP_STEP
    echo \"nyx update finished: \$(date)\"
  " >"$LOG" 2>&1 &
  disown
  echo
  echo "Update launched. The launchd dispatcher resolves through the opt symlink, so it"
  echo "picks up the new code automatically once the install finishes (no reload needed)."
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
[ "$WANT_APP" = "1" ] && bash "$NYX_REPO_ROOT/scripts/nyx-app.sh"
echo
echo "Core reverted to stock origin/main and rebuilt."
echo "Data ($NYX_DATA_DIR) and Plugins ($NYX_PLUGINS_DIR) were not touched."
