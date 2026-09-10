#!/bin/bash
# get-offline.sh -- download llama-server binary + Phi-3.5-mini model for offline AI
# After this runs, Athena works with no internet or API keys.

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLATFORM="$(uname -s)"
MACHINE="$(uname -m)"

# ---- Detect arch dir ----
if [ "$PLATFORM" = "Darwin" ]; then
  ARCH_DIR="mac-x64"
  [ "$MACHINE" = "arm64" ] && ARCH_DIR="mac-arm64"
else
  ARCH_DIR="linux-x64"
  [ "$MACHINE" = "aarch64" ] && ARCH_DIR="linux-arm64"
fi

LLAMA_DIR="$DIR/$ARCH_DIR/llama"
LLAMA_BIN="$LLAMA_DIR/llama-server"
MODELS_DIR="$DIR/models"
MODEL_FILE="$MODELS_DIR/Phi-3.5-mini-instruct-Q4_K_M.gguf"
MODEL_URL="https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf"

mkdir -p "$LLAMA_DIR" "$MODELS_DIR"

# ---- Cleanup on exit ----
TMP_ZIP=""
trap 'rm -f "$TMP_ZIP"' EXIT

# ---- Disk space check ----
FREE_KB="$(df "$DIR" | awk 'NR==2{print $4}')"
FREE_GB=$((FREE_KB / 1024 / 1024))
if [ "$FREE_GB" -lt 3 ] 2>/dev/null; then
  echo "  WARNING: only ${FREE_GB} GB free -- need ~3 GB for model + binary"
  read -p "  Continue anyway? [y/N] " CONFIRM
  [ "$CONFIRM" = "y" ] || exit 1
fi

# ---- Download llama-server binary ----
if [ -x "$LLAMA_BIN" ]; then
  echo "  llama-server already present at $LLAMA_BIN"
else
  echo "  Fetching latest llama.cpp release tag..."
  RELEASE_TAG="$(curl -sf https://api.github.com/repos/ggml-org/llama.cpp/releases/latest | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  if [ -z "$RELEASE_TAG" ]; then
    echo "  ERROR: could not fetch llama.cpp release info (check internet connection)"; exit 1
  fi
  echo "  Latest release: $RELEASE_TAG"

  # Build download URL based on platform/arch
  if [ "$PLATFORM" = "Darwin" ]; then
    if [ "$MACHINE" = "arm64" ]; then
      ZIP_NAME="llama-${RELEASE_TAG}-bin-macos-arm64.zip"
    else
      ZIP_NAME="llama-${RELEASE_TAG}-bin-macos-x64.zip"
    fi
  else
    if [ "$MACHINE" = "aarch64" ]; then
      ZIP_NAME="llama-${RELEASE_TAG}-bin-ubuntu-arm64.zip"
    else
      ZIP_NAME="llama-${RELEASE_TAG}-bin-ubuntu-x64.zip"
    fi
  fi

  ZIP_URL="https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}/${ZIP_NAME}"
  TMP_ZIP="$LLAMA_DIR/_llama_tmp.zip"

  echo "  Downloading $ZIP_NAME..."
  if command -v curl &>/dev/null; then
    curl -L -# -o "$TMP_ZIP" "$ZIP_URL" || { echo "  Download failed: $ZIP_URL"; exit 1; }
  elif command -v wget &>/dev/null; then
    wget -O "$TMP_ZIP" "$ZIP_URL" || { echo "  Download failed"; exit 1; }
  else
    echo "  ERROR: need curl or wget"; exit 1
  fi

  echo "  Extracting llama-server..."
  # Extract only the llama-server binary from the zip
  if command -v unzip &>/dev/null; then
    unzip -j -o "$TMP_ZIP" "*/llama-server" -d "$LLAMA_DIR" 2>/dev/null || \
    unzip -j -o "$TMP_ZIP" "llama-server" -d "$LLAMA_DIR" 2>/dev/null || \
    { echo "  ERROR: could not extract llama-server from archive"; exit 1; }
  else
    echo "  ERROR: need unzip"; exit 1
  fi

  if [ ! -f "$LLAMA_BIN" ]; then
    echo "  ERROR: llama-server not found in archive -- archive may have different structure"
    echo "  Archive contents:"; unzip -l "$TMP_ZIP" 2>/dev/null | grep -i "llama-server" | head -5
    exit 1
  fi

  chmod +x "$LLAMA_BIN"
  echo "  Binary installed: $LLAMA_BIN"
fi

# ---- Verify binary ----
echo "  Testing llama-server binary..."
"$LLAMA_BIN" --version >/dev/null 2>&1 || {
  echo "  WARNING: llama-server --version failed (may still work -- continuing)"
}

# ---- Download model ----
if [ -f "$MODEL_FILE" ]; then
  echo "  Model already present: $MODEL_FILE"
else
  echo ""
  echo "  Downloading Phi-3.5-mini-instruct Q4_K_M (~2.2 GB)..."
  echo "  Source: HuggingFace / bartowski"
  echo ""
  TMP_MODEL="${MODEL_FILE}.tmp"
  if command -v curl &>/dev/null; then
    curl -L -# -o "$TMP_MODEL" "$MODEL_URL" || { rm -f "$TMP_MODEL"; echo "  Download failed"; exit 1; }
  elif command -v wget &>/dev/null; then
    wget --show-progress -O "$TMP_MODEL" "$MODEL_URL" || { rm -f "$TMP_MODEL"; echo "  Download failed"; exit 1; }
  else
    echo "  ERROR: need curl or wget"; exit 1
  fi
  mv "$TMP_MODEL" "$MODEL_FILE"
  echo "  Model installed: $MODEL_FILE"
fi

echo ""
echo "  Done! Athena is now offline-capable."
echo "    Binary: $LLAMA_BIN"
echo "    Model:  $MODEL_FILE"
echo ""
echo "  Start Athena without any API key -- it will use the local model."
echo ""
