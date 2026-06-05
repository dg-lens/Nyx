#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="$(xcrun --show-sdk-path)"
ARCH="$(uname -m)"
DATA_DIR="${NYX_DATA_DIR:-$HOME/Nyx/Data}"

NAME="$(grep -E '^NAME=' "$DATA_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
NAME="${NAME//\"/}"
NAME="${NAME//\'/}"
NAME="${NAME// /}"
NAME="${NAME:-Nyx}"

APP="$HERE/$NAME.app"
MACOS="$APP/Contents/MacOS"
BIN="$MACOS/NyxDesktop"

rm -rf "$HERE"/*.app
mkdir -p "$MACOS"

swiftc -O -parse-as-library -swift-version 5 \
  -sdk "$SDK" -target "${ARCH}-apple-macos13.0" \
  $(find "$HERE/Sources" -name '*.swift') \
  -o "$BIN"

LOGO="$DATA_DIR/logo.png"
if [ -f "$LOGO" ]; then
  mkdir -p "$APP/Contents/Resources"
  WORK="$(mktemp -d)"
  CLEAN="$WORK/clean.png"
  sips -s format png "$LOGO" --out "$CLEAN" >/dev/null 2>&1 || cp "$LOGO" "$CLEAN"
  ICONSET="$WORK/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz" "$CLEAN" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
    dbl=$((sz * 2))
    sips -z "$dbl" "$dbl" "$CLEAN" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null 2>&1 || true
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$NAME</string>
    <key>CFBundleDisplayName</key><string>$NAME</string>
    <key>CFBundleExecutable</key><string>NyxDesktop</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundleIdentifier</key><string>cx.lens.nyx.desktop</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "built $APP"
echo "run:  open '$APP'"
