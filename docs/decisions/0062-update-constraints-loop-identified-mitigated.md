# ADR-0062 — The `_postWindowNeedsUpdateConstraints` crash: identified, mitigated, not yet fixed

**Status:** Accepted (mitigation) — 2026-08-07
**Touches:** `CrashDiagnostics.swift` (exception capture + `NSApplicationCrashOnExceptions`),
`MARVINApp.swift` (install hooks first), `Info.plist`. Supersedes two failed
speculative fixes (`ChatInputView` `roomAbove` freeze, 2026-08-06; the file-tree
work in [ADR-0061](./0061-file-tree-flat-list-not-outlinegroup.md) was a
different, real crash).

## Context

MARVIN died four times with an identical stack (2026-08-02, -08-05, -08-07
00:45, -08-07 09:13): an uncaught `NSException` from
`-[NSWindow(NSDisplayCycle) _postWindowNeedsUpdateConstraints]`, ending at
`+[NSApplication _crashOnException:]` (SIGTRAP).

**The `.ips` reports carry a backtrace but no exception `name` or `reason`**, and
nothing reached the unified log. Two fixes were attempted against a mechanism
inferred from the stack alone. Both failed — the second (freezing the slash-popup
geometry measurement) was disproven by a crash whose `slice_uuid` matched the
rebuilt binary exactly.

The lesson, and the reason this ADR exists: **two guesses cost more than one
diagnostic.** Instrumenting first would have been cheaper on attempt one.

## What it actually is

`CrashDiagnostics.swift` captured it on the first occurrence after install:

```
name:   NSGenericException
reason: The window has been marked as needing another Update Constraints in
        Window pass, but it has already had more Update Constraints in Window
        passes than there are views in the window.
        <SwiftUI.AppKitWindow: 0x1027d2070> {{0, 90}, {2560, 1320}}
```

This is AppKit's **loop breaker** for a non-converging Auto Layout pass. The
captured stack shows the loop closing inside SwiftUI, not in MARVIN:

```
-[NSView _updateConstraintsForSubtreeIfNeeded…]      ← the constraint pass
  NSHostingView._willUpdateConstraintsForSubtree
    NSHostingView.cancelAsyncRendering
      NSHostingView.setNeedsUpdate()
        -[NSView setNeedsUpdateConstraints:]         ← re-marks the window
          → _postWindowNeedsUpdateConstraints        ← mid-pass ⇒ throw
```

The constraint pass itself causes the window to need another constraint pass.
AppKit counts passes against the window's view count and raises when exceeded.
Two `_NSConstraintBasedLayoutHostingView` frames appear in the ancestor chain —
nested hosting views — and MARVIN creates none of them itself, so the nesting
and the re-invalidation are both SwiftUI's.

### Ruled out by experiment, not by argument

- **`RichText.updateNSView` re-setting its text storage.** Plausible on timing
  (`RichText` shipped 2026-08-01 22:34; the first crash was 08-02) and would
  invalidate intrinsic size on every update. Tested directly by rebuilding the
  TextKit-1 stack and comparing: `textStorage.isEqual(to:)` **holds** after
  `setAttributedString`, so the guard works and the storage is not re-set.
- **The slash-popup geometry cycle** (`roomAbove` → `popupMaxHeight` → a popup
  sized above the measured view). A real cycle, fixed on 2026-08-06 and kept,
  but not this crash: the next occurrence had a byte-identical stack.

## Decision

**Mitigate now, keep the root cause visible.**

`UserDefaults.register(defaults: ["NSApplicationCrashOnExceptions": false])`.

Justified narrowly by what the exception *is*: a layout pass that failed to
converge. It is not a broken invariant in MARVIN's data, and the cost of
continuing is a stale frame — against which the current behaviour costs the user
an entire session. The loop is inside SwiftUI, so there is no line of our code
to correct.

It is written to the **registration** domain, the lowest-priority one, so it is a
default rather than an override:
`defaults write net.marvin.macos NSApplicationCrashOnExceptions -bool YES`
restores crashing.

Every occurrence is still recorded in `~/Library/Logs/MARVIN/exceptions.log`, so
the non-convergence stays observable. **An entry with no matching `.ips`
afterwards is the mitigation working.**

## Consequences

- This is a **mitigation, not a fix**. The layout pass still fails to converge;
  the app now survives it.
