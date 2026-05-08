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

# ── Interactive prompts work even when invoked via `curl … | bash` ────────────
# When stdin is a pipe, `read` would consume installer bytes instead of user
# input. /dev/tty bypasses that — bash on macOS always has it.

confirm() {
  # confirm "Question?"   → returns 0 on yes, 1 on no. Default Yes.
  local prompt="$1" reply
  if [ -r /dev/tty ]; then
    printf '%s [Y/n] ' "$prompt" >&2
    read -r reply </dev/tty || reply=""
  else
    reply=""  # non-interactive → assume Yes
  fi
  case "${reply:-y}" in
    y|Y|yes|YES) return 0 ;;
    *)           return 1 ;;
  esac
}

# ── Bootstrap toolchain ───────────────────────────────────────────────────────
# Auto-install Xcode CLT, Homebrew, Node, pnpm, and xcodegen so a fresh macbook
# (Safari + Terminal only) can run this curl-bash one-liner end-to-end.

step "Bootstrapping toolchain"

# 1. Xcode Command Line Tools — provides git, swift, codesign
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Xcode Command Line Tools not installed."
  if confirm "  Trigger the installer? (a GUI dialog will appear)"; then
    xcode-select --install >/dev/null 2>&1 || true
    info "Waiting for the Command Line Tools install to finish…"
    dim "  (click 'Install' in the dialog, accept the license, then come back here)"
    while ! xcode-select -p >/dev/null 2>&1; do sleep 5; done
    ok "Command Line Tools installed"
  else
    die "Command Line Tools are required.  Install with:  xcode-select --install"
  fi
else
  ok "Command Line Tools at $(xcode-select -p)"
fi

# 2. Homebrew — needed for node@22, pnpm, xcodegen
if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew not installed."
  if confirm "  Install Homebrew now? (uses Apple's recommended installer; will ask for your password)"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
      </dev/tty || die "Homebrew install failed"
    # Add brew to PATH for the rest of this script.
    if   [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -x /usr/local/bin/brew    ]; then eval "$(/usr/local/bin/brew shellenv)"
    fi
  else
    die "Homebrew is required.  Install from:  https://brew.sh"
  fi
fi
ok "brew $(brew --version | head -1 | awk '{print $2}')"

# 3. Node ≥ MIN_NODE_MAJOR via brew
node_ok=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  [ "$node_major" -ge "$MIN_NODE_MAJOR" ] && node_ok=1
fi
if [ "$node_ok" -eq 0 ]; then
  info "Installing node@${MIN_NODE_MAJOR} via brew"
  brew install "node@${MIN_NODE_MAJOR}" || die "brew install node@${MIN_NODE_MAJOR} failed"
  brew link --overwrite --force "node@${MIN_NODE_MAJOR}" >/dev/null 2>&1 || true
  # Make sure the freshly-installed node is on PATH for the rest of this run.
  for prefix in /opt/homebrew/opt/node@${MIN_NODE_MAJOR}/bin /usr/local/opt/node@${MIN_NODE_MAJOR}/bin; do
    [ -d "$prefix" ] && PATH="$prefix:$PATH"
  done
  export PATH
fi
ok "node $(node --version)"

# 4. pnpm via brew
if ! command -v pnpm >/dev/null 2>&1; then
  info "Installing pnpm via brew"
  brew install pnpm || die "brew install pnpm failed"
fi
ok "pnpm $(pnpm --version)"

# 5. xcodegen — only needed if full Xcode is installed (CLT-only path uses swift build)
if command -v xcodebuild >/dev/null 2>&1 && xcodebuild -version >/dev/null 2>&1; then
  if ! command -v xcodegen >/dev/null 2>&1; then
    info "Installing xcodegen via brew"
    brew install xcodegen || warn "brew install xcodegen failed — falling back to swift build"
  fi
fi

# ── Verify build path ─────────────────────────────────────────────────────────
# The bootstrap above guaranteed git / node / pnpm.  All that's left to decide
# is whether we'll build the .app via xcodebuild (full Xcode) or swift build
# (Command Line Tools only).

step "Selecting build path"

if command -v xcodebuild >/dev/null 2>&1 && xcodebuild -version >/dev/null 2>&1 \
   && command -v xcodegen >/dev/null 2>&1; then
  ok "$(xcodebuild -version | head -1) + xcodegen → xcodebuild path"
  BUILD_PATH="xcodebuild"
elif command -v swift >/dev/null 2>&1; then
  ok "$(swift --version | head -1) → swift build fallback"
  BUILD_PATH="swift"
else
  die "No Swift toolchain available.  Re-run after installing Xcode or Command Line Tools."
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

# ── Claude Code CLI ───────────────────────────────────────────────────────────
# MARVIN talks to Claude through the @anthropic-ai/claude-code CLI; without it
# (and an authenticated session) the sidecar runs but every chat turn errors.

step "Setting up Claude Code"

if ! command -v claude >/dev/null 2>&1; then
  info "Installing @anthropic-ai/claude-code"
  npm install -g @anthropic-ai/claude-code || warn "claude-code install failed — install manually:  npm install -g @anthropic-ai/claude-code"
fi

if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1 | awk '{print $1}')"
  # We don't try to detect "is it logged in" — the credential layout has
  # changed across versions and any guess is brittle.  Just point the user
  # at the one command they need to run once.
  CLAUDE_LOGIN_HINT=1
else
  CLAUDE_LOGIN_HINT=0
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

if [ "$CLAUDE_LOGIN_HINT" -eq 1 ]; then
  step "One thing left — authenticate Claude Code"
  dim "  Run this once in any terminal, then use the in-app /login flow:"
  printf '    %sclaude%s\n' "$C_BLU" "$C_RST"
  dim "  After /login finishes, MARVIN is ready."
  echo
fi

dim "  First launch: right-click MARVIN.app → Open (Gatekeeper bypass)."
dim "  The sidecar starts automatically on login via launchd."
dim "  To uninstall:  marvin uninstall-macos-app"
echo
