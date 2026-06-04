#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DNS_BACKUP="$DIR/data/.dns_backup"

# --- Request admin (sudo) rights upfront if not already root ---
if [ "$(id -u)" -ne 0 ]; then
  echo "Athena needs administrator rights. Enter your password:"
  sudo -v || { echo "  Admin access denied — some system commands may fail."; }
  (while true; do sudo -n true; sleep 50; done) &
  SUDO_REFRESH_PID=$!
fi

# --- DNS: switch to AdGuard ad-blocking DNS ---
apply_dns() {
  # NetworkManager (Mint, Ubuntu, most modern Linux)
  if command -v nmcli &>/dev/null; then
    CONN=$(nmcli -t -f NAME con show --active 2>/dev/null | head -1)
    if [ -n "$CONN" ]; then
      ORIG_DNS=$(nmcli -t -f ipv4.dns con show "$CONN" 2>/dev/null | cut -d: -f2 | xargs)
      ORIG_IGNORE=$(nmcli -t -f ipv4.ignore-auto-dns con show "$CONN" 2>/dev/null | cut -d: -f2 | xargs)
      printf 'nm|%s|%s|%s\n' "$CONN" "$ORIG_DNS" "$ORIG_IGNORE" > "$DNS_BACKUP"
      sudo nmcli con mod "$CONN" ipv4.dns "94.140.14.14,94.140.15.15" ipv4.ignore-auto-dns yes 2>/dev/null
      sudo nmcli con up "$CONN" &>/dev/null
      echo "  [dns] AdGuard DNS active — ad blocking on"
      return
    fi
  fi
  # systemd-resolved
  if command -v resolvectl &>/dev/null; then
    IFACE=$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')
    if [ -n "$IFACE" ]; then
      ORIG=$(resolvectl dns "$IFACE" 2>/dev/null | awk -F': ' '{print $2}')
      printf 'resolved|%s|%s\n' "$IFACE" "$ORIG" > "$DNS_BACKUP"
      sudo resolvectl dns "$IFACE" 94.140.14.14 94.140.15.15 2>/dev/null
      sudo resolvectl domain "$IFACE" '~.' 2>/dev/null
      echo "  [dns] AdGuard DNS active — ad blocking on"
      return
    fi
  fi
  # Fallback: resolv.conf directly
  if [ -f /etc/resolv.conf ] && [ ! -L /etc/resolv.conf ]; then
    printf 'resolv\n' > "$DNS_BACKUP"
    sudo cp /etc/resolv.conf "$DIR/data/.resolv.conf.bak"
    printf 'nameserver 94.140.14.14\nnameserver 94.140.15.15\n' | sudo tee /etc/resolv.conf >/dev/null
    echo "  [dns] AdGuard DNS active — ad blocking on"
    return
  fi
  echo "  [dns] Could not set DNS automatically on this machine"
}

restore_dns() {
  [ -f "$DNS_BACKUP" ] || return
  METHOD=$(head -1 "$DNS_BACKUP" | cut -d'|' -f1)
  case "$METHOD" in
    nm)
      IFS='|' read -r _ CONN ORIG_DNS ORIG_IGNORE < "$DNS_BACKUP"
      if [ -z "$ORIG_DNS" ] || [ "$ORIG_DNS" = "--" ] || [ "$ORIG_DNS" = "" ]; then
        sudo nmcli con mod "$CONN" ipv4.dns "" ipv4.ignore-auto-dns no 2>/dev/null
      else
        sudo nmcli con mod "$CONN" ipv4.dns "$ORIG_DNS" 2>/dev/null
        [ "$ORIG_IGNORE" = "yes" ] || sudo nmcli con mod "$CONN" ipv4.ignore-auto-dns no 2>/dev/null
      fi
      sudo nmcli con up "$CONN" &>/dev/null
      ;;
    resolved)
      IFS='|' read -r _ IFACE ORIG < "$DNS_BACKUP"
      if [ -n "$ORIG" ]; then
        sudo resolvectl dns "$IFACE" $ORIG 2>/dev/null
      else
        sudo resolvectl revert "$IFACE" 2>/dev/null
      fi
      ;;
    resolv)
      [ -f "$DIR/data/.resolv.conf.bak" ] && sudo cp "$DIR/data/.resolv.conf.bak" /etc/resolv.conf
      rm -f "$DIR/data/.resolv.conf.bak"
      ;;
  esac
  rm -f "$DNS_BACKUP"
  echo "  [dns] DNS restored"
}

apply_dns

# --- Cleanup on exit ---
cleanup() {
  restore_dns
  [ -n "$SUDO_REFRESH_PID" ] && kill "$SUDO_REFRESH_PID" 2>/dev/null
}
trap cleanup EXIT

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
