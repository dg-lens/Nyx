#!/usr/bin/env bash
_NYX_LAYOUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NYX_REPO_ROOT="${NYX_REPO_ROOT:-$(cd "$_NYX_LAYOUT_DIR/.." && pwd)}"
if [ -z "${NYX_DATA_DIR:-}" ]; then
  if [ -d "$NYX_REPO_ROOT/../Data" ]; then
    NYX_DATA_DIR="$(cd "$NYX_REPO_ROOT/../Data" && pwd)"
  elif [ -d "$HOME/Nyx/Data" ]; then
    NYX_DATA_DIR="$HOME/Nyx/Data"
  else
    NYX_DATA_DIR="$NYX_REPO_ROOT"
  fi
fi
if [ -z "${NYX_PLUGINS_DIR:-}" ]; then
  if [ -d "$NYX_REPO_ROOT/../Plugins" ]; then
    NYX_PLUGINS_DIR="$(cd "$NYX_REPO_ROOT/../Plugins" && pwd)"
  else
    NYX_PLUGINS_DIR="$NYX_REPO_ROOT/../Plugins"
  fi
fi
NYX_ROOT="$NYX_REPO_ROOT"
export NYX_REPO_ROOT NYX_DATA_DIR NYX_PLUGINS_DIR NYX_ROOT
