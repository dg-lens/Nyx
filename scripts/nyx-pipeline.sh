#!/usr/bin/env bash
source "$(dirname "$0")/_layout.sh"
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

exec node apps/dispatcher/dist/cli/pipeline.js "$@"
