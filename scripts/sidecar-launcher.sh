#!/usr/bin/env bash
# Launcher for the MARVIN Next.js sidecar.
#
# launchd agents inherit a minimal PATH that excludes Homebrew, nvm, and
# other user-level package managers.  This wrapper enriches PATH before
# exec-ing pnpm so the sidecar starts correctly even after Node / pnpm
# upgrades — the plist no longer needs a baked-in pnpm path.
#
# Usage (called by the launchd plist):
#   /bin/bash /path/to/scripts/sidecar-launcher.sh [pnpm-subcommand]
#
# The first argument is the pnpm sub-command to run (default: start).

set -euo pipefail

PNPM_CMD="${1:-start}"

# ── PATH enrichment ────────────────────────────────────────────────────────────

# Homebrew (Apple Silicon primary, Intel fallback)
for brew_prefix in /opt/homebrew /usr/local; do
  [ -d "$brew_prefix/bin" ] && PATH="$brew_prefix/bin:$PATH"
  [ -d "$brew_prefix/sbin" ] && PATH="$brew_prefix/sbin:$PATH"
done

# nvm — load if available, then let it set NODE_PATH / PATH
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh" --no-use
  # Use the default alias if present, otherwise let nvm pick.
  nvm use default 2>/dev/null || nvm use node 2>/dev/null || true
fi

# fnm
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --use-on-cd 2>/dev/null)" || true
fi

# Volta
[ -d "$HOME/.volta/bin" ] && PATH="$HOME/.volta/bin:$PATH"

# n (Node version manager)
[ -d "$HOME/n/bin" ] && PATH="$HOME/n/bin:$PATH"

# pnpm global store
[ -d "$HOME/.local/share/pnpm" ] && PATH="$HOME/.local/share/pnpm:$PATH"
[ -d "$HOME/Library/pnpm" ]       && PATH="$HOME/Library/pnpm:$PATH"

export PATH

# ── Resolve pnpm ──────────────────────────────────────────────────────────────

if ! PNPM_BIN="$(command -v pnpm 2>/dev/null)"; then
  echo "sidecar-launcher: pnpm not found on PATH — cannot start sidecar" >&2
  echo "  Enriched PATH: $PATH" >&2
  exit 1
fi

# ── Run ───────────────────────────────────────────────────────────────────────

exec "$PNPM_BIN" "$PNPM_CMD"
