#!/usr/bin/env bash
# scripts/setup.sh
#
# Interactive setup for MARVIN's optional/recommended dependencies.
# Run after `pnpm install`. Idempotent — safe to re-run.
#
# Prompts for:
#   - Claude Code CLI         (required for any chat)
#   - graphify Python package (recommended — Golden Rule 7 graph queries)
#   - Playwright Chromium     (required for the marvin-playwright MCP)
#
# Each prompt is Y/n/never. "never" is persisted in
# .marvin/install-prefs.json so future setup + doctor runs stop asking.
#
# Flags:
#   --yes         install every missing recommended dep without prompting
#   --skip-all    record every missing dep as skipped without installing
#   --non-interactive  same as `--skip-all` (used when stdin is not a TTY)
#
# Exit codes:
#   0  setup complete (every dep is either installed or recorded as skipped)
#   2  a hard prerequisite is missing (Node ≥22, pnpm) — `bin/marvin` flags this too
#
# What this script does NOT do:
#   - It does not install Node, pnpm, or the skills bundle. The first
#     two are hard-gated by `bin/marvin`; skills install silently and
#     idempotently when MARVIN starts.
#   - It does not write Anthropic credentials. Those are per-account
#     and out of installer scope.
#   - It does not auto-rebuild the graphify graph. After installing
#     graphify, the user runs `/graphify .` from inside their project
#     directory, not from MARVIN's repo.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────
# Paths + flags

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

readonly STATE_DIR=".marvin"
readonly PREFS_FILE="$STATE_DIR/install-prefs.json"
mkdir -p "$STATE_DIR"

NONINTERACTIVE=0
ASSUME_YES=0
SKIP_ALL=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)              ASSUME_YES=1 ;;
    --skip-all)            SKIP_ALL=1 ;;
    --non-interactive)     NONINTERACTIVE=1 ;;
    -h|--help)
      sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown flag: $arg (try --help)" >&2
      exit 64 ;;
  esac
done

# Auto-detect non-interactive when stdin isn't a terminal — keeps CI /
# pipes from hanging on `read`.
if [ ! -t 0 ]; then NONINTERACTIVE=1; fi

# ─────────────────────────────────────────────────────────────────────
# Pretty print

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_BLU=$'\033[34m'; C_DIM=$'\033[2m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_DIM=''; C_BLD=''; C_RST=''
fi
info() { printf '%s%s%s %s\n' "$C_BLU" "ℹ" "$C_RST" "$*"; }
ok()   { printf '%s%s%s %s\n' "$C_GRN" "✓" "$C_RST" "$*"; }
warn() { printf '%s%s%s %s\n' "$C_YEL" "!" "$C_RST" "$*"; }
fail() { printf '%s%s%s %s\n' "$C_RED" "✗" "$C_RST" "$*" >&2; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RST"; }
hdr()  { printf '\n%s%s%s\n' "$C_BLD" "$*" "$C_RST"; }

# ─────────────────────────────────────────────────────────────────────
# Prefs file — pure-bash JSON read/write keyed by dep name.
#
# Schema: { "skipped": ["graphify", "chromium"] } — names are lowercase
# slugs matching the dep IDs below. We hand-write JSON to avoid taking
# a hard dep on jq, but read it via Node (already a hard prereq).

prefs_has_skip() {
  local name="$1"
  [ -f "$PREFS_FILE" ] || return 1
  node -e "
    const fs = require('fs');
    try {
      const p = JSON.parse(fs.readFileSync('$PREFS_FILE','utf8'));
      const s = Array.isArray(p.skipped) ? p.skipped : [];
      process.exit(s.includes('$name') ? 0 : 1);
    } catch { process.exit(1); }
  " 2>/dev/null
}

prefs_add_skip() {
  local name="$1"
  node -e "
    const fs = require('fs');
    let p = { skipped: [] };
    try { p = JSON.parse(fs.readFileSync('$PREFS_FILE','utf8')); } catch {}
    if (!Array.isArray(p.skipped)) p.skipped = [];
    if (!p.skipped.includes('$name')) p.skipped.push('$name');
    fs.writeFileSync('$PREFS_FILE', JSON.stringify(p, null, 2) + '\n');
  "
}

# ─────────────────────────────────────────────────────────────────────
# Prompt helper — Y/n/never. Returns:
#   0  user said yes (install)
#   1  user said no (one-time skip, ask again next run)
#   2  user said never (record in prefs file)
prompt_install() {
  local label="$1"
  local default="${2:-Y}"   # Y or n

  if [ "$ASSUME_YES" -eq 1 ]; then return 0; fi
  if [ "$SKIP_ALL" -eq 1 ] || [ "$NONINTERACTIVE" -eq 1 ]; then return 2; fi

  local choices
  if [ "$default" = "Y" ]; then choices="[Y/n/never]"; else choices="[y/N/never]"; fi

  local reply
  printf '  %sInstall now via %s?%s ' "$C_BLD" "$label" "$C_RST"
  printf '%s ' "$choices"
  read -r reply || reply=""

  case "${reply,,}" in
    ""|y|yes)
      [ "$default" = "Y" ] && return 0
      return 1 ;;
    n|no)
      return 1 ;;
    never|x)
      return 2 ;;
    *)
      warn "unrecognised answer '$reply' — treating as no"
      return 1 ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────
# Hard prerequisites — refuse to start setup without them. Mirrors the
# subset of `bin/marvin doctor` that the optional installers depend on.

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "node not found on PATH — install Node ≥22 first"
    dim "  https://nodejs.org  or  brew install node@22"
    exit 2
  fi
  local major
  major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$major" -lt 22 ]; then
    fail "node ${major}.x is too old — need ≥22"
    exit 2
  fi
}

