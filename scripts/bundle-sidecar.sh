#!/usr/bin/env bash
# bundle-sidecar.sh — assemble the sidecar payload for MARVIN.app.
#
# Per ADR-0023, MARVIN.app/Contents/Resources/ ships:
#   • sidecar/server.js + .next/ + node_modules/  (Next standalone tree)
#   • node                                         (pinned Node 22 runtime)
#
# This script copies the Next standalone tree into a target directory,
# trims dead weight (cross-arch sharp libvips binaries that pnpm hoists
# in but we don't ship), copies the bundled Node binary, and verifies
# the entry point boots /api/health on a probe port.
#
# Usage:
#   scripts/bundle-sidecar.sh <target-resources-dir> [arm64|x64]
#
# Where <target-resources-dir> is MARVIN.app/Contents/Resources of the
# .app being assembled. The script will create:
#     <target>/node
#     <target>/sidecar/server.js
#     <target>/sidecar/.next/
#     <target>/sidecar/node_modules/
#     <target>/sidecar/public/   (if present in source)
#
# Idempotent: re-running on the same target wipes <target>/sidecar/
# first so partial writes from a failed earlier run don't poison the
# bundle.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
ARCH="${2:-arm64}"

if [ -z "$TARGET" ]; then
  echo "bundle-sidecar: usage: $0 <target-resources-dir> [arm64|x64]" >&2
  exit 2
fi

case "$ARCH" in
  arm64) TRIPLE="darwin-arm64" ;;
  x64|x86_64) TRIPLE="darwin-x64" ;;
  *)
    echo "bundle-sidecar: unknown arch '$ARCH'" >&2
    exit 2
    ;;
esac

NODE_BIN_SRC="$REPO_ROOT/vendor/node/$TRIPLE/bin/node"
STANDALONE_SRC="$REPO_ROOT/sidecar/.next/standalone"
STATIC_SRC="$REPO_ROOT/sidecar/.next/static"
PUBLIC_SRC="$REPO_ROOT/sidecar/public"

# Prerequisite: the standalone tree must exist. We don't trigger
# `pnpm build` from here — bundling is a separate concern from building,
# and the caller (bin/marvin install-macos-app or release.yml) is
# responsible for sequencing.
if [ ! -d "$STANDALONE_SRC" ]; then
  echo "bundle-sidecar: $STANDALONE_SRC missing — run 'pnpm --filter @marvin/web build' first" >&2
  exit 1
fi

# Prerequisite: the bundled Node binary must exist. fetch-node.sh
# downloads + verifies + strips it.
if [ ! -x "$NODE_BIN_SRC" ]; then
  echo "bundle-sidecar: $NODE_BIN_SRC missing — run 'scripts/fetch-node.sh $ARCH' first" >&2
  exit 1
fi

# Wipe any prior bundle in the target. The .app is rebuilt from
# scratch on every install, so we can be aggressive here without risk.
rm -rf "$TARGET/sidecar" "$TARGET/node"

# ── Copy the standalone tree ──────────────────────────────────────────
# Next emits standalone/ with the layout:
#     standalone/
#     ├── node_modules/        ← deps Next traced
#     └── sidecar/             ← because outputFileTracingRoot=..,
#         ├── server.js          our package dir name appears here
#         ├── .next/
#         ├── package.json
#         └── packages/         ← workspace symlinks materialized
#
# We mirror that into Resources/sidecar/ as the deepest path the Swift
# app spawns. The hoisted node_modules at standalone/node_modules
# becomes Resources/sidecar/../node_modules — but the Swift app only
# launches the inner sidecar/server.js, and Node's module resolution
# walks up from there. So we ship the whole standalone/ tree.
echo "bundle-sidecar: copying standalone tree → $TARGET/sidecar/"
mkdir -p "$TARGET/sidecar"
# rsync preserves symlinks (the standalone tree contains many) and is
# noticeably faster than `cp -R` for trees with thousands of small files.
rsync -a --quiet "$STANDALONE_SRC/" "$TARGET/sidecar/"

# Next standalone never copies .next/static automatically — it expects
# the caller to do this. Without it the UI loads HTML but no chunks.
if [ -d "$STATIC_SRC" ]; then
  mkdir -p "$TARGET/sidecar/sidecar/.next"
  rsync -a --quiet "$STATIC_SRC/" "$TARGET/sidecar/sidecar/.next/static/"
fi

# Same for /public — copy if present.
if [ -d "$PUBLIC_SRC" ]; then
  rsync -a --quiet "$PUBLIC_SRC/" "$TARGET/sidecar/sidecar/public/"
fi

