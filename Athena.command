#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DNS_BACKUP="$DIR/data/.dns_backup"

# --- DNS: switch to AdGuard ad-blocking DNS ---
apply_dns() {
  # Find the primary active network service
  SERVICE=$(networksetup -listallnetworkservices 2>/dev/null | grep -v "^\*\|^An asterisk" | while read -r svc; do
    [ "$(networksetup -getnetworkserviceenabled "$svc" 2>/dev/null)" = "Enabled" ] && echo "$svc" && break
  done)
  [ -z "$SERVICE" ] && SERVICE="Wi-Fi"

  ORIG=$(networksetup -getdnsservers "$SERVICE" 2>/dev/null)
  printf 'mac|%s|%s\n' "$SERVICE" "$ORIG" > "$DNS_BACKUP"

  sudo networksetup -setdnsservers "$SERVICE" 94.140.14.14 94.140.15.15 2>/dev/null
  echo "  [dns] AdGuard DNS active — ad blocking on ($SERVICE)"
}

restore_dns() {
  [ -f "$DNS_BACKUP" ] || return
  IFS='|' read -r METHOD SERVICE ORIG < "$DNS_BACKUP"
  if echo "$ORIG" | grep -q "There aren't\|no DNS\|^$"; then
    sudo networksetup -setdnsservers "$SERVICE" "Empty" 2>/dev/null
  else
    sudo networksetup -setdnsservers "$SERVICE" $ORIG 2>/dev/null
  fi
  rm -f "$DNS_BACKUP"
  echo "  [dns] DNS restored"
}

apply_dns
trap restore_dns EXIT

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