- Unverified until the next occurrence — the mitigation cannot be proven without
  reproducing a crash that takes hours of real use to appear. The log format is
  designed so the answer is unambiguous when it happens.
- Root cause remains open: what drives continuous invalidation of the main
  window's hosting view. Candidates (unproven) are the high-frequency observable
  updates the main window reads — health poll, git-status poll, context/cost
  counters, streaming turn text. The next step is to measure which of these
  mutate observable state during a layout pass, **not** to guess again.

## Scope of Done

- [x] Exception `name` + `reason` + full stack captured to a durable log, via a
      swizzle of `-[NSApplication reportException:]` plus
      `NSSetUncaughtExceptionHandler`.
- [x] Session-start stamp records which hooks are armed and whether
      crash-on-exception is active — added after the first hook attempt
      (`NSPrincipalClass`) failed SILENTLY under SwiftUI.
- [x] `RichText` storage-equality hypothesis tested and rejected before shipping.
- [x] `NSApplicationCrashOnExceptions` registered false, reversible by the user.
- [x] Root cause documented as OPEN, with the ruled-out branches recorded so the
      next attempt doesn't re-walk them.

## Addendum (2026-08-18) — the mitigation was blind, and the crash is still fatal

Two crashes overnight, 02:04:04 and 02:21:22, both `EXC_BREAKPOINT / SIGTRAP`
with **identical** stacks:

```
+[NSApplication _crashOnException:]
_NSViewLayout ← NSPerformVisuallyAtomicChange ← -[NSView _layoutSubtreeWithOldSize:]
← -[NSWindow _layoutViewTree] ← NSDisplayCycleFlush ← CA::Transaction::commit()
```

Only two frames belong to us, both `main()`. This is the same non-converging
Update-Constraints loop this ADR opened — the exception text was captured once,
on **2026-08-07**, via `NSSetUncaughtExceptionHandler`:

> NSGenericException: The window has been marked as needing another Update
> Constraints in Window pass, but it has already had more Update Constraints in
> Window passes than there are views in the window. `<SwiftUI.AppKitWindow>`

**The instrumentation this ADR added has never fired.** Measured: **24 session
starts, 0 exceptions captured** by the `reportException:` swizzle. The reason is
a method mismatch — the hook swizzles the INSTANCE method
`-[NSApplication reportException:]`, while AppKit's layout error path calls the
CLASS method `+[NSApplication _crashOnException:]` directly. Different methods
on different metaclasses; hooking one never hooks the other.

So the session-start stamp asserting *"exceptions are logged and survived"* was
false precisely for the crash class this ADR exists to diagnose. Both crashes
died writing nothing.

### Fixed

- **`+[NSApplication _crashOnException:]` is now swizzled too** — verified the
  selector resolves as a class method on the live class. It logs, then calls
  through: the process is going down either way, and pretending otherwise is
  what made the old stamp misleading.
- **The view tree is dumped with the exception** (`recordWindowTree`, capped at
  400 nodes). The reason this bug has stayed open is that the exception names a
  *window* but never the *view* that keeps invalidating; two fixes were
  previously inferred from the stack alone and both were disproved. The next
  occurrence should name the culprit.
- **The stamp no longer lies**: it now distinguishes non-layout exceptions
  (logged and survived) from AppKit layout-cycle exceptions (still fatal).

### Not fixed

The root cause. This addendum buys evidence, not a cure — deliberately, given
this ADR's own history of confident fixes that a byte-identical stack later
disproved. Ruled out as contributors by this occurrence: the plans live at crash
time held 4–5 steps and **zero** sub-tasks, so plan rendering was not the
trigger, and `RichText` already measures on a static offscreen text stack.

## Addendum 2 (2026-08-18) — the hook fired, and what it named

First capture in 11 days. `+[NSApplication _crashOnException:]` logged the
exception **with the view tree**:

```
NSGenericException — …more Update Constraints in Window passes than there are
views in the window
```

Of **401 views** in that window, exactly **one** was still dirty:

```
AppKitWindowHostingView<ModifiedContent<AnyView, RootModifier>>
    constraints=40  needsUpdate=true
```

Everything else had settled. So the non-converging view is the **SwiftUI root
hosting view**, not a leaf — and it is wrapped in `AnyView`.