# ── Restore Claude Agent SDK native-binary sibling symlink ────────────
# Next's standalone tracer copies @anthropic-ai/claude-agent-sdk and its
# darwin-arm64 native package (added via outputFileTracingIncludes in
# next.config.ts) into the bundle, BUT it drops the pnpm sibling symlink
# the SDK relies on for runtime resolution. Without that link, sdk.mjs
# throws:
#   "Native CLI binary for darwin-arm64 not found. Reinstall
#    @anthropic-ai/claude-agent-sdk without --omit=optional, or set
#    options.pathToClaudeCodeExecutable."
# Recreate the symlink pnpm would have placed there. Idempotent — silently
# skips if the parent dir doesn't exist (e.g. SDK was tree-shaken out).
SDK_PNPM_PARENT="$(find "$TARGET/sidecar/node_modules/.pnpm" \
  -maxdepth 4 -type d -name "@anthropic-ai" \
  -path "*@anthropic-ai+claude-agent-sdk@*/node_modules/@anthropic-ai" \
  2>/dev/null | head -n1)"
if [ -n "$SDK_PNPM_PARENT" ] && [ -d "$SDK_PNPM_PARENT" ]; then
  NATIVE_PKG="$(basename "$(find "$TARGET/sidecar/node_modules/.pnpm" \
    -maxdepth 1 -type d \
    -name "@anthropic-ai+claude-agent-sdk-${TRIPLE}@*" 2>/dev/null | head -n1)")"
  if [ -n "$NATIVE_PKG" ]; then
    LINK_TARGET="../../../$NATIVE_PKG/node_modules/@anthropic-ai/claude-agent-sdk-${TRIPLE}"
    LINK_PATH="$SDK_PNPM_PARENT/claude-agent-sdk-${TRIPLE}"
    if [ ! -e "$LINK_PATH" ]; then
      ln -s "$LINK_TARGET" "$LINK_PATH"
      echo "bundle-sidecar: restored claude-agent-sdk-${TRIPLE} symlink"
    fi
  fi
fi

# ── Trim cross-arch sharp libvips ─────────────────────────────────────
# pnpm hoists every optional sharp variant (~150 MB across linux-arm,
# linux-x64, linuxmusl, riscv64, ppc64, s390x, wasm32, …). We only
# ship the macOS variant matching our build target, and we don't even
# use sharp at runtime (next.config disables image optimization). Rip
# the dead weight out before sealing the bundle.
PNPM_DIR="$TARGET/sidecar/node_modules/.pnpm"
if [ -d "$PNPM_DIR" ]; then
  removed_bytes=0
  for variant in "$PNPM_DIR"/@img+sharp-* "$PNPM_DIR"/@img+colour@*; do
    [ -d "$variant" ] || continue
    base="$(basename "$variant")"
    # Keep only the variant matching our arch + the always-needed
    # @img+sharp-${TRIPLE} runtime stub. Everything else goes.
    case "$base" in
      "@img+sharp-${TRIPLE}@"*|"@img+sharp-libvips-${TRIPLE}@"*)
        : # keep
        ;;
      *)
        rm -rf "$variant"
        ;;
    esac
  done
fi

# ── Copy the bundled Node binary ──────────────────────────────────────
echo "bundle-sidecar: copying node → $TARGET/node"
cp "$NODE_BIN_SRC" "$TARGET/node"
chmod +x "$TARGET/node"

# ── Smoke probe ───────────────────────────────────────────────────────
# Boot the bundled tree under the bundled node, on a random high port,
# hit /api/health, then kill it. Catches regressions where standalone
# build skipped a workspace package or sharp trimming nuked something
# real. Skipped if MARVIN_BUNDLE_NO_SMOKE=1 (CI may want to defer).
if [ -z "${MARVIN_BUNDLE_NO_SMOKE:-}" ]; then
  PROBE_PORT=$(( 30303 + (RANDOM % 1000) ))
  echo "bundle-sidecar: smoke probe on port $PROBE_PORT"
  log="$(mktemp -t marvin-bundle-smoke.XXXXXX.log)"
  ( cd "$TARGET/sidecar/sidecar" && \
    PORT="$PROBE_PORT" HOSTNAME=127.0.0.1 NODE_ENV=production \
    "$TARGET/node" server.js >"$log" 2>&1 ) &
  smoke_pid=$!
  trap 'kill "$smoke_pid" 2>/dev/null || true; wait "$smoke_pid" 2>/dev/null || true' EXIT
  ok=0
  for _ in $(seq 1 30); do
    if curl -sf -m 1 "http://127.0.0.1:$PROBE_PORT/api/health" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 0.5
  done
  kill "$smoke_pid" 2>/dev/null || true
  wait "$smoke_pid" 2>/dev/null || true
  trap - EXIT
  if [ "$ok" -ne 1 ]; then
    echo "bundle-sidecar: ✗ smoke probe failed — bundled sidecar did not respond on /api/health" >&2
    echo "  log:" >&2
    sed 's/^/    /' "$log" >&2
    exit 1
  fi
  echo "bundle-sidecar: ✓ /api/health responded"
fi

bundle_size="$(du -sh "$TARGET" | awk '{print $1}')"
echo "bundle-sidecar: ✓ bundle ready at $TARGET (total: $bundle_size)"
