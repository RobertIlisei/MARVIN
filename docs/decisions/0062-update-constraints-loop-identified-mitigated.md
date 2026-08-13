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
