#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
echo "Athena v4 setup verifies vendor/manifest.json before first boot."
node dist/cli.js doctor
