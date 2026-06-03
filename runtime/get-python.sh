#!/bin/bash
# get-python.sh — download python-build-standalone onto the drive (no host install)
# Drops portable Python into runtime/<arch>/python/

VERSION="3.13.3"
DATE="20250517"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Detect platform + arch
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
  TRIPLE="x86_64-unknown-linux-gnu"
  [ "$MACHINE" = "aarch64" ] && TRIPLE="aarch64-unknown-linux-gnu"
fi

RUNTIME_DIR="$DIR/$ARCH_DIR"
TARGET_DIR="$RUNTIME_DIR/python"
FILENAME="cpython-$VERSION+$DATE-$TRIPLE-install_only.tar.gz"
URL="https://github.com/indygreg/python-build-standalone/releases/download/$DATE/$FILENAME"
TMP_FILE="$RUNTIME_DIR/_python_tmp.tar.gz"
TMP_DIR="$RUNTIME_DIR/_python_extract"

# Always clean up temp files, even on error or Ctrl+C
trap 'rm -f "$TMP_FILE"; rm -rf "$TMP_DIR"' EXIT

if [ -x "$TARGET_DIR/bin/python3" ]; then
  echo "  Portable Python already present at $TARGET_DIR"
  exit 0
fi

mkdir -p "$RUNTIME_DIR"
echo "  Downloading Python $VERSION for $ARCH_DIR..."
if command -v curl &>/dev/null; then
  curl -L -o "$TMP_FILE" "$URL" || { echo "  Download failed"; exit 1; }
elif command -v wget &>/dev/null; then
  wget -O "$TMP_FILE" "$URL"    || { echo "  Download failed"; exit 1; }
else
  echo "  ERROR: need curl or wget"; exit 1
fi

echo "  Extracting..."
mkdir -p "$TMP_DIR"
tar -xzf "$TMP_FILE" -C "$TMP_DIR"

EXTRACTED="$TMP_DIR/python"
if [ -d "$EXTRACTED" ]; then
  rm -rf "$TARGET_DIR"
  mv "$EXTRACTED" "$TARGET_DIR"
else
  echo "  ERROR: unexpected archive structure"; exit 1
fi

echo "  Portable Python ready at: $TARGET_DIR/bin/python3"
"$TARGET_DIR/bin/python3" --version
