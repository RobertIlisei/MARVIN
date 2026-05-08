#!/usr/bin/env bash
# MARVIN uninstaller.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/RobertIlisei/MARVIN/main/scripts/uninstall.sh | bash
#
# Or if the CLI is already on PATH:
#   marvin uninstall-macos-app
#
# What it removes:
#   • /Applications/MARVIN.app
#   • ~/Library/LaunchAgents/net.marvin.desktop.server.plist  (sidecar)
#   • /usr/local/bin/marvin  (or ~/bin/marvin) symlink
#   • ~/.marvin-app/  (the source clone) — asks for confirmation
#   • ~/.marvin/      (sessions + cost data) — asks for confirmation

set -euo pipefail

APP_BUNDLE="/Applications/MARVIN.app"
AGENT_PLIST="$HOME/Library/LaunchAgents/net.marvin.desktop.server.plist"
CLI_LINKS=("/usr/local/bin/marvin" "$HOME/bin/marvin")
DEFAULT_INSTALL_DIR="$HOME/.marvin-app"
DATA_DIR="$HOME/.marvin"

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
dim()   { printf '%s%s%s\n'    "$C_DIM" "$*" "$C_RST"; }
step()  { echo; printf '%s==> %s%s\n' "$C_BLU" "$*" "$C_RST"; }

ask_yes() {
  # Returns 0 (yes) or 1 (no). Defaults to no when stdin is not a tty
  # (piped install — caller decides the default).
  local prompt="$1"
  local default="${2:-n}"
  if [ ! -t 0 ]; then
    # Non-interactive: honour the default.
    [[ "$default" == "y" ]]
    return
  fi
  local yn
  read -rp "$(printf '%s? %s [y/N]: %s' "$C_YEL" "$prompt" "$C_RST")" yn
  [[ "$yn" =~ ^[Yy]$ ]]
}

# ── Header ────────────────────────────────────────────────────────────────────

echo
printf '%s╔══════════════════════════════════════╗%s\n' "$C_YEL" "$C_RST"
printf '%s║         MARVIN uninstaller           ║%s\n' "$C_YEL" "$C_RST"
printf '%s╚══════════════════════════════════════╝%s\n' "$C_YEL" "$C_RST"
echo

# ── Stop and unload sidecar ───────────────────────────────────────────────────

step "Stopping sidecar"
if [ -f "$AGENT_PLIST" ]; then
  launchctl unload "$AGENT_PLIST" 2>/dev/null && ok "Sidecar stopped" || warn "launchctl unload failed (may already be stopped)"
  rm -f "$AGENT_PLIST"
  ok "Removed $AGENT_PLIST"
else
  dim "  No launchd agent at $AGENT_PLIST"
fi

# Best-effort: kill any process bound to port 3030 in case launchd
# unload left an orphan.
if command -v lsof >/dev/null 2>&1; then
  local_pid="$(lsof -iTCP:3030 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$local_pid" ]; then
    info "Stopping process on port 3030 (pid $local_pid)"
    kill "$local_pid" 2>/dev/null || true
  fi
fi

# ── Remove .app ───────────────────────────────────────────────────────────────

step "Removing MARVIN.app"
if [ -d "$APP_BUNDLE" ]; then
  rm -rf "$APP_BUNDLE"
  ok "Removed $APP_BUNDLE"
else
  dim "  $APP_BUNDLE not found"
fi

# ── Remove CLI symlinks ───────────────────────────────────────────────────────

step "Removing CLI symlink"
removed_link=0
for link in "${CLI_LINKS[@]}"; do
  if [ -L "$link" ]; then
    rm -f "$link"
    ok "Removed $link"
    removed_link=1
  fi
done
[ "$removed_link" -eq 0 ] && dim "  No marvin symlink found in /usr/local/bin or ~/bin"

# ── Remove source clone ───────────────────────────────────────────────────────

step "Source directory"

# Detect install dir — either the default or one the user set at install time.
install_dir="$DEFAULT_INSTALL_DIR"
if [ ! -d "$install_dir" ]; then
  # The user may have installed somewhere else. Try to find a marvin-app dir.
  dim "  Default install dir $install_dir not found — skipping source removal"
  install_dir=""
fi

if [ -n "$install_dir" ] && [ -d "$install_dir" ]; then
  dim "  Source at: $install_dir"
  if ask_yes "Remove source directory $install_dir"; then
    rm -rf "$install_dir"
    ok "Removed $install_dir"
  else
    dim "  Kept $install_dir — you can remove it later with:  rm -rf $install_dir"
  fi
fi

# ── Remove data directory ─────────────────────────────────────────────────────

step "Data directory"
if [ -d "$DATA_DIR" ]; then
  dim "  Data dir: $DATA_DIR"
  dim "  Contains: sessions, cost tracker, project registry"
  if ask_yes "Remove data directory $DATA_DIR (deletes all chat history)"; then
    rm -rf "$DATA_DIR"
    ok "Removed $DATA_DIR"
  else
    dim "  Kept $DATA_DIR — remove manually with:  rm -rf $DATA_DIR"
  fi
else
  dim "  No data dir at $DATA_DIR"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo
printf '%s╔══════════════════════════════════════╗%s\n' "$C_GRN" "$C_RST"
printf '%s║       MARVIN uninstalled             ║%s\n' "$C_GRN" "$C_RST"
printf '%s╚══════════════════════════════════════╝%s\n' "$C_GRN" "$C_RST"
echo
dim "  To reinstall: curl -fsSL https://raw.githubusercontent.com/RobertIlisei/MARVIN/main/scripts/install.sh | bash"
echo
