#!/usr/bin/env bash
set -euo pipefail

NYX_REPO_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
if [ "$(basename "$NYX_REPO_ROOT")" = "Core" ]; then
  BASE="$(cd "$NYX_REPO_ROOT/.." && pwd)"
  NYX_DATA_DIR="${NYX_DATA_DIR:-$BASE/Data}"
  NYX_PLUGINS_DIR="${NYX_PLUGINS_DIR:-$BASE/Plugins}"
else
  NYX_DATA_DIR="${NYX_DATA_DIR:-$NYX_REPO_ROOT}"
  NYX_PLUGINS_DIR="${NYX_PLUGINS_DIR:-$NYX_REPO_ROOT/Plugins}"
fi

echo "Nyx bootstrap"
echo "  Core:    $NYX_REPO_ROOT"
echo "  Data:    $NYX_DATA_DIR"
echo "  Plugins: $NYX_PLUGINS_DIR"

mkdir -p "$NYX_PLUGINS_DIR"
for d in data logs outputs worktrees context inbox/rotation-events memory documents; do
  mkdir -p "$NYX_DATA_DIR/$d"
done
echo "  data + plugin dirs ready"

if [[ -f "$NYX_DATA_DIR/.env" ]]; then
  echo "  .env exists (left as-is)"
elif [[ -f "$NYX_REPO_ROOT/.env.example" ]]; then
  cp "$NYX_REPO_ROOT/.env.example" "$NYX_DATA_DIR/.env"
  echo "  .env created from .env.example — edit it before 'nyx up'"
else
  printf 'NAME=nyx\nOPERATOR_NAME=\nGIT_AUTHOR_NAME=\nGIT_AUTHOR_EMAIL=\nANTHROPIC_API_KEY=\nGITHUB_TOKEN=\n' > "$NYX_DATA_DIR/.env"
  echo "  .env.example not found in Core — wrote a minimal .env; fill it in before 'nyx up'"
fi

if [[ -f "$NYX_DATA_DIR/nyx.md" ]]; then
  echo "  nyx.md exists (left as-is)"
else
  cp "$NYX_REPO_ROOT/nyx.md.example" "$NYX_DATA_DIR/nyx.md"
  echo "  nyx.md seeded from nyx.md.example"
fi

TEMPLATE="$NYX_REPO_ROOT/config/launchd/com.nyx.dispatcher.plist.template"
PLIST="$NYX_DATA_DIR/com.nyx.dispatcher.plist"
sed -e "s#__NYX_REPO_ROOT__#${NYX_REPO_ROOT}#g" \
    -e "s#__NYX_DATA_DIR__#${NYX_DATA_DIR}#g" \
    -e "s#__NYX_PLUGINS_DIR__#${NYX_PLUGINS_DIR}#g" \
    -e "s#__NYX_HOME__#${HOME}#g" \
    "$TEMPLATE" > "$PLIST"
echo "  launchd plist generated → $PLIST"

HOST_TEMPLATE="$NYX_REPO_ROOT/config/launchd/com.nyx.host.plist.template"
HOST_PLIST="$NYX_DATA_DIR/com.nyx.host.plist"
sed -e "s#__NYX_REPO_ROOT__#${NYX_REPO_ROOT}#g" \
    -e "s#__NYX_DATA_DIR__#${NYX_DATA_DIR}#g" \
    -e "s#__NYX_PLUGINS_DIR__#${NYX_PLUGINS_DIR}#g" \
    -e "s#__NYX_HOME__#${HOME}#g" \
    "$HOST_TEMPLATE" > "$HOST_PLIST"
echo "  host plist generated → $HOST_PLIST"

echo "  building (pnpm install + build)…"
(cd "$NYX_REPO_ROOT" && pnpm install --prefer-offline && pnpm -r build)

APP_OK=0
echo "  building desktop app…"
if NYX_REPO_ROOT="$NYX_REPO_ROOT" NYX_DATA_DIR="$NYX_DATA_DIR" bash "$NYX_REPO_ROOT/scripts/nyx-app.sh" --no-open; then
  APP_OK=1
else
  echo "  desktop app skipped — install Xcode CLT (xcode-select --install), then run 'nyx app'"
fi

echo
echo "Bootstrap complete."
if [ "$APP_OK" = "1" ]; then
  echo
  echo "Desktop app → /Applications. Open it and use the Settings tab to set secrets,"
  echo "choose the concurrency guard, and start the daemon — no terminal needed."
fi
echo
echo "CLI alternative:"
echo "  1. Edit $NYX_DATA_DIR/.env — set GIT_AUTHOR_NAME/EMAIL; set ANTHROPIC_API_KEY"
echo "     for pay-per-token billing, or leave empty to use the host's ~/.claude OAuth."
echo "  2. nyx up        (load the dispatcher into launchd)"
echo "  3. nyx status    (confirm it is running)"
