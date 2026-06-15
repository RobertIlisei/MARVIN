#!/usr/bin/env bash
# install-skills.sh
#
# Install the Anthropic skills MARVIN leans on at user-level
# (~/.claude/skills/). Idempotent — skips anything already present.
#
# The repo vendors ONLY the 4 MARVIN-adopted skills (no upstream source) at
# `.claude/skills/` — those copy straight across, no network. The upstream
# Anthropic skills are NOT committed (too big for the public repo; open-source
# tidy 2026-06-15); this script shallow-clones `anthropics/skills` from GitHub
# to fetch them on demand. (Drop the upstream copies into `.claude/skills/`
# locally to restore the offline fast path for them.)
#
# Skills cover: design (frontend-design, canvas-design, theme-factory,
# brand-guidelines), productivity (doc-coauthoring, docx, pdf, pptx),
# data (xlsx), engineering (claude-api, mcp-builder, webapp-testing,
# web-artifacts-builder, skill-creator), operations / PM (internal-comms).
#
# MARVIN-adopted skills (not in anthropics/skills; bundle-only source):
#   pr-review, security-audit, systematic-debugging, test-driven-development.
# These are ports of third-party open-source skills from Jesse Vincent's
# Superpowers (obra/superpowers) and Garry Tan's gstack (garrytan/gstack).
# Attribution lives at the bottom of each SKILL.md.
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
  # Anthropic-authored (upstream)
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
  # MARVIN-adopted — ported / adapted from third-party open-source.
  # These don't exist in anthropics/skills; the bundle is their only source.
  pr-review
  security-audit
  systematic-debugging
  test-driven-development
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
