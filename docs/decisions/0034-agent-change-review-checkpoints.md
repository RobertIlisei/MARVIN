# ADR-0034 — Cursor-style review of agent edits via pre-image checkpoints

**Status:** Accepted — 2026-06-10
**Touches:** permission gate (`sdk-runner.ts`), new `change-checkpoints.ts`,
new `/api/changes/*` route family, native `ReviewChangesView.swift` +
chat-input strip.

## Context

Cursor / VS Code agent modes let the user preview every change an agent
made and accept or reject it — per hunk. MARVIN had diff *rendering*
(`DiffSheet`, `SourceControlView`, `/api/git/diff|discard`) but only against
the **git working tree vs HEAD**, which cannot express agent review:

1. **No attribution.** Working-tree dirt mixes the agent's edits with the
   user's own uncommitted work.
2. **Wrong revert baseline.** `git discard` restores HEAD. If the user had
   uncommitted changes before the agent touched a file, rejecting the
   agent's edit via discard destroys the user's work too.
3. **No in-chat surface.** Review lived in the Source Control pane, not
   where the conversation happens.

## Decision

**Per-session pre-image checkpoints, captured at the permission gate.**
The gate (`canUseTool`, both auto + gated paths) sees every main-loop
`Edit` / `Write` / `NotebookEdit` with its path *before* the write
executes. `recordPreImage` snapshots the file's content (or "did not
exist") the **first** time a session touches it — that snapshot, not git
HEAD, is the review baseline. Subagent calls never checkpoint (their
mutations are hard-denied, ADR-0030).

Store: `<dataDir>/checkpoints/<projectId>/<marvinSessionId>/` —
`manifest.json` + content blobs. **Disk-backed by design**: the gate
writes from the route chunk, the `/api/changes/*` endpoints read from
their own chunk — no shared in-memory state, so the standalone
module-isolation bug class (ADR-0031 implementation note) cannot occur.

Semantics (jsdiff `structuredPatch` / `applyPatch` / `reversePatch`):

| Operation | Effect |
|---|---|
| accept hunk | apply the hunk to the **baseline** — it stops counting as pending; a later "reject all" keeps accepted work |
| reject hunk | reverse-apply the hunk to the **file on disk** |
| accept file / all | drop the baseline(s); disk is already the truth |
| reject file / all | restore the baseline (agent-added file → delete) |

Hunk indices are positions in a server-side **recompute at request time**;
a stale index (file changed since the client fetched) misses with a 409 —
it can never corrupt. Entries whose disk content returns to baseline are
GC'd on read.

Surfaces: `GET /api/changes` (changed set), `GET /api/changes/diff`
(structured hunks), `POST /api/changes/resolve` (accept/reject ×
hunk/file/all, CSRF-guarded). Native: a live **"N files changed · Review"**
strip above the chat input (refreshes throttled per cli.event + at turn
boundaries) opens the review surface — files left, diff right, per-hunk
✓/✗, per-file and all-file actions.

### Update 2026-06-10 — own window + side-by-side diff editor

The first cut presented the review as a SwiftUI `.sheet`. A sheet is
clamped to its parent (the chat pane) and rendered a cramped single-column
unified diff with line-truncated rows — nothing like the VS Code / Cursor
diff editor users expect. Replaced with:

- A dedicated **`Window("Review Changes", id: "marvin-review")`** scene
  (default 1280×820, min 820×520, `openWindow`-driven). Real window →
  resizable, zoomable, full-screen-able, not size-bounded by the pane.
- A **side-by-side diff** (`DiffViewMode.split`, default): original left,
  modified right, each with line numbers parsed from the hunk header; a
  removed-run/added-run is paired index-by-index into modified rows,
  leftovers render as delete-only / insert-only. A **Split/Inline toggle**
  keeps the old unified view one click away. Lines wrap (`fixedSize`
  vertical) instead of truncating, and are `textSelection`-enabled.
- Because the window is a separate view tree, the model posts
  **`.marvinAgentChangesDidMutate`** after every accept/reject;
  `ChatPreviewView` observes it to keep the strip count honest across the
  window boundary. `ReviewWindowTarget` (app-scope singleton) carries the
  `(cwd, marvinSessionId)` pair from the chat view to the window scene.

## Known limitations (v1, deliberate)

- **Bash mutations are not pre-imaged** — the gate cannot know a shell
  command's write targets up front (`sed -i`, codegen, `git checkout`).
  Same blind spot as Cursor's terminal. Files first touched by Bash and
  later by Edit checkpoint at the post-Bash state.
- UTF-8 text only; binary files are not previewed.
- Baselines are per `marvinSessionId`; "Start fresh next turn" begins a
  new review scope.

## Rejected alternatives

- **Git-stash / shadow-ref baselines** — wrong baseline vs the user's
  uncommitted work (the core problem), breaks on non-repos, and races the
  user's own git operations.
- **Snapshot in `PostToolUse`** — too late; the pre-image is gone.

## Scope of Done

- [ ] Agent Edit/Write/NotebookEdit pre-images captured at the gate;
      first touch wins; outside-cwd paths ignored.
- [ ] List / diff / resolve endpoints with hunk-level accept (baseline
      advances) and reject (disk reverse-apply); stale index → 409.
- [ ] Live strip + review sheet in the native app; Swift builds.
- [ ] Unit tests pin hunk semantics, added/deleted edges, GC, bulk ops.
- [ ] Bash blind spot documented.
