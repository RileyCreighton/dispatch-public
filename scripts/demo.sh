#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "${1:-}" in
  local) shift; exec python3 scripts/demo-native.py "$@" ;;
  *) exec python3 scripts/demo.py "$@" ;;
esac
