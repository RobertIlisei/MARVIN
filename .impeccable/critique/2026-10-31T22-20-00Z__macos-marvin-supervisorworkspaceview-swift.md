---
target_identity: "file:macos/MARVIN/SupervisorWorkspaceView.swift"
target_path: macos/MARVIN/SupervisorWorkspaceView.swift
timestamp: 2026-10-31T22-20-00Z
slug: macos-marvin-supervisorworkspaceview-swift
---
Method: design review only (detector not applicable, native platform)
Target: the Supervisor workspace (brief §13): `SupervisorWorkspaceView.swift` (centre, header, inspector, Tabs list, Brain caption, Sessions-pane line), `SupervisorWorkspace.swift` (MARVINLogic), the re-targeted `BrainPaneView`. Renders: 15 `sup-ws-*` composites at 960 / 1440 / 1920, light and dark (90 PNGs), plus 25 Sessions-pane states, 3 rail states and 17 chat states (158 PNGs). All 248 opened.
Harness limit: the offscreen harness does not draw Metal, so the orb area is empty in every render; its caption (SUPERVISOR / state / summary) renders and was judged.

Score 30/40 (1:3 2:3 3:3 4:3 5:4 6:3 7:3 8:3 9:3 10:2).

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | State is in three agreeing places (header mode, orb caption, pane line); the orb itself is unverified offscreen. |
| 2 | Match system / real world | 3 | "Tabs · Log · Settings" and the delegation levels read plainly; the settled-card summary is still server text ("Done — Only you can open a tab"). |
| 3 | User control and freedom | 3 | Close by ×, rail, ⌃⌥⌘S or pane line; an inner file open stays under the workspace with "Show". |
| 4 | Consistency and standards | 3 | Native segmented picker and pull-downs; the chip vocabulary is ADR-0114's. The Tabs row and the conversation's follow strip both name a follow (Stop following lives once). |
| 5 | Error prevention | 4 | No default action and no Return on any consent chip or on Start in shadow; consent chips never navigate; Settings is never the default segment. |
| 6 | Recognition rather than recall | 3 | The pane line, header and orb say the state in words; the header's "N for you" points at the pane rather than repeating it. |
| 7 | Flexibility and efficiency | 3 | ⌃⌥⌘S / ⌃⌥⌘P / ⌃⌥⌘K / ⌥⌘J; no keyboard path between inspector segments beyond Tab into the picker. |
| 8 | Aesthetic and minimalist design | 3 | Wide reading column, one orb, no new colour; the 760 pt cap leaves quiet margins at 1920. |
| 9 | Error recovery | 3 | Failed wake: one notice, Retry in the header, Open log under the notice; token and disconnected states say what still works. |
| 10 | Help and documentation | 2 | Help text on every control; the guide is the only place that explains the Tabs/Log/Settings split. |

Fixed before scoring: the 960 composite overflow (fixture); the delegation chip's lost body in the Tabs list (now a native pull-down); "· Shadow · 2 waiting" beside "2 for you" in the header (count dropped from the mode); the at-cap budget card drawn twice (fixture).

Priority issues → polish (done, re-captured):
- P2 Two Retry controls in the failed state (header + notice). → the notice keeps only Open log.
- P2 The Brain summary lost "woke 2m ago" behind a long follow title. → "woke" now precedes "following".
- P3 The pane line's open state was a reversed chevron ("back"), not a state. → selected fill and the `.isSelected` trait; the chevron stays.

Recorded, not changed:
- P3 Token unavailable with no status yet: the right column stays the tab's (mode unknown), while the centre shows the conversation read-only. Correct by rule (§13.2 covers only an enabled supervisor); noted in the guide.
- P3 "Done — Only you can open a tab" is the server's summary (brief §11, recorded).
- P3 The set-up form's cap field shows the locale currency format ("20,00 US$"), inherited from the sheet.