Supporting shape from the same capture: `DocumentView` / `PlatformGroupContainer`
at **4065 pt** inside a **1320 pt** window; a `SwiftUIOutlineListView` with 37
`ListTableCellView` → `NSHostingView<AnyView>` cells; 60 `SwiftUIAppKitButton` +
60 `ContentViewHost`.

### Why this is still not a fix

The tree says WHICH view fails to settle. It does not say WHO keeps dirtying it —
by the time `_crashOnException:` runs, the invalidation storm is over. Naming a
suspect from view-type names is precisely how this ADR previously produced two
confident fixes that a byte-identical stack disproved. `ChatPreviewView.trayRows`
(which builds `[AnyView]`) is the best match in our code, but that is an
inference, not evidence.

### Pass counter added instead

`ConstraintStorm` swizzles `-[NSView setNeedsUpdateConstraints:]` and counts
invalidations in a rolling **0.5 s** window. At **150** — well below the ~401
needed to trip AppKit's own breaker, so it fires *before* the fatal pass — it
records the triggering view, its ancestry, and **`Thread.callStackSymbols`**.

That stack is the missing evidence: it names the code path doing the
invalidating, which turns the next occurrence from "which view is dirty" into
"which of our code dirtied it".

Cost when healthy is one integer increment per call; everything expensive sits
behind the threshold, and a 20 s cooldown means the diagnostic cannot itself
become the pathology. The session-start stamp reports whether it armed —
the same lesson as the original hook, which sat un-armed and silent for 24
sessions because nothing said otherwise.

## Addendum 3 (2026-09-01) — the storm counter named our own structure, and it was fixed

MARVIN died again: `MARVIN-2026-09-01-164458.ips`, pid 1295, up 78 minutes,
`EXC_BREAKPOINT / SIGTRAP` through `+[NSApplication _crashOnException:]` with
the same `NSGenericException` this ADR opened with — 78 views in the window,
more Update Constraints passes than that.

**This is the occurrence the pass counter was added for.** Five storms fired
before the fatal pass (`exceptions.log:2058–2190`), and for the first time in
this ADR's history the captured stack names MARVIN's own layout rather than
"somewhere in SwiftUI":

```
SystemSplitView.updateNSViewController
 → SplitViewCoordinator.formCurrentItems
  → SplitViewContentProvider.updateRootViewForItem
   → NSHostingView.setRootView          ← re-roots a hosting view mid-pass
    → NSHostingView.setNeedsUpdate
     → NSView.setNeedsUpdateConstraints ← re-dirties the window
```

The ancestry is the diagnosis. **A split view inside a split view:**

```
NSHostingView<NavigationPaneModifier> constraints=122
 _NSSplitViewItemViewWrapper → NSSplitView → NSView
  AppKitPlatformViewHost<…SystemSplitView>      ← inner
   NSHostingView<NavigationPaneModifier>
    _NSSplitViewItemViewWrapper → NSSplitView
     AppKitPlatformViewHost<…SystemSplitView>   ← outer
      AppKitWindowHostingView<ModifiedContent<AnyView, RootModifier>>
```

`ContentView` put a `VSplitView` (brain over chat) inside the main
`HSplitView`. Each bridges to its own `NSSplitView`. The outer split's update
pass re-roots the inner split's hosting view, which marks the window as needing
another pass — a ring that cannot converge, and AppKit raises once the passes
outnumber the views.

### Fixed

The inner `VSplitView` is gone, replaced by `MarvinDivider()` plus a drag
gesture (`ContentView.brainDivider`). This is not a new idea: `LeftPane`
made the identical move on 2026-08-31 and recorded why —
*"A plain divider with a drag gesture, NOT a `VSplitView` … losing the bridge
also removes the ideal-size guessing it forced, and
`_NSSplitViewItemViewWrapper` was among the constraint-storm triggers."* One
level of nesting was left; this removes it. The main window now holds exactly
one `HSplitView`.

Divider persistence moved from `SplitViewAutosave(name: "marvin.right")` to
`@AppStorage("marvin.brainHeight")` — plain `UserDefaults`, no view inserted
into the hierarchy, which is the constraint v0.1.93's `WidthReporter` taught.

### Why the count mattered, and what to watch

The roadmap's standing entry on this bug notes that after the `LeftPane`
deadband fix the CPU symptom resolved but **the storm count did not move: five
per launch, before and after**. Five is also the count in this crash. If five
storms per launch persist after this change, the remaining oscillator is a
third path and the ancestry will say so — the capture format is now proven to
name the culprit. If the count drops, the nesting was the source.

