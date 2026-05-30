#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks the small handful of git / shell shapes
# that MARVIN's Golden Rules forbid, with a reason that's surfaced back
# to Claude (per .claude/settings.json wiring).
#
# Reads tool input on stdin (the SDK passes a JSON envelope with the
# Bash command at .tool_input.command). On a match: emits a JSON deny
# decision and exits 0 — that's the canonical "block with reason"
# signal for PreToolUse hooks. On no match: exits 0 silently and Claude
# proceeds to the normal permission check.
#
# Patterns blocked here are the ones the Golden Rules call out as
# never-skip-without-explicit-user-ask: hook bypass flags, force-push
# to main, and destructive resets to a remote ref. Anything else
# (rm -rf, --force on a feature branch, etc.) is left to the existing
# permission gate so this script stays a narrow safety net rather than
# a second permissions system.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  # No jq → can't parse the envelope, fail open. The shared permission
  # gate is still in front of every Bash call; this hook is defence in
  # depth, not the primary check.
  exit 0
fi

INPUT="$(cat)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"

if [ -z "$COMMAND" ]; then
  exit 0
fi

deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# git hook / signature bypass — Golden Rule: investigate, don't skip.
if printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:]])--no-verify($|[[:space:]])'; then
  deny "Refusing --no-verify. Pre-commit hooks fail for a reason — investigate the underlying error and fix it. If skipping is genuinely the right call, ask the user first and they can re-run."
fi
if printf '%s' "$COMMAND" | grep -Eq '(^|[[:space:]])--no-gpg-sign($|[[:space:]])|-c[[:space:]]+commit\.gpgsign=false'; then
  deny "Refusing to bypass GPG signing. Ask the user before disabling commit signatures."
fi

# git push --force to main/master — never, even with the user's blanket
# approval of git push elsewhere.
if printf '%s' "$COMMAND" | grep -Eq 'git[[:space:]]+push.*(--force|--force-with-lease|-f([[:space:]]|$)).*[[:space:]](origin[[:space:]]+)?(main|master)([[:space:]]|$|:)'; then
  deny "Refusing force-push to main/master. Even with prior 'git push' approval, force-push to a protected branch needs an explicit confirmation for this specific push."
fi

# git reset --hard origin/<anything> — overwrites local work with whatever
# the remote currently has; near-impossible to undo if you had unpushed
# changes. Block and let the user authorise per-case.
if printf '%s' "$COMMAND" | grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard[[:space:]]+origin/'; then
  deny "Refusing 'git reset --hard origin/…'. Discards local commits irreversibly. If this is intended, the user should run it themselves."
fi

exit 0
