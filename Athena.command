#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Request admin (sudo) rights upfront if not already root ---
if [ "$(id -u)" -ne 0 ]; then
  echo "Athena needs administrator rights. Enter your password:"
  sudo -v || { echo "  Admin access denied — some system commands may fail."; }
  # Refresh sudo ticket in background so it doesn't expire mid-session
  (while true; do sudo -n true; sleep 50; done) &
  SUDO_REFRESH_PID=$!
  trap "kill $SUDO_REFRESH_PID 2>/dev/null" EXIT
fi

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
