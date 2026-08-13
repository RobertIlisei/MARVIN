# ADR-0061 — File tree renders a flat list; `OutlineGroup` is retired

**Status:** Accepted — 2026-08-06
**Touches:** `MARVINLogic/FileTree.swift` (new — `FileNode` moved here plus
`flattenFileTree` / `allDirectoryPaths`), `MARVIN/FileTreeView.swift` (flat
`List` + `ForEach`, self-drawn indent + chevron, `expanded: Set<String>`),
`MARVIN/FileTypes.swift` (wire envelope only), `MARVINTests` (25 new
assertions). Settles the deferral in
[ADR-0018](./0018-phase-3-files-source-control-native.md) §5 and supersedes the
mitigation in [ADR-0056](./0056-file-tree-outlinegroup-crash-treewide-id.md).

## Context

ADR-0018 §5 deferred the `OutlineGroup`-vs-`NSOutlineView` decision pending a
frame-rate measurement on a real ~5k-file repo. That measurement never became
the deciding factor. Four separate app-killing crashes did:

| Fix | Shape that trapped the coordinator |
|---|---|
| `3a22b76` | sidebar list reconcile while a folder was expanded |
| `e20e0ca` | a directory whose children keypath returned a non-nil `[]` |
| `0161ad7` (ADR-0056) | a `path` id duplicated anywhere in the WHOLE tree |
| 2026-08-03 | a directory flipping branch→leaf under a stable `id` |

All four are the same failure: `List` + `OutlineGroup` drives AppKit's
`NSOutlineView` through SwiftUI's `OutlineListCoordinator`, which keeps
lazily-loaded row entries **alongside** the SwiftUI view list. When the two
disagree it does not degrade — it calls `_assertionFailure` (SIGTRAP) and takes
the process down. The last one is the sharpest illustration: it was *caused* by
the fix before it. Mapping an empty directory to `nil` (to dodge crash #2) let a
folder become a leaf while keeping its identity, so AppKit still held child row
entries for a node that no longer had children.

Each fix removed one way for the two models to disagree. None removed the
disagreement, because that state is not ours to keep consistent. MARVIN's own
usage guarantees churn: an agent mutates files mid-turn, and the tree re-fetches
on every turn plus a 15 s poll. The supply of novel reshapes between diffs is
effectively unbounded, and the failure mode is a hard crash rather than a
glitch.

The pattern was also invisible to tests. `FileNode` lived in the app target,
which `MARVINTests` cannot link, so every fix was verified by running the app
and waiting to see whether it died again.

## Decision

**Render the tree as a flat list and own the expansion state.**

1. **`flattenFileTree(roots, expanded:) -> [FileTreeDisplayRow]`** in
   `MARVINLogic` does a depth-first walk, emitting a row per visible node with
   its `depth`, `isExpandable`, and `isExpanded`. Pure and **total** — no tree
   shape can make it trap. It also refuses to descend into a path it has
   already emitted, so a symlink loop terminates instead of hanging the app.
2. **The view is `List { ForEach(rows) }`.** No `OutlineGroup`, therefore no
   `OutlineListCoordinator`, therefore none of the four crashes can recur. The
   row draws its own indent (`depth × 14pt`) and disclosure chevron.
3. **Expansion is a `Set<String>` of absolute paths** owned by `FileTreeView`.
   Path-keyed, not id-keyed, so a directory that loses and regains its last
   child stays open across the change.
4. **`FileNode` moved to `MARVINLogic`** so the invariants are unit-pinned.
   `id` still encodes branch-ness — identity is no longer load-bearing against
   a coordinator, but a shape change should still be a row replacement rather
   than a row whose chevron contradicts its contents.
5. **`deduplicatedTreeWide` (ADR-0056) stays.** It is no longer crash
   protection; it prevents a duplicate path from rendering the same file twice
   and — since expansion is path-keyed — from toggling both copies at once.

### What the user sees

Unchanged, by intent: same sidebar chrome, same indent step, same
selection/badges/context menu, roots collapsed on load. Clicking the chevron
toggles; clicking the row selects. The one deliberate difference is that an
empty directory has no chevron at all, rather than a triangle that expands into
nothing.

## Consequences

- The entire `OutlineListCoordinator` crash class is **structurally** gone, not
  narrowed. That is the point: three of the four prior fixes each looked
  sufficient at the time.
- Tree logic became testable. 25 assertions now cover branch-ness, identity
  across an empty/non-empty flip, depth nesting, cycle termination, and
  expansion surviving a directory emptying and refilling.
- We now own expansion state, which `OutlineGroup` kept for free. That is a
  feature here: "expand all", "reveal path", and persisting expansion across
  launches were previously unreachable inside AppKit's private state.
- Flattening runs per render. It walks only the EXPANDED subtree, so a
  collapsed directory costs one row rather than its whole subtree. A cache
  would need invalidating on every poll, every git-status change, and every
  toggle — which is exactly the staleness that caused the crashes.
- ADR-0018 §5's open question is closed **without** the perf measurement it
  asked for. If frame drops appear on a very large tree with much of it
  expanded, the answer is row virtualisation or `NSOutlineView` via
  `NSViewRepresentable` — not a return to `OutlineGroup`.

## Rejected alternatives

- **Another targeted fix** (the fifth). Rejected: the previous four each closed
  a real hole and the crash returned anyway, and fix #4 was *caused* by fix #3.
  The evidence says the abstraction is wrong, not the parameters.
- **`NSOutlineView` directly via `NSViewRepresentable`.** More code, an AppKit
  data source to keep in sync, and it reintroduces exactly the two-models
  problem — just with us maintaining both. Worth revisiting only if flat-list
  perf becomes a measured problem.
- **Keeping `OutlineGroup` with animations disabled.** That was the v0.1.26
  mitigation. The 2026-08-03 crash arrived through `recursivelyDiffRows`, not
  the animator, so it never covered the general case.

## Scope of Done

- [x] `flattenFileTree` + `allDirectoryPaths` + `FileTreeDisplayRow` in
      `MARVINLogic`; pure, total, cycle-safe.
- [x] `FileNode` + `deduplicatedTreeWide` moved to `MARVINLogic`; `FileTypes`
      keeps the wire envelope; all call sites import the module.
- [x] `FileTreeView` renders `List` + `ForEach`; self-drawn indent + chevron;
      path-keyed `expanded` set; chevron toggles without changing selection.
- [x] No `OutlineGroup` reference remains in the render path.
- [x] 25 new `MARVINTests` assertions (167 total, green); `swift build` clean.
- [x] ADR-0018 §5 deferral marked settled here; ADR-0056's sanitiser retained
      with its rationale restated.