**Still not claimed:** that ADR-0062 is closed. This fixes the ring this crash
captured. The mitigation note stands — `NSApplicationCrashOnExceptions: false`
does not cover this exception, because AppKit calls `_crashOnException:`
directly on the layout path, so any future occurrence is still fatal and still
logged with its view tree.

## Addendum 5 (2026-09-08) — a fourth oscillator, and a breaker at the call that raises

MARVIN died again: `MARVIN-2026-09-09-010641.ips`, v0.1.106, while the user
dragged the left divider with the **Practice** pane open ("this i minimized and
marvin crashed"). Same `NSGenericException`, fatal through
`+[NSApplication _crashOnException:]`, from `-[NSSplitView mouseDown:]`'s
tracking loop. Fourth occurrence in eight days — 2026-09-01 (v0.1.101),
2026-09-03 ×2 (v0.1.103), now v0.1.106 — each after a different oscillator had
been removed. The captured stack this time:

```
NSHostingView.updateConstraints
 → -[NSView(NSConstraintBasedLayoutInternal) _prepareForTwoPassConstraintsUpdateIfNeeded]
  → NSView.marvin_setNeedsUpdateConstraints        ← our swizzle, already on the path
   → -[NSView setNeedsUpdateConstraints:]
    → -[NSView _informContainerThatSubviewsNeedUpdateConstraints] ×5
     → -[NSWindow(NSDisplayCycle) _postWindowNeedsUpdateConstraints] + 1716   ← throws
```

SwiftUI's two-pass sizing re-requests a pass from INSIDE the pass; with the
pane's collapse state written synchronously from the geometry callback, the
hosting view is re-rooted mid-pass, the second pass produces a different size,
and the ring never converges. Five storms (three on the `NavigationPaneModifier`
hosting view, two on a toolbar item) preceded the throw, as in every capture
since addendum 2.

### Decision — stop removing oscillators one at a time; cap the requests

Two changes, both shipped:

1. **`ConstraintPassBreaker`** (`CrashDiagnostics.swift`) + **`ConstraintPassBudget`**
   (`MARVINLogic`, pure, 3 tests). `-[NSWindow updateConstraintsIfNeeded]` is
   swizzled to mark when a window is inside a pass. Inside one, the existing
   `setNeedsUpdateConstraints:` swizzle counts each TRANSITION to "needs update"
   per window per run-loop turn; past `allowance = max(16, views − 16)` the
   request is not forwarded — it is coalesced per view and re-issued from the
   next turn via `DispatchQueue.main.async`, where AppKit's counter has reset.
   Forwarding it is exactly the call that raises. Requests made outside a pass
   are untouched. The first trip per launch (cap 3) is logged with the deferred
   view's ancestry so the remaining oscillator is still named.
2. **`LeftPane.updateCollapsed` writes on the next turn.** The deadband still
   decides (re-evaluated at write time); the write no longer happens inside the
   pass that measured the width.

### Why a breaker and not another fix

Addenda 1–4 each removed a real loop and the crash returned with a new
ancestry. The exception is AppKit's *own* loop breaker — its effect is a stale
frame — and it is fatal on the layout path regardless of
`NSApplicationCrashOnExceptions`. Enforcing the same limit by deferral turns
"the session dies" into "a frame per turn until it settles", which the storm
monitor makes visible. The floor/margin are conservative because passes ≤
transitions and AppKit's exact counting point is undocumented.

### What would prove it

An `exceptions.log` entry `constraint-pass breaker tripped` during a divider
drag with **no** `.ips` after it. Five storms per launch persisting means the
oscillator is still there and merely survivable — that is the intended state
until the ancestry in the trip report points at it.

## Addendum 6 — 2026-09-09: the breaker was armed and had never once fired

Fifth `NSGenericException`, same window, same reason. The user reported it as
"marvin just crashed"; `ps` first said otherwise — pid 65514 at **100.1 % CPU,
`STAT R`** — the spin signature, with `sample` showing the main thread wholly
inside SwiftUI's layout engine (688 samples in `LayoutEngineBox.sizeThatFits`,
nested through `StackLayout.placeChildren`). It threw a minute later.

