#!/usr/bin/env bash
# MARVIN installer — build-from-source edition.
#
# Usage (one-liner from a fresh machine):
#   curl -fsSL https://raw.githubusercontent.com/RobertIlisei/MARVIN/main/scripts/install.sh | bash
#
# Or clone and run locally:
#   bash scripts/install.sh
#
# What it does:
#   1. Checks prerequisites (git, node ≥ 22, pnpm, xcode/swift)
#   2. Clones the repo to $MARVIN_INSTALL_DIR  (default: ~/.marvin-app)
#   3. Installs Node dependencies
#   4. Builds MARVIN.app and installs it to /Applications
#   5. Installs a launchd agent so the sidecar starts on login
#   6. Symlinks bin/marvin to /usr/local/bin/marvin
#
# Environment knobs (all optional):
#   MARVIN_INSTALL_DIR   where to clone the repo  (default: ~/.marvin-app)
#   MARVIN_BRANCH        which branch to install   (default: main)
#   MARVIN_PORT          sidecar port              (default: 3030)
#
# No Developer account or code-signing certificate required.
# The resulting MARVIN.app is ad-hoc signed — on first open,
# right-click → Open (or System Settings → Privacy & Security → Open Anyway).

set -euo pipefail

REPO_URL="https://github.com/RobertIlisei/MARVIN.git"
INSTALL_DIR="${MARVIN_INSTALL_DIR:-$HOME/.marvin-app}"
BRANCH="${MARVIN_BRANCH:-main}"
CLI_LINK="/usr/local/bin/marvin"
MIN_NODE_MAJOR=22

# ── Pretty printing ────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_DIM=''; C_RST=''
fi

info()  { printf '%s%s%s %s\n' "$C_BLU" "ℹ" "$C_RST" "$*"; }
ok()    { printf '%s%s%s %s\n' "$C_GRN" "✓" "$C_RST" "$*"; }
warn()  { printf '%s%s%s %s\n' "$C_YEL" "!" "$C_RST" "$*"; }
die()   { printf '%s%s%s %s\n' "$C_RED" "✗" "$C_RST" "$*" >&2; exit 1; }
dim()   { printf '%s%s%s\n'    "$C_DIM" "$*" "$C_RST"; }
step()  { echo; printf '%s==> %s%s\n' "$C_BLU" "$*" "$C_RST"; }

# ── OS check ──────────────────────────────────────────────────────────────────

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "MARVIN's native app requires macOS. Linux/Windows support is not yet available."
fi

echo
printf '%s╔══════════════════════════════════════╗%s\n' "$C_BLU" "$C_RST"
printf '%s║         MARVIN installer             ║%s\n' "$C_BLU" "$C_RST"
printf '%s╚══════════════════════════════════════╝%s\n' "$C_BLU" "$C_RST"
echo
dim "  Install dir:  $INSTALL_DIR"
dim "  Branch:       $BRANCH"
dim "  CLI symlink:  $CLI_LINK"
echo

# ── Prerequisites ─────────────────────────────────────────────────────────────

step "Checking prerequisites"

# git
if ! command -v git >/dev/null 2>&1; then
  die "git not found. Install Xcode Command Line Tools:  xcode-select --install"
fi
ok "git $(git --version | awk '{print $3}')"

# node
if ! command -v node >/dev/null 2>&1; then
  die "node not found (need ≥ $MIN_NODE_MAJOR). Install from https://nodejs.org or: brew install node@${MIN_NODE_MAJOR}"
fi
node_version="$(node --version | sed 's/^v//')"
node_major="${node_version%%.*}"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  die "node $node_version is too old (need ≥ $MIN_NODE_MAJOR). Upgrade: https://nodejs.org"
fi
ok "node v$node_version"

# pnpm — install automatically if missing (it's a one-liner and users expect this)
if ! command -v pnpm >/dev/null 2>&1; then
  info "pnpm not found — installing via npm"
  npm install -g pnpm@latest || die "Failed to install pnpm. Try: npm install -g pnpm"
fi
ok "pnpm $(pnpm --version)"

