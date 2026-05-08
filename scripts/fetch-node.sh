#!/usr/bin/env bash
# fetch-node.sh — download a pinned Node 22 binary for bundling into
# MARVIN.app. ADR-0023.
#
# The brew-distributed MARVIN.app ships its own Node so end users
# don't need Node installed on their machine. This script downloads
# the official Apple Silicon build from nodejs.org, verifies its
# SHA-256, strips it, and lays it down at vendor/node/<triple>/bin/node.
#
# Idempotent — re-runs skip the download if the binary already exists
# with the expected hash. Output is gitignored (vendor/ is in .gitignore).
#
# Usage:
#   scripts/fetch-node.sh [arm64|x64]   # default: arm64 (Apple Silicon)
#
# Sets vendor/node/<triple>/SOURCE.txt with the upstream URL + hash so
# we can audit which Node is in any given .app bundle.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-arm64}"

# Pinned Node version. Bump when a security release lands; keep on
# active LTS or current stable. v22.x is current LTS as of 2026-05.
NODE_VERSION="22.11.0"

case "$ARCH" in
  arm64)
    TRIPLE="darwin-arm64"
    # SHA-256 from https://nodejs.org/dist/v22.11.0/SHASUMS256.txt
    SHA256="2e89afe6f4e3aa6c7e21c560d8a0453d84807e97850bbb819b998531a22bdfde"
    ;;
  x64|x86_64)
    TRIPLE="darwin-x64"
    SHA256="668d30b9512137b5f5baeef6c1bb4c46efff9a761ba990a034fb6b28b9da2465"
    ;;
  *)
    echo "fetch-node: unknown arch '$ARCH' (expected arm64 or x64)" >&2
    exit 2
    ;;
esac

VENDOR_DIR="$REPO_ROOT/vendor/node/$TRIPLE"
NODE_BIN="$VENDOR_DIR/bin/node"
ARCHIVE_NAME="node-v${NODE_VERSION}-${TRIPLE}.tar.gz"
ARCHIVE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE_NAME}"

# Skip if we already have a binary at the pinned version.
if [ -x "$NODE_BIN" ]; then
  existing_version="$("$NODE_BIN" --version 2>/dev/null || echo "")"
  if [ "$existing_version" = "v${NODE_VERSION}" ]; then
    echo "fetch-node: vendor/node/${TRIPLE}/bin/node is already v${NODE_VERSION}"
    exit 0
  fi
  echo "fetch-node: existing node is ${existing_version}, refetching v${NODE_VERSION}"
fi

mkdir -p "$VENDOR_DIR"
TMP_DIR="$(mktemp -d -t marvin-node-XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "fetch-node: downloading $ARCHIVE_URL"
curl -fL --retry 3 -o "$TMP_DIR/$ARCHIVE_NAME" "$ARCHIVE_URL"

echo "fetch-node: verifying SHA-256"
actual_sha="$(shasum -a 256 "$TMP_DIR/$ARCHIVE_NAME" | awk '{print $1}')"
if [ "$actual_sha" != "$SHA256" ]; then
  echo "fetch-node: SHA mismatch!" >&2
  echo "  expected: $SHA256" >&2
  echo "  got:      $actual_sha" >&2
  exit 1
fi

echo "fetch-node: extracting"
tar -xzf "$TMP_DIR/$ARCHIVE_NAME" -C "$TMP_DIR"
extracted_dir="$TMP_DIR/node-v${NODE_VERSION}-${TRIPLE}"

# Lay down a minimal vendor tree — just bin/node. The full Node
# distribution carries npm, headers, and docs we don't need at runtime;
# excluding them shaves ~50% off the bundled size.
rm -rf "$VENDOR_DIR/bin"
mkdir -p "$VENDOR_DIR/bin"
cp "$extracted_dir/bin/node" "$VENDOR_DIR/bin/node"
chmod +x "$VENDOR_DIR/bin/node"

# Strip + ad-hoc re-sign. Stripping shaves ~30 MB of debug symbols off
# the binary; the upstream Node carries the hardened-runtime flag for
# Apple notarization (which we don't do — see ADR-0023), and stripping
# invalidates that signature. Replacing it with ad-hoc lets the binary
# run on the build machine and inside the .app once codesigned-deep at
# install time. Brew strips the quarantine xattr at install.
echo "fetch-node: stripping debug symbols + ad-hoc re-signing"
strip -x "$VENDOR_DIR/bin/node"
codesign --force --sign - "$VENDOR_DIR/bin/node" >/dev/null

cat >"$VENDOR_DIR/SOURCE.txt" <<EOF
node v${NODE_VERSION} ${TRIPLE}
url: ${ARCHIVE_URL}
sha256: ${SHA256}
fetched: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

bin_size="$(du -h "$VENDOR_DIR/bin/node" | awk '{print $1}')"
echo "fetch-node: ✓ vendor/node/${TRIPLE}/bin/node (v${NODE_VERSION}, ${bin_size})"
