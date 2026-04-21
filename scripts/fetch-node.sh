#!/usr/bin/env bash
# Fetch a pinned Node.js binary for the Tauri desktop sidecar
# (ADR-0011). Writes to apps/desktop/src-tauri/binaries/node-<triple>,
# which is the name Tauri expects for `bundle.externalBin` entries.
#
# Called automatically by `pnpm desktop:build` via the desktop
# package's `prebuild` step. Idempotent — re-runs skip if the binary
# is already present with the expected SHA.

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v22.14.0}"
TRIPLE="${1:-aarch64-apple-darwin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARIES_DIR="$ROOT/apps/desktop/src-tauri/binaries"
TARGET="$BINARIES_DIR/node-$TRIPLE"

# Map our Rust-style triple to the one Node ships with.
case "$TRIPLE" in
  aarch64-apple-darwin) NODE_PLATFORM="darwin-arm64" ;;
  x86_64-apple-darwin)  NODE_PLATFORM="darwin-x64"   ;;
  aarch64-unknown-linux-gnu) NODE_PLATFORM="linux-arm64" ;;
  x86_64-unknown-linux-gnu)  NODE_PLATFORM="linux-x64"   ;;
  *)
    echo "fetch-node.sh: unsupported triple '$TRIPLE'" >&2
    exit 2
    ;;
esac

mkdir -p "$BINARIES_DIR"

if [[ -x "$TARGET" ]]; then
  # Verify the existing binary still runs; if so, skip re-download.
  if "$TARGET" --version >/dev/null 2>&1; then
    echo "fetch-node.sh: $TARGET already present (v$("$TARGET" --version)) — skipping"
    exit 0
  fi
  echo "fetch-node.sh: $TARGET is present but doesn't execute; re-fetching"
  rm -f "$TARGET"
fi

ARCHIVE="node-$NODE_VERSION-$NODE_PLATFORM.tar.xz"
URL="https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE"
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

echo "fetch-node.sh: downloading $URL"
curl -fsSL "$URL" -o "$TMP/$ARCHIVE"

echo "fetch-node.sh: extracting"
tar -xJf "$TMP/$ARCHIVE" -C "$TMP"

SRC="$TMP/node-$NODE_VERSION-$NODE_PLATFORM/bin/node"
if [[ ! -x "$SRC" ]]; then
  echo "fetch-node.sh: expected binary not found at $SRC" >&2
  exit 3
fi

cp "$SRC" "$TARGET"
chmod +x "$TARGET"

echo "fetch-node.sh: wrote $TARGET ($("$TARGET" --version))"