**The measurement that mattered was a count, not a stack.** Across the whole
log: `constraint-pass breaker: ARMED` **8 times**, fatal exceptions **5**,
`constraint-pass breaker tripped` reports **0**. Addendum 5's mitigation had
been shipping for a day and had never engaged once.

The raising stack says why. `ConstraintPassBreaker.deferIfOverBudget` guards on
`passDepth > 0`, and `passDepth` is incremented only by the hook on
`-[NSWindow updateConstraintsIfNeeded]`. That method is nowhere on the stack:

    _postWindowNeedsUpdateConstraints                    ← throws
      _informContainerThatSubviewsNeedUpdateConstraints ×6
        NSView.setNeedsUpdateConstraints
          marvin_setNeedsUpdateConstraints               ← our hook ran, did not defer
            NSHostingView.setNeedsUpdate
              LazyLayoutViewCache.invalidateSize         ← a lazy list resizing
                NSHostingView.layout
                  NSView.layoutSubtreeIfNeeded
                    NSWindow._layoutViewTree
                      NSWindow.layoutIfNeeded            ← the pass — unhooked
                        NSDisplayCycleObserverInvoke

AppKit runs constraints from **two** entries and counts passes from both: the
explicit `updateConstraintsIfNeeded`, and the display cycle's layout phase via
`layoutIfNeeded`. The breaker recognised one. Every crash so far took the other.

**Change:** `-[NSWindow layoutIfNeeded]` opens a pass too. Looked up by
selector name (`NSConstraintBasedLayoutInternal` is a category, so there is no
`#selector` for it) and verified to resolve on `NSWindow` before shipping,
because a silent swizzle miss is the failure this file already warns about. The
session-start line now names both entries, so the next log says which armed
rather than leaving it to be inferred.

**How to tell it worked:** a `constraint-pass breaker tripped` entry in
`exceptions.log` with no `.ips` after it. Zero trips and another crash means
the pass is entered a third way.

The trigger named in frame 16 is worth recording separately: `LazyLayoutViewCache`
is the lazy list, i.e. the chat transcript. That is the same subtree
`renderWindow` was introduced to bound (2026-09-02). Four attempts to remove the
oscillator have not converged, which is why this addendum fixes the BREAKER
rather than adding a fifth.

## Addendum 7 (2026-09-10) — AppKit keeps a second counter, and it raised

Fifth crash. This time the breaker had **tripped**: `exceptions.log` shows
`constraint-pass breaker tripped: 331 in-pass transitions, 346 views in window`,
deferring a `SwiftUI.SelectionTextField` under a `HostingScrollView` in the
left pane, and *"the pass that would have raised did not"*. The process still
aborted, from a different exception:

    NSGenericException: The window has been marked as needing another Layout
    Window pass, but it has already had more Layout Window passes than there
    are views in the window.

    +[NSException exceptionWithName:reason:userInfo:]
    -[NSWindow _postWindowNeedsLayout]              ← throws
    -[NSWindow _layoutViewTree]
    -[NSWindow layoutIfNeeded]
    NSWindow.marvin_updateConstraintsIfNeeded()     ← inside our pass
    NSWindow.marvin_layoutIfNeeded()

`_postWindowNeedsLayout`, not `_postWindowNeedsUpdateConstraints`. AppKit
counts **two** things per window against the view count: transitions to
"needs an Update Constraints pass" (addenda 5 and 6) and transitions to
"needs a Layout Window pass", fed by `needsLayout = true`. The breaker
hooked the first and never saw the second.

**Change:** `-[NSView setNeedsLayout:]` is exchanged for
`marvin_setNeedsLayout(_:)`, which inside a pass applies the same budget from
a separate ledger and defers the request to the next run-loop turn. The
session-start line gains a `layout-pass breaker:` entry; a trip is logged as
`layout-pass breaker tripped`.

**The oscillator this time** was `.textSelection(.enabled)` on a notice
`Text` inside a left-pane `ScrollView` (the Sessions pane's integration
notice, added the same day). SwiftUI's selection overlay is an AppKit
representable that re-lays out during layout — a measurement view in this
ADR's terms. The three such notices in left-pane scroll views (Sessions pane,
Source Control worktrees, Source Control status) lost the modifier. The rule
for this file gains a line: no `.textSelection(.enabled)` inside a
ScrollView-rooted pane.
