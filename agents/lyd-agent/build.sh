#!/usr/bin/env bash
# Builds standalone Linux binaries: dist/lyd-agent-linux-{x64,arm64}.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
for arch in x64 arm64; do
  bun build --compile --target="bun-linux-$arch" src/main.ts --outfile "dist/lyd-agent-linux-$arch"
done