# Swift / Xcode — need at least the Command Line Tools
if command -v xcodebuild >/dev/null 2>&1 && xcodebuild -version >/dev/null 2>&1; then
  xcode_ver="$(xcodebuild -version 2>/dev/null | head -1)"
  ok "$xcode_ver (xcodebuild available)"
  BUILD_PATH="xcodebuild"
elif command -v swift >/dev/null 2>&1; then
  swift_ver="$(swift --version 2>/dev/null | head -1)"
  ok "$swift_ver (swift build fallback)"
  BUILD_PATH="swift"
else
  die "Neither Xcode nor Swift Command Line Tools found.
  Install Command Line Tools:   xcode-select --install
  Or install Xcode from:        https://developer.apple.com/xcode/"
fi

# ── Clone or update repo ───────────────────────────────────────────────────────

step "Setting up source"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Repo already at $INSTALL_DIR — pulling latest on branch $BRANCH"
  git -C "$INSTALL_DIR" fetch origin
  git -C "$INSTALL_DIR" checkout "$BRANCH" 2>/dev/null || true
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  ok "Updated to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
else
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    die "$INSTALL_DIR exists and is not a git repo. Remove it first: rm -rf $INSTALL_DIR"
  fi
  info "Cloning MARVIN into $INSTALL_DIR"
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi

# ── Install Node dependencies ──────────────────────────────────────────────────

step "Installing Node dependencies"
(cd "$INSTALL_DIR" && pnpm install)
ok "Dependencies installed"

# ── Build and install MARVIN.app ───────────────────────────────────────────────

step "Building and installing MARVIN.app"
dim "  This builds from source — takes 2-5 min on a cold cache."
dim "  xcodegen + xcodebuild preferred; swift build used if Xcode is absent."
echo

# Delegate entirely to bin/marvin install-macos-app which handles:
#   - xcodebuild vs swift build selection
#   - bundle assembly + ad-hoc signing
#   - Next.js production build
#   - launchd agent installation
MARVIN_INSTALL_DIR="$INSTALL_DIR" "$INSTALL_DIR/bin/marvin" install-macos-app

# ── Wire CLI ──────────────────────────────────────────────────────────────────

step "Wiring CLI"

# /usr/local/bin is writable without sudo on most macOS systems.
# If it's not (corporate policy, read-only volume), fall back to ~/bin.
mkdir -p /usr/local/bin 2>/dev/null || true

if [ -w /usr/local/bin ]; then
  ln -sf "$INSTALL_DIR/bin/marvin" "$CLI_LINK"
  ok "Symlinked $CLI_LINK → $INSTALL_DIR/bin/marvin"
else
  warn "/usr/local/bin is not writable — trying ~/bin instead"
  mkdir -p "$HOME/bin"
  ln -sf "$INSTALL_DIR/bin/marvin" "$HOME/bin/marvin"
  CLI_LINK="$HOME/bin/marvin"
  ok "Symlinked $CLI_LINK → $INSTALL_DIR/bin/marvin"
  # Offer PATH snippet if ~/bin isn't already on PATH.
  if ! echo "$PATH" | grep -q "$HOME/bin"; then
    warn "~/bin is not on your PATH. Add this to your shell profile:"
    dim '  export PATH="$HOME/bin:$PATH"'
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo
printf '%s╔══════════════════════════════════════╗%s\n' "$C_GRN" "$C_RST"
printf '%s║       MARVIN installed!              ║%s\n' "$C_GRN" "$C_RST"
printf '%s╚══════════════════════════════════════╝%s\n' "$C_GRN" "$C_RST"
echo
printf '  %-18s %s\n' "App:"     "/Applications/MARVIN.app"
printf '  %-18s %s\n' "CLI:"     "$CLI_LINK"
printf '  %-18s %s\n' "Source:"  "$INSTALL_DIR"
printf '  %-18s %s\n' "Data:"    "~/.marvin/"
echo
dim "  First launch: right-click MARVIN.app → Open (Gatekeeper bypass)."
dim "  The sidecar starts automatically on login via launchd."
dim "  To uninstall:  marvin uninstall-macos-app"
echo
dim "  Need Claude Code?  npm install -g @anthropic-ai/claude-code"
dim "  Then authenticate: claude auth login"
echo
