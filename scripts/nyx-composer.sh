#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

SUB="${1:-}"
case "$SUB" in
  normalizations)
    shift
    exec node apps/dispatcher/dist/cli/composer-normalizations.js "$@"
    ;;
  ""|--help|-h)
    cat >&2 <<EOF
Usage: nyx composer <subcommand> [args]

  normalizations [--limit N]   review recent SHADOW normalizer output
EOF
    exit 0
    ;;
  *)
    echo "nyx composer: unknown subcommand '$SUB'" >&2
    exit 64
    ;;
esac
