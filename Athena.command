#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="mac-x64"
[ "$(uname -m)" = "arm64" ] && ARCH="mac-arm64"
NODE="$DIR/runtime/$ARCH/bin/node"
if [ ! -x "$NODE" ]; then
  echo ""
  echo "  Portable Node not found at: $NODE"
  echo "  See README.md - put the macOS Node build into runtime/$ARCH/"
  echo ""
  read -n 1 -s -r -p "  Press any key to close"
  exit 1
fi
"$NODE" --no-warnings "$DIR/athena/athena.mjs" --ui
