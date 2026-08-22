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
