#!/usr/bin/env bash
# Produce the Next.js standalone bundle that ships inside MARVIN.app
# (ADR-0011). Runs as part of `pnpm desktop:build` before `tauri build`
# copies `src-tauri/resources/**` into the final `.app`.
#
# Output: apps/desktop/src-tauri/resources/next/ — self-contained
# Next.js runtime + server.js. Entry point resolved at runtime by
# the Rust sidecar spawn:
#   Resources/next/apps/web/server.js

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STANDALONE="$ROOT/apps/web/.next/standalone"
STATIC="$ROOT/apps/web/.next/static"
PUBLIC="$ROOT/apps/web/public"
OUT="$ROOT/apps/desktop/src-tauri/resources/next"

echo "bundle-resources.sh: building apps/web standalone output"
pnpm --filter @marvin/web build

if [[ ! -d "$STANDALONE" ]]; then
  echo "bundle-resources.sh: standalone output missing at $STANDALONE" >&2
  echo "bundle-resources.sh: check apps/web/next.config.ts has output: 'standalone'" >&2
  exit 1
fi

echo "bundle-resources.sh: staging into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"

# The standalone dir mirrors the monorepo layout — apps/web/server.js
# plus the minimal node_modules Next traced. Copy it wholesale.
cp -R "$STANDALONE/." "$OUT/"

# Standalone output intentionally omits .next/static + public —
# Next.js doesn't trace them because they're served by the CDN in
# prod. For a self-contained bundle, copy them into the right place:
#   Resources/next/apps/web/.next/static
#   Resources/next/apps/web/public
mkdir -p "$OUT/apps/web/.next"
if [[ -d "$STATIC" ]]; then
  cp -R "$STATIC" "$OUT/apps/web/.next/static"
fi
if [[ -d "$PUBLIC" ]]; then
  cp -R "$PUBLIC" "$OUT/apps/web/public"
fi

size="$(du -sh "$OUT" | cut -f1)"
echo "bundle-resources.sh: staged $OUT ($size)"
