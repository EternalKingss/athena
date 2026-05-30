#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCH="linux-x64"
[ "$(uname -m)" = "aarch64" ] && ARCH="linux-arm64"
NODE="$DIR/runtime/$ARCH/bin/node"
if [ ! -x "$NODE" ]; then
  echo ""
  echo "  Portable Node not found at: $NODE"
  echo "  See README.md - put the Linux Node build into runtime/$ARCH/"
  echo ""
  exit 1
fi
"$NODE" --no-warnings "$DIR/athena/athena.mjs" --ui