# ─────────────────────────────────────────────────────────────────────
# Dep 1 — Claude Code CLI

setup_claude_cli() {
  hdr "1/3 — Claude Code CLI"
  local bin="${MARVIN_CLAUDE_BIN:-claude}"
  if command -v "$bin" >/dev/null 2>&1; then
    local v
    v="$("$bin" --version 2>/dev/null | head -1 || echo unknown)"
    ok "already installed: $v"
    return 0
  fi
  if prefs_has_skip claude-cli; then
    dim "previously skipped (delete $PREFS_FILE to re-prompt)"
    return 0
  fi

  cat <<EOF
  $(printf '%s%s%s' "$C_BLD" "What it gives you" "$C_RST"): every chat turn. Without it, MARVIN's UI
    loads but every message fails — the Agent SDK spawns the 'claude'
    binary under the hood.
  $(printf '%s%s%s' "$C_BLD" "If skipped" "$C_RST"): app starts, no AI. Re-run setup or install
    later with 'npm install -g @anthropic-ai/claude-code'.
EOF
  case "$(prompt_install '@anthropic-ai/claude-code' 'Y'; echo $?)" in
    0)
      info "running: npm install -g @anthropic-ai/claude-code"
      if npm install -g @anthropic-ai/claude-code; then
        ok "claude installed"
      else
        warn "npm install failed — install manually and re-run setup"
      fi ;;
    1) warn "skipped this run — will ask again next time" ;;
    2) prefs_add_skip claude-cli; warn "marked never — recorded in $PREFS_FILE" ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────
# Dep 2 — graphify

setup_graphify() {
  hdr "2/3 — graphify (knowledge graph builder)"
  if command -v graphify >/dev/null 2>&1; then
    # `graphify --version` prints update-available warnings to stdout, so
    # filter to the first line that looks like a version string. Falls
    # back to a generic "on PATH" message when nothing matches.
    local v
    v="$(graphify --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    ok "already installed${v:+: $v}${v:+}"
    [ -z "$v" ] && dim "  on PATH (version unparseable)"
    return 0
  fi
  if prefs_has_skip graphify; then
    dim "previously skipped (delete $PREFS_FILE to re-prompt)"
    return 0
  fi

  cat <<EOF
  $(printf '%s%s%s' "$C_BLD" "What it gives you" "$C_RST"): Golden Rule 7 graph queries
    (graph_search / graph_neighbors / graph_path) + the brain pane data.
    ~36× cheaper than file reads on architecture questions.
  $(printf '%s%s%s' "$C_BLD" "If skipped" "$C_RST"): MARVIN still works for code, but the graph MCP
    tools return empty results so MARVIN falls back to grep + read.
    Slower and less accurate on structural questions. Install later with
    'pipx install graphifyy' (or 'pip install --user graphifyy').
EOF
  case "$(prompt_install 'graphifyy' 'Y'; echo $?)" in
    0)
      if command -v pipx >/dev/null 2>&1; then
        info "running: pipx install graphifyy"
        if pipx install graphifyy; then
          ok "graphify installed via pipx"
        else
          warn "pipx install failed — try 'pip install --user graphifyy'"
        fi
      elif command -v pip3 >/dev/null 2>&1; then
        info "pipx not found — falling back to: pip3 install --user graphifyy"
        if pip3 install --user graphifyy; then
          ok "graphify installed via pip --user"
          dim "  ensure ~/.local/bin is on your PATH"
        else
          warn "pip install failed — install manually and re-run setup"
        fi
      else
        warn "neither pipx nor pip3 found on PATH — install Python 3 first"
      fi ;;
    1) warn "skipped this run — will ask again next time" ;;
    2) prefs_add_skip graphify; warn "marked never — recorded in $PREFS_FILE" ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────
# Dep 3 — Playwright Chromium

setup_chromium() {
  hdr "3/3 — Playwright Chromium"
  if [ -d "$HOME/Library/Caches/ms-playwright" ] || [ -d "$HOME/.cache/ms-playwright" ]; then
    ok "already installed (Playwright cache present)"
    return 0
  fi
  if prefs_has_skip chromium; then
    dim "previously skipped (delete $PREFS_FILE to re-prompt)"
    return 0
  fi

  cat <<EOF
  $(printf '%s%s%s' "$C_BLD" "What it gives you" "$C_RST"): the marvin-playwright MCP — MARVIN can drive
    a real browser against localhost / LAN URLs (screenshots, click flows,
    DOM inspection).
  $(printf '%s%s%s' "$C_BLD" "If skipped" "$C_RST"): marvin-playwright MCP doesn't register. Everything
    else works. Install later with 'npx playwright install chromium' or
    set MARVIN_PLAYWRIGHT=0 to silence the doctor warning.
EOF
  case "$(prompt_install 'playwright chromium' 'Y'; echo $?)" in
    0)
      info "running: npx playwright install chromium"
      if npx playwright install chromium; then
        ok "chromium installed"
      else
        warn "npx playwright install failed — install manually and re-run setup"
      fi ;;
    1) warn "skipped this run — will ask again next time" ;;
    2) prefs_add_skip chromium; warn "marked never — recorded in $PREFS_FILE" ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────
# Main

require_node

cat <<EOF
${C_BLD}MARVIN setup${C_RST} — interactive install of optional dependencies.
${C_DIM}  • Y     install now
  • n     skip this run (ask again next time)
  • never don't ask again (recorded in ${PREFS_FILE})${C_RST}
EOF

setup_claude_cli
setup_graphify
setup_chromium

hdr "done"
ok "setup complete — start MARVIN with: bin/marvin"
if [ -f "$PREFS_FILE" ]; then
  dim "  preferences saved: $PREFS_FILE"
fi
