#!/usr/bin/env bash
set -euo pipefail

NYX_ROOT="${NYX_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$NYX_ROOT"

exec node apps/dispatcher/dist/cli/pipeline.js "$@"
