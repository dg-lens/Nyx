#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

WANT_APP=0
for a in "$@"; do
  [ "$a" = "--app" ] && WANT_APP=1
  [ "$a" = "--check" ] && exec bash "$(dirname "$0")/nyx-update-check.sh"
done

IS_SOURCE_CHECKOUT=0
if [ -d "$NYX_REPO_ROOT/.git" ] && git -C "$NYX_REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
  IS_SOURCE_CHECKOUT=1
fi

if [ "$IS_SOURCE_CHECKOUT" = "0" ]; then
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
    set -euo pipefail
    set -x
    export HOMEBREW_NO_AUTO_UPDATE=1
    echo \"nyx update started: \$(date)\"
    brew trust dg-lens/nyx >/dev/null 2>&1 || true
    MARKER=\"$NYX_DATA_DIR/data/update-failed.marker\"
    KEG_DIR=\$(readlink -f /opt/homebrew/opt/nyx 2>/dev/null || true)
    if [ -z \"\$KEG_DIR\" ] || [ ! -d \"\$KEG_DIR\" ]; then
      echo \"no existing nyx keg to protect — installing fresh\"
      if ! brew install --HEAD dg-lens/nyx/nyx; then
        echo \"fresh install failed\"
        mkdir -p \"$NYX_DATA_DIR/data\"
        tail -n 30 \"$LOG\" >\"\$MARKER\" 2>/dev/null || true
        ls /opt/homebrew/Cellar/nyx/ || true
        exit 1
      fi
    else
      BACKUP=\"\$(dirname \"\$KEG_DIR\")/.nyx-keg-backup.\$\$\"
      if ! cp -R \"\$KEG_DIR\" \"\$BACKUP\"; then
        echo \"FATAL: keg backup failed — refusing to uninstall, system stays kegged\"
        mkdir -p \"$NYX_DATA_DIR/data\"
        tail -n 30 \"$LOG\" >\"\$MARKER\" 2>/dev/null || true
        ls /opt/homebrew/Cellar/nyx/ || true
        exit 1
      fi
      brew uninstall nyx || true
      if brew install --HEAD dg-lens/nyx/nyx && [ -x /opt/homebrew/opt/nyx/bin/nyx-dispatch.sh ]; then
        rm -rf \"\$BACKUP\"
        rm -f \"\$MARKER\"
      else
        echo \"install failed or keg incomplete — restoring backup\"
        cp -R \"\$BACKUP\" \"/opt/homebrew/Cellar/nyx/\$(basename \"\$KEG_DIR\")\" || true
        brew link nyx || brew link --overwrite nyx || true
        rm -rf \"\$BACKUP\"
        mkdir -p \"$NYX_DATA_DIR/data\"
        tail -n 30 \"$LOG\" >\"\$MARKER\" 2>/dev/null || true
        ls /opt/homebrew/Cellar/nyx/ || true
        exit 1
      fi
    fi
    $APP_STEP
    echo \"nyx update finished: \$(date)\"
    ls /opt/homebrew/Cellar/nyx/ || true
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
if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to update: $NYX_REPO_ROOT has uncommitted or untracked changes." >&2
  echo "This update runs 'git reset --hard origin/main' + 'git clean -fd', which would" >&2
  echo "destroy them irrecoverably. Commit or stash your work first:" >&2
  echo "  git -C \"$NYX_REPO_ROOT\" stash push --include-untracked" >&2
  echo "then re-run 'nyx update'." >&2
  exit 1
fi
git fetch origin
git reset --hard origin/main
git clean -fd
pnpm install --prefer-offline
pnpm -r build
[ "$WANT_APP" = "1" ] && bash "$NYX_REPO_ROOT/scripts/nyx-app.sh"
echo
echo "Core reverted to stock origin/main and rebuilt."
echo "Data ($NYX_DATA_DIR) and Plugins ($NYX_PLUGINS_DIR) were not touched."
