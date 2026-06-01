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
