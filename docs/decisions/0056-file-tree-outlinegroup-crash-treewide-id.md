# ADR-0056 — File-tree crash: enforce whole-tree id uniqueness; schedule the NSOutlineView migration

**Status:** Accepted — 2026-07-24
**Touches:** `FileTypes.swift` (`FileNode.deduplicated`, `[FileNode].deduplicatedTreeWide`,
`FileTreeResponse.treeWideUnique`), `FileTreeView.swift` (sanitise the fetched
tree before it reaches `OutlineGroup`). Supersedes the per-symptom crash patches
in `FileTreeView` (v0.1.26 animation-disable; empty-dir→leaf; sibling dedup) —
none of which held. Revisits the `OutlineGroup`-vs-`NSOutlineView` question
deferred by [ADR-0018 §5](./0018-native-file-tree.md).

## Context

The macOS app hard-crashed three times (2026-07-23 00:37, 2026-07-23 21:07,
2026-07-24 14:42) with a **byte-identical** signature:

```
EXC_BREAKPOINT (SIGTRAP)  com.apple.main-thread
  libswiftCore  _assertionFailure(_:_:file:line:flags:)
  SwiftUI       ViewListTree.visitItem(_:force:)
  SwiftUI       OutlineListCoordinator.outlineView(_:child:ofItem:)
  AppKit        loadItemEntryLazyInfoIfNecessary
  AppKit        -[NSOutlineView _recursiveCollapseItemEntry:…]
  SwiftUI       OutlineListCoordinator.recursivelyDiffRows(…)
```

The sidecar was healthy throughout — this is the **SwiftUI app** trapping while
its `OutlineGroup` file tree (`FileTreeView`) reconciled rows. `visitItem`
asserting from `outlineView(_:child:ofItem:)` during lazy child load is the
textbook fingerprint of a **duplicate identifier in the tree**: `OutlineGroup`
requires ids unique across the WHOLE tree and traps on the first duplicate it
visits.

`FileNode.id` is the absolute path. The tree is fully **replaced on every
refresh** (`model.refresh` → `fetchTree`), and refreshes are frequent (per-turn
git-status badges + a 15 s poll). Three prior fixes each addressed a *different*
symptom and none enforced the actual invariant:

- v0.1.26 disabled list animations (the crash still fires without the animator);
- empty directories collapse to leaves (a branch↔leaf shape guard);
- `outlineChildren` dedupes **siblings** only.

A duplicate path in two *different* branches — the sidecar walk racing a
mid-session file mutation (an agent creating/moving files while the tree is
walked), or a case-fold collision on APFS — is not caught by sibling dedup, and
traps `visitItem`. The code's own comment even claims "IDs unique across the
WHOLE tree", but that was never enforced.

## Decision

### 1. Enforce whole-tree id uniqueness (the fix)

Before the fetched tree reaches `OutlineGroup`, sanitise it so every `path`
appears once: a single recursive pass tracking seen paths in a `Set<String>`,
pruning any node whose path was already seen anywhere (`deduplicatedTreeWide`).
`FileTreeView.refresh` stores `res.treeWideUnique()` instead of the raw response.
No-op for well-formed trees; a malformed tree degrades gracefully (a duplicate
subtree is dropped) instead of taking down the app. This matches the observed
crash signature (duplicate-id `visitItem` assert) directly, and closes the gap
between the id contract's stated invariant and its enforcement.

### 2. Schedule the NSOutlineView migration (the durable fix)

`OutlineGroup` has now required **four** crash patches on this one view; it is
structurally fragile for a large, frequently-replaced, externally-mutated tree.
ADR-0018 §5 explicitly deferred the `OutlineGroup`→`NSOutlineView` decision. A
custom `NSViewRepresentable` around `NSOutlineView` — owning its data source,
diffing, expansion, and selection — removes this entire class of framework-diff
assertion AND preserves expansion state across refreshes (which the SwiftUI path
loses on any structural change). That migration is scoped as the durable fix and
tracked on the roadmap; it is **not** done here because it is a substantial
AppKit rewrite of an ~800-line view that cannot be visually verified in the same
change, and shipping it blind alongside a crash fix would risk a worse
regression. Fix #1 is the low-risk, targeted, ship-now change; the migration is
the follow-up.

## Consequences

- **Positive.** The duplicate-id trap — the exact observed signature — can no
  longer reach `OutlineGroup`. Correct regardless of the migration; the tree is
  always well-formed at the view boundary.
- **Honest limit.** The crash is not reproducible on demand, so this cannot be
  *certified* gone by test — it is verified by (a) matching the crash signature
  to the duplicate-id cause and (b) a clean full build. If it recurs after this,
  that is the trigger to execute the NSOutlineView migration (#2), not another
  per-symptom patch. No fifth `OutlineGroup` band-aid.
- **Cost.** One O(n) pass over the tree per refresh — negligible against a
  20 000-entry cap and a network fetch.

## Scope of Done

- [x] `deduplicatedTreeWide` prunes cross-branch duplicate paths; `refresh`
      applies it before `OutlineGroup` sees the tree.
- [x] Full app build compiles; sidecar suite unaffected.
- [ ] NSOutlineView migration scoped on the roadmap as the durable follow-up
      (this ADR is its trigger record).
