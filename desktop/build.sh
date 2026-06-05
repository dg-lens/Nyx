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

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$NAME</string>
    <key>CFBundleDisplayName</key><string>$NAME</string>
    <key>CFBundleExecutable</key><string>NyxDesktop</string>
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
