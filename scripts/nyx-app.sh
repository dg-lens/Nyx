#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

OPEN=1
for a in "$@"; do
  [ "$a" = "--no-open" ] && OPEN=0
done

DESKTOP_DIR="$NYX_REPO_ROOT/desktop"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "nyx app: Xcode Command Line Tools are required to build the desktop app." >&2
  echo "  Install them with:  xcode-select --install" >&2
  exit 1
fi

if [[ ! -f "$DESKTOP_DIR/build.sh" ]]; then
  echo "nyx app: desktop sources not found at $DESKTOP_DIR" >&2
  exit 1
fi

NAME="$(grep -E '^NAME=' "$NYX_DATA_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
NAME="${NAME//\"/}"
NAME="${NAME//\'/}"
NAME="${NAME// /}"
NAME="${NAME:-Nyx}"

echo "Building $NAME.app from $DESKTOP_DIR ..."
NYX_DATA_DIR="$NYX_DATA_DIR" bash "$DESKTOP_DIR/build.sh"

APP="$DESKTOP_DIR/$NAME.app"
if [[ ! -d "$APP" ]]; then
  echo "nyx app: build did not produce $APP" >&2
  exit 1
fi

DEST="/Applications/$NAME.app"
rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

echo "Installed $DEST"
if [ "$OPEN" = "1" ]; then
  open "$DEST"
fi
