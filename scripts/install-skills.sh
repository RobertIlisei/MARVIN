#!/usr/bin/env bash
# install-skills.sh
#
# Install the Anthropic skills MARVIN leans on at user-level
# (~/.claude/skills/). Idempotent — skips anything already present.
#
# Fast path: copies from the bundled mirror at `.claude/skills/` in this
# repo. No network needed. Fall-back path: when the repo bundle is
# missing a skill for any reason, shallow-clones `anthropics/skills` from
# GitHub to fetch just that one.
#
# Skills cover: design (frontend-design, canvas-design, theme-factory,
# brand-guidelines), productivity (doc-coauthoring, docx, pdf, pptx),
# data (xlsx), engineering (claude-api, mcp-builder, webapp-testing,
# web-artifacts-builder, skill-creator), operations / PM (internal-comms).
#
# Honeycomb skills ship via the honeycomb@honeycomb-plugins Claude Code
# plugin — install separately with `/plugin install honeycomb` inside
# Claude Code if you want them.
#
# Usage: bash scripts/install-skills.sh
set -euo pipefail

DEST="$HOME/.claude/skills"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$REPO_ROOT/.claude/skills"

mkdir -p "$DEST"

SKILLS=(
  brand-guidelines
  canvas-design
  claude-api
  doc-coauthoring
  docx
  frontend-design
  internal-comms
  mcp-builder
  pdf
  pptx
  skill-creator
  theme-factory
  web-artifacts-builder
  webapp-testing
  xlsx
)

# Only clone from GitHub if at least one skill is missing from the bundle.
NEED_CLONE=()
for name in "${SKILLS[@]}"; do
  [ ! -d "$BUNDLE/$name" ] && NEED_CLONE+=("$name")
done

TMPDIR=""
if [ "${#NEED_CLONE[@]}" -gt 0 ]; then
  TMPDIR=$(mktemp -d)
  trap 'rm -rf "$TMPDIR"' EXIT
  echo "[marvin-skills] bundle missing ${#NEED_CLONE[@]} skill(s); cloning anthropics/skills to $TMPDIR…"
  git clone --depth=1 --quiet https://github.com/anthropics/skills.git "$TMPDIR/skills"
fi

installed=0
skipped=0
missing=0
for name in "${SKILLS[@]}"; do
  dst="$DEST/$name"
  if [ -d "$dst" ]; then
    printf '  [skip]      %s (already installed)\n' "$name"
    skipped=$((skipped + 1))
    continue
  fi

  # Prefer bundled copy.
  if [ -d "$BUNDLE/$name" ]; then
    cp -R "$BUNDLE/$name" "$dst"
    printf '  [bundled]   %s\n' "$name"
    installed=$((installed + 1))
    continue
  fi

  # Fall back to fresh clone.
  src="$TMPDIR/skills/skills/$name"
  if [ -d "$src" ]; then
    cp -R "$src" "$dst"
    printf '  [fetched]   %s\n' "$name"
    installed=$((installed + 1))
    continue
  fi

  printf '  [missing]   %s (not in bundle or upstream)\n' "$name"
  missing=$((missing + 1))
done

echo
echo "[marvin-skills] installed: $installed  skipped: $skipped  missing: $missing"
echo "[marvin-skills] run again any time; existing skills are left alone."
