#!/bin/bash
# get-loki.sh — install Loki malware scanner using the drive's portable Python
# Run get-python.sh first if you haven't already.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$DIR")"

PLATFORM="$(uname -s)"
MACHINE="$(uname -m)"

if [ "$PLATFORM" = "Darwin" ]; then
  ARCH_DIR="mac-x64"
  [ "$MACHINE" = "arm64" ] && ARCH_DIR="mac-arm64"
else
  ARCH_DIR="linux-x64"
  [ "$MACHINE" = "aarch64" ] && ARCH_DIR="linux-arm64"
fi

PYTHON="$DIR/$ARCH_DIR/python/bin/python3"
PIP="$DIR/$ARCH_DIR/python/bin/pip3"
LOKI_DIR="$ROOT/tools/loki"

if [ ! -x "$PYTHON" ]; then
  echo "  Portable Python not found. Run runtime/get-python.sh first."
  exit 1
fi

if [ -f "$LOKI_DIR/loki.py" ]; then
  echo "  Loki already installed at $LOKI_DIR"
  exit 0
fi

echo "  Cloning Loki..."
mkdir -p "$ROOT/tools"
git clone --depth 1 https://github.com/Neo23x0/Loki "$LOKI_DIR" || {
  echo "  ERROR: git clone failed"; exit 1
}

echo "  Installing dependencies into drive Python..."
"$PIP" install --quiet -r "$LOKI_DIR/requirements.txt" || {
  echo "  ERROR: pip install failed"; exit 1
}

echo ""
echo "  Loki ready. Run a scan:"
echo "    $PYTHON $LOKI_DIR/loki.py --path /target/directory"
echo ""
echo "  First run — update signatures:"
echo "    $PYTHON $LOKI_DIR/loki.py --update"
