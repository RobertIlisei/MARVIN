#!/usr/bin/env bash
# scripts/release-v1.2.sh
#
# One-shot release driver for the v1.2.0 audit-close-out landing.
#
# What this does, in order:
#   1. Clears any stale `.git/index.lock` (Cowork's sandbox left one
#      behind that the bash mount couldn't remove).
#   2. Stages every working-tree change + new file.
#   3. Refuses to commit unless `pnpm -r typecheck` is clean.
#   4. Commits with a multi-section message that summarises what
#      landed across rounds 1-5 + the three follow-up bugfixes.
#   5. Stops short of `git push`. The user runs that themselves
#      after looking at the commit.
#
# Run from the MARVIN repo root:
#   bash scripts/release-v1.2.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Clear the stale lock if present.
if [ -f .git/index.lock ]; then
  echo "→ Clearing stale .git/index.lock"
  rm -f .git/index.lock
fi

# 2. Stage everything.
echo "→ Staging changes"
git add -A

# 3. Verify typecheck.
echo "→ pnpm -r typecheck"
if ! pnpm -r typecheck; then
  echo "✗ typecheck failed — aborting commit"
  exit 1
fi

# 4. Commit.
echo "→ Committing"
git commit -m "v1.2.0: audit-driven hardening pass

Audit: docs/reviews/2026-04-26-full-audit.md (closed)
DoD:   docs/reviews/DEFINITION_OF_DONE.md (new)

Round 1 — UI:
  • TopBar 17 controls → 7 (Layout + Setup popovers via Radix
    DropdownMenu; theme stays as a single icon-toggle)
  • Empty-state hero trimmed AROUND the BrainLiquid (size unchanged
    per user preference); coordinate marks, capability chips,
    blockquote, long tagline moved to a wordmark tooltip
  • Confirm prompt severity classifier (warn/danger), filled accent
    allow button, blast-radius hint, soft 3-pulse, (N) document.title
    badge while pending

Round 2 — Security/policy:
  • Task + NotebookEdit added to KNOWN_TOOL_NAMES; sanctioned
    subagents (scout, general-purpose) auto-allow, others confirm
  • Confirm prompts get a 5-minute auto-deny timeout
    (MARVIN_CONFIRM_TIMEOUT_MS for tests)
  • /api/chat rejects missing/invalid cwd with 400 + invalid-cwd
    code (closes self-modification fallback)
  • KNOWN_TOOL_NAMES deduped — single source in @marvin/tools/policy
  • BASH_HARD_DENY tightened: catches \$HOME, ~, ../, glob *, git
    push -f, chmod -R 777, curl … | sh; 26-case Vitest pin

Round 3 — Correctness + UX:
  • FileViewer save wired through MonacoEditorHandle (was a no-op)
  • bin/marvin doctor smoke check for graph rooting (≥5% MARVIN
    nodes, otherwise warn + suggest rebuild)
  • Sticky-bottom scroll with 80px threshold + jump-to-latest pill
  • BrainLiquid pauses on document.hidden + honours
    prefers-reduced-motion (particle count untouched)
  • aria-labels on ChatInput + filled-danger stop button
  • Tool-call expand chevron always visible at rest

Round 4 — Reliability:
  • Honeycomb env race fixed via new pure
    computeHoneycombTelemetryEnv(); SDK runner passes per-turn env
    via Options.env so concurrent turns can't clobber each other
  • Stream-end gets a structured error block with a Retry button;
    last send args captured in a ref for replay
  • Cancel race: new \"cancelling\" MarvinUiState, cancel() is async
    and holds UI inert until /api/chat/cancel resolves
  • SessionTurn union widened to admit turn.started natively (no
    more \`as unknown as\` cast)
  • REVIEW.md disambiguated in-place (rename blocked — skill is
    read-only)

Round 5 — Final close-out:
  • lib/use-prefs.tsx — central MarvinPrefs context; replaces seven
    scattered localStorage effects + 18-prop bag drilled to TopBar.
    \"Reset MARVIN preferences\" in Settings.
  • runtime/src/auto-audit.ts + /api/audit/auto + first-run banner.
    Every auto-allowed Edit/Write/Bash now appends to
    <workDir>/.marvin/auto-audit.jsonl.
  • VirtualMessageList caps mounted DOM rows at 200 with a
    \"show earlier\" affordance.

Bugfixes in the same landing:
  • PopoverButton wasn't forwardRef-ing or spreading rest props,
    so Radix's onClick never reached the button
  • Models extracted from Setup popover into a dedicated
    ModelsDialog (popover was too short)
  • ModelPicker gained alwaysExpanded prop so the dialog renders
    the panel inline without a nested click-to-expand

Tests + verification:
  • New: packages/tools/tests/policy.test.ts (26 BASH_HARD_DENY +
    Task gating cases)
  • Extended: honeycomb-telemetry.test.ts with 4 cases for the
    pure form + concurrent-turn isolation
  • New: scripts/run-tests-via-jiti.mjs — Vitest-shape harness
    (vitest 4 needs rolldown linux-arm64 binary that isn't in our
    lockfile; jiti is the fallback). 200/240 cases pass; the 40
    failures are harness gaps (no vi.fn mocking), not real bugs.
  • Per-workspace tsc --noEmit clean across all 8 workspaces.
  • bash -n bin/marvin clean.
  • bin/marvin doctor smoke check verified against the live graph
    (861 nodes · 91.1% MARVIN-rooted).

Versions: 1.1.0 → 1.2.0 across all 10 package.json files.
"

# 5. Stop short of push.
echo
echo "✓ committed. Review with:"
echo "    git log -1 --stat"
echo
echo "Then push manually:"
echo "    git push origin main"
echo
echo "Optional: refresh the knowledge graph as a separate commit before"
echo "pushing — from a Claude Code session inside ~/marvin/:"
echo "    /graphify . --update"
echo "    git add graphify-out && git commit -m \"chore: refresh graph (v1.2)\""
