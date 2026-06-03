#!/bin/bash
# get-loki.sh — download Loki-RS malware scanner binary onto the drive
# Drops loki-rs into runtime/<arch>/

VERSION="0.4.0"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLATFORM="$(uname -s)"
MACHINE="$(uname -m)"

if [ "$PLATFORM" = "Darwin" ]; then
  ARCH_DIR="mac-x64"
  [ "$MACHINE" = "arm64" ] && ARCH_DIR="mac-arm64"
  TRIPLE="x86_64-apple-darwin"
  [ "$MACHINE" = "arm64" ] && TRIPLE="aarch64-apple-darwin"
else
  ARCH_DIR="linux-x64"
  [ "$MACHINE" = "aarch64" ] && ARCH_DIR="linux-arm64"
  TRIPLE="x86_64-unknown-linux-musl"
  [ "$MACHINE" = "aarch64" ] && TRIPLE="aarch64-unknown-linux-musl"
fi

RUNTIME_DIR="$DIR/$ARCH_DIR"
TARGET="$RUNTIME_DIR/loki-rs"
FILENAME="loki-rs-$TRIPLE.tar.gz"
URL="https://github.com/Neo23x0/Loki-RS/releases/download/v$VERSION/$FILENAME"
TMP_FILE="$RUNTIME_DIR/_loki_tmp.tar.gz"

if [ -x "$TARGET" ]; then
  echo "  Loki-RS already present at $TARGET"
  exit 0
fi

mkdir -p "$RUNTIME_DIR"
echo "  Downloading Loki-RS v$VERSION for $ARCH_DIR..."
if command -v curl &>/dev/null; then
  curl -L -o "$TMP_FILE" "$URL" || { echo "  Download failed"; exit 1; }
elif command -v wget &>/dev/null; then
  wget -O "$TMP_FILE" "$URL"    || { echo "  Download failed"; exit 1; }
else
  echo "  ERROR: need curl or wget"; exit 1
fi

echo "  Extracting..."
TMP_DIR="$RUNTIME_DIR/_loki_extract"
mkdir -p "$TMP_DIR"
tar -xzf "$TMP_FILE" -C "$TMP_DIR"

BINARY="$(find "$TMP_DIR" -name 'loki-rs' -type f | head -1)"
if [ -n "$BINARY" ]; then
  cp "$BINARY" "$TARGET"
  chmod +x "$TARGET"
else
  echo "  ERROR: loki-rs binary not found in archive"; exit 1
fi
rm -rf "$TMP_DIR" "$TMP_FILE"

echo "  Loki-RS ready at: $TARGET"
"$TARGET" --version 2>/dev/null || true
