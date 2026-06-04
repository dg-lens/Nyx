#!/usr/bin/env bash
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

echo "Nyx bootstrap — $NYX_ROOT"

for d in data logs outputs worktrees context inbox/rotation-events; do
  mkdir -p "$NYX_ROOT/$d"
done
echo "  runtime dirs ready"

if [[ -f "$NYX_ROOT/.env" ]]; then
  echo "  .env exists (left as-is)"
else
  cp "$NYX_ROOT/.env.example" "$NYX_ROOT/.env"
  echo "  .env created from .env.example — edit it before 'nyx up'"
fi

if [[ -f "$NYX_ROOT/nyx.md" ]]; then
  echo "  nyx.md exists (left as-is)"
else
  cp "$NYX_ROOT/nyx.md.example" "$NYX_ROOT/nyx.md"
  echo "  nyx.md seeded from nyx.md.example"
fi

TEMPLATE="$NYX_ROOT/config/launchd/com.nyx.dispatcher.plist.template"
PLIST="$NYX_ROOT/config/launchd/com.nyx.dispatcher.plist"
sed -e "s#__NYX_ROOT__#${NYX_ROOT}#g" -e "s#__NYX_HOME__#${HOME}#g" "$TEMPLATE" > "$PLIST"
echo "  launchd plist generated for this machine"

echo "  building (pnpm install + build)…"
pnpm install --prefer-offline
pnpm -r build

echo
echo "Bootstrap complete. Next:"
echo "  1. Edit $NYX_ROOT/.env — set GIT_AUTHOR_NAME/EMAIL; set ANTHROPIC_API_KEY"
echo "     for pay-per-token billing, or leave it empty to use the host's ~/.claude OAuth."
echo "  2. nyx up        (load the dispatcher into launchd)"
echo "  3. nyx status    (confirm it is running)"
