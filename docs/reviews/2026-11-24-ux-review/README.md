# MARVIN UX review, 2026-11-24

Target: MARVIN's own macOS app (SwiftUI, `macos/`) and the data its sidecar feeds it. Reviewer lens: someone supervising up to 14 tabs on a Mac Studio, all day.
Lenses applied: ux-review (workflow), ux-laws-auditor, ux-behavior-design (funnel stage named per finding), apple-design (Mac norms). The ux-report skill was used for the shape of this write-up; no page was published (nothing here is meant for anyone but the owner yet, and the evidence is partly sensitive: live tab titles).

## Changes after the visual pass (2026-11-24 21:07 to 21:10, live app, dark theme)

The pass was done on the running app (2560x1440 display, 1x scale). I captured the Sessions pane, the tab strip, the status bar, two chat tabs (the first one and GATE-LANE-WIDTH, plus UX-REVIEW-PUBLIC) and the Files, Skills, Plugins, Practice and Supervisor panes. Clicks were limited to rail icons and tab titles; nothing was typed or confirmed. Captures are in `shots/`.

**Confirmed on screen:** W-03 (state line tiny, dim, cut in the middle), W-06 (no fleet summary, no badge on the Sessions rail icon), W-07 (tab strip, and worse than the source suggested), W-10 (metrics on every row), W-11 (chat is the narrow column, the middle is empty), T-01 (small text), T-02 (internal words), T-03 (the setting reads "full auto" in a tab, "full" in the API), M-03 (window subtitle shows the project branch, not the tab's).

**Corrected:**
- **W-01** was the main claim and the screen changes it. The Sessions pane did not print "Waiting on a job" for any row: the tabs the API calls `waiting` appear as ordinary Idle rows with no state word at all (new S-01). The job label is not lost, though: inside the tab a card reads "Waiting on a background job, 3/5 steps done, gated commit: lane width setting (step 1), Running for 46 min, the tab resumes when it finishes". So the label exists in the tab and is missing from the pane. Downgraded from Critical to High; the worse problem is S-01.
- **W-07**: tabs are about 65 points wide, not 190 (the strip shrinks them). Titles are unreadable: three tabs read only "#...", the others "# GA...", "# RE...". 8 of 11 tabs fit.
- **W-04**: the "grey clock" for waiting does not exist on screen: a waiting tab has the same grey dot as an idle one. Sorting by age cannot be judged because the pane has no Waiting section at the moment.
- **P-01**: posture is visible in the chat header of each tab ("sonnet-5-5 . advisor fable-5-2 . ultron . full auto"), so it is not invisible, only absent from the Sessions pane. Downgraded to Medium. Still not verified whether the toolbar follows the selected tab (the tabs I opened had identical posture).
- **Live count**: when I looked, 5 tabs were `waiting` in the API (P3, B53A, JAVA-HEADLESS, GATE-LANE-WIDTH, R1), not 7; UX-REVIEW-PUBLIC and PD PILOT-DEFECTS had finished.

**Dropped:** nothing outright.

**Not checked on screen:** W-02, W-05, W-08 (30 s collapse), N-01 to N-04, R-01, F-01 to F-03, M-01, M-02, T-04, T-05, W-09 (partly: skills "0/10" and cost are visible). No confirm, question or escalation was on screen.

**Added:** S-01 (Critical), S-02, S-03, S-04 (Medium), S-05, S-06, S-07 (Low), in section F below. The top 10 is re-ordered.

Whether anything moved unexpectedly: clicking the Supervisor rail icon replaced the chat column with the Supervisor workspace (expected, display only); clicking it again restored the previous view. I returned the selected tab to the first one. Nothing else changed.

## How this review was done, and how far to trust it

The app is the owner's live work environment, so the review was read-only.

| Evidence | What I got |
|---|---|
| Live screenshots of the running app | **Obtained in the visual pass** (21:07, `shots/`). Findings below say "seen on screen" where a capture confirms them. The first attempt had failed for lack of screen-recording permission. |
| Web UI at localhost:3030 | **Does not exist as a UI.** `GET /` is a 404 page (`web-root-404.png`). The sidecar serves the API only; the Mac app is the only interface. |
| Live data (`/api/sessions/watch`, 11 rows, 2026-11-24 18:43 UTC) | Obtained. This is what the UI has to work with. Every "API knows" statement below is from it. |
| Old captures | `~/Desktop/MARVIN-showcase/` is from **2026-09-03**, older than the Sessions pane redesign. I used one of them (`old-capture-2026-09-03-overview-chat.png`) only for overall layout. |
| Source | Read with the code graph first, then the files. Most findings are from here. |
| Logs | `~/Library/Logs/MARVIN/sidecar.log` and `exceptions.log`, read-only. |

The last column of each finding says which kind of evidence backs it. **"Source + live API"** means: I read the code that draws it and I saw the real data it would draw, but I did not see the pixels. **"Inferred from source"** means I could not confirm the runtime behaviour at all.

Counts after the visual pass: 35 findings. **Critical 2, High 10, Medium 16, Low 7.** (28 before the pass; W-01 moved from Critical to High, P-01 from High to Medium, 7 added.)

## Summary

MARVIN is good at telling you that a tab is *waiting*. It is bad at telling you *what for, for how long, behind what*, and it has nothing at window level that says how the whole fleet is doing. The data to fix most of this already exists: the watch API sends the job label and start time for every waiting tab, and the Sessions pane throws the label away and prints "Waiting on a job · 53m" at the end of a ten-fact, one-line, 9.5-point subtitle that is cut in the middle. Six identical "a job" rows with identical ages is exactly tonight's pain.

Second bottleneck: the moments that need you outside a confirm card (a tab finished, a tab failed, a second question arriving while one is open, a long wait) make no sound, get no badge, and finished tabs collapse out of sight after 30 seconds.

## What the live API said tonight (the evidence for the main complaint)

Seven tabs in state `waiting`, all `waitingOn.kind = "job"`, none with a pending confirm:

| Tab (shortened) | What the API says it waits on | Waiting since (UTC) | Its last turn ended |
|---|---|---|---|
| P3 SITE-CLAIMS | gated commit of P3 site claims (re-run after restart) | 17:50:01 (53 min) | 18:39:56 |
| PD PILOT-DEFECTS | gated commit retry: client_ref partial unique index | 17:49:30 | 18:14:02 |
| UX-REVIEW-PUBLIC | gated commit of the UX review docs on top of current s00 | 17:50:00 | 18:14:01 |
| JAVA-HEADLESS | gated commit of JAVA-HEADLESS | 18:00:53 | 18:13:34 |
| B53A security | gated commit: platform mutator baseline (after s00 merge) | 18:14:54 | 18:38:41 |
| GATE-LANE-WIDTH | gated commit: lane width setting (step 1) | 18:22:30 | 18:22:32 |
| R1 RELEASE-V31 | gated commit 2 (scripts) after the s00 merge | 18:41:46 | 18:41:50 |

`sidecar.log` shows the bundled sidecar started at 17:49:05; three of these waits begin 25 to 55 seconds later. So they are jobs re-armed after the restart, queued on one gate. The API has no field for queue position, what is running now, or what is ahead. The pane prints "Waiting on a job · 53m" for every one of them.

## Findings

Severity: Critical = misleads about system state or blocks the main task. High = significant difficulty on a frequent path. Medium = friction with a workaround. Low = polish.
Size: S under a day, M a few days, L needs sidecar and app work.

### A. Watching many sessions

**W-01 · High (was Critical) · The Sessions pane does not show what a tab waits on; the tab does**
- Where: Sessions pane subtitle, `macos/MARVIN/SessionsPane.swift:835-841`; label is decoded at `macos/MARVINLogic/SessionFeed.swift:340` and stored at `SessionLedger.swift:233`, but never read by any view.
- Experiences: "Waiting on a job · 53m". The API said "gated commit of P3 site claims (re-run after restart)". Seven tabs, one sentence.
- Breaks: Visibility of system status; Recognition over recall (he has to open each tab to learn what each waits on). Funnel stage: Evaluate (can he judge whether this wait is normal).
- Fix: Print `waitingOn.label` as the row's second line (allow two lines, wrap not truncate). Keep "a job" only as the fallback when there is no label. Add an icon per kind (job, wakeup).
- Seen on screen (shots/tab-ga.png, shots/sessions-idle.png): the pane shows no waiting text on any row (see S-01). Inside the GATE-LANE-WIDTH tab a card says "Waiting on a background job . 3/5 steps done . gated commit: lane width setting (step 1) . Running for 46 min . the tab resumes when it finishes". So the label is shown in the tab (good, keep it) and missing where he watches. Fix as above, reuse that card's wording on the row.
- Size: S. How I know: seen on screen + live API.

**W-02 · Critical · Nothing says a wait is a queue, or what is ahead**
- Where: whole waiting path. The watch row has only `waitingOn {kind, label, since}` (`sidecar/packages/runtime/src/session-watch.ts:113`, `:450`). No position, no "running now", no start versus enqueue time.
- Experiences: six tabs wait on "gated commit" for up to 53 minutes. He cannot tell whether one is running and five are queued, whether the gate is stuck, or whether his tab is next.
- Breaks: Visibility of system status; Doherty threshold (long waits need progress cues); Zeigarnik (waiting work needs a visible next step).
- Fix: Sidecar adds `waitingOn.queue { position, total, runningLabel, runningSince, enqueuedAt }` for any serialised resource (the commit gate, a CI run, a wakeup). App: group the Waiting section by resource: "Commit gate: 1 running (R1, since 18:41, 3m) · 6 queued", then rows in queue order with "#2 of 6, ~N min". If the gate is a separate process, a "stuck?" state when the running job exceeds its usual time.
- Size: L (sidecar field plus pane grouping). How I know: Source + live API.

**W-03 · High · The state line is the last of ten facts, 9.5pt, one line, cut in the middle**
- Where: `SessionsPane.swift:589-594` (`.lineLimit(1)`, `.truncationMode(.middle)`) and `:804-850` (the subtitle joins branch, commits, behind, claim, diff, plan, graph, skills, cost, supervisor note, then the state).
- Experiences: in a 260pt sidebar (`LeftPane.restoreWidth`, `LeftPane.swift:~455`) the line holds about 45 characters. Everything the owner cares about (waiting, needs you, how long) is at the end of a line that is shortened by removing its middle.
- Breaks: Miller's law, chunking, selective attention; Apple "Simplicity, not minimalism": the most important thing must be the most obvious.
- Fix: two fixed lines. Line 1: title. Line 2: the state sentence, in primary-secondary colour, never truncated ("Waiting 53m · gated commit of P3 site claims"). Move branch, commits, behind, diff, plan, graph, skills, cost to a third, collapsed line (or to the hover card, see W-10).
- Size: M. How I know: seen on screen (shots/sessions-idle.png): the second line of every row is about 9px, dim grey, and is cut in the middle ("isolated: marvin/tab/feat-records-machine-hours-on-... graph 20 . reads 182 (9.1x) . $18.26 . Done . 6h ago"). The state word, when present, is the last thing on it.

**W-04 · High · Waiting rows are in tab order, not wait order, and long waits look like short ones**
- Where: `SessionsPane.swift:88` (Waiting section), sort at `:134-136` is by `sortRank`, which is equal for every row in a section. The age text is plain muted 9.5pt. The tab-strip glyph for waiting is a grey 8pt clock (`ChatPreviewView.swift:3266-3270`, `tabTint(.waiting) = .secondary`).
- Experiences: a tab waiting 53 minutes looks the same as one waiting 3 seconds. Nothing is ever "stalled".
- Breaks: Von Restorff (the thing that matters must stand out); Peak-end; visibility of status.
- Fix: sort Waiting oldest first; tint the age amber after a threshold (say 15 min or 2x the median for that label), red-ish with a "stalled?" word after 45. Give the tab dot the same threshold so a stalled tab shows in the strip.
- Size: S. How I know: source + live API. On screen the pane had no Waiting section at all (S-01), and a waiting tab's strip marker is the same grey dot as an idle tab (no clock), so the sorting and colouring could not be judged.

**W-05 · High · "Waiting since" can be older than the tab's later activity, so the age may mislead**
- Where: API rows. P3: `waitingOn.since 17:50:01` but `lastTurn.endedAt 18:39:56`. B53A: since 18:14:54, last turn ended 18:38:41. Printed by `SessionsPane.swift:838` as one number.
- Experiences: "waiting 53m" when the tab ran a turn 4 minutes ago. Either the wait was re-armed (then the age is wrong) or the tab keeps working and the job is stuck (then he needs to know that). The pane cannot say which.
- Breaks: Visibility of system status; trust (two numbers that disagree).
- Fix: show both: "waiting 53m · last activity 4m ago". Sidecar: reset `since` when the job is re-armed, and add `enqueuedAt` versus `startedAt` (see W-02).
- Size: M. How I know: Live API; display inferred from source.

**W-06 · High · No fleet summary anywhere, and the Sessions rail icon has no badge**
- Where: `AppStatusBar.swift:1-140` (connection, branch, project, problems only); `LeftPane.swift:~401` (the rail badge exists only for the Supervisor entry); dock badge counts only needs-you (`ContentView.swift:161-162, 402`).
- Experiences: with the Files pane open, nothing says "3 working, 7 waiting, 1 needs you". He must open the Sessions pane, or count dots in a scrolling tab strip.
- Breaks: Visibility of system status; Pareto (his main job gets no permanent real estate); Fitts (a click away instead of in view).
- Fix: a status-bar chip "14 tabs · 3 working · 7 waiting · 1 needs you" (waiting turns amber when any wait is stalled); click opens Sessions. Same counts as a badge on the Sessions rail icon.
- Size: S to M. How I know: seen on screen (shots/statusbar.png, shots/pane-supervisor.png): the status bar holds only "online", branch, "2.165 up", project on the left and "activity", "ctx 392K", "graph 13 . reads 12", "$416.04" on the right, for the selected tab only. Nothing about the other tabs. The Sessions rail icon has no badge.

**W-07 · High · The tab strip does not scale to 14 tabs**
- Where: `ChatPreviewView.swift:3111-3200` (fixed 190pt tabs, `width: CGFloat = 190`), overflow menu `:3232-3262`.
- Experiences: at 1440pt wide roughly 6 to 9 tabs fit. The rest scroll off. The overflow menu lists titles and branch but **no state**, so the list that exists to find a tab shows no dots. Waiting and done differ only by an 8pt grey clock versus an 8pt grey tick. Three tabs started from the same brief get "1 · ", "2 · " prefixes.
- Breaks: Hick's law, recognition over recall, Fitts (tabs off-screen are infinite distance).
- Fix: tabs shrink to a minimum (like Safari) before scrolling; overflow menu rows carry the same dot, glyph and wait age; a state-colour edge or dot that is readable at 6pt. Consider a second row of "pinned by state" chips: all needs-you tabs first.
- Size: M. How I know: seen on screen (shots/tabstrip.png, shots/tabstrip3.png). Correction: tabs are about 65pt wide, not 190. With 11 tabs, 8 are visible and every title is cut to 2 to 5 characters: three tabs read only "#...", the rest "# GA...", "# RE...", "# UX...", "# B5...", "# P3...". The titles carry no information; tabs can only be told apart by opening them. Markers: dot (working, idle and waiting look the same) or tick (done). No clock seen. The "11" with a chevron is the overflow list.

**W-08 · High · A finished tab disappears, and "finished" is not a state that waits for you**
- Where: `macos/MARVINLogic/SessionRowState.swift:57-100` (done rows collapse with idle rows after 30 s; only the first 3 stay); `.done` is a grey checkmark (`ChatPreviewView.swift:3267-3273`); no notification (`NotificationManager.swift`, confirm-only).
- Experiences: the scope-met handoff, the moment he needs to review and merge, is the quietest event in the app. 30 seconds later it may be hidden under "N idle".
- Breaks: Peak-end rule; Zeigarnik; visibility.
- Fix: a "Finished, not yet reviewed" state: shown in the Needs you group (calm tone) until he opens the tab or presses "Reviewed". Only after that does it collapse. Notification "Tab X finished: review".
- Size: M. How I know: Source.

**W-09 · Medium · Data the API already sends and the UI never shows**

| API field | On screen today |
|---|---|
| `waitingOn.label` | not shown (W-01) |
| `lastTurn.outcome/endedAt` for waiting tabs | not shown (W-05) |
| `posture` (model, advisor, personality, permission, effort) | not in the Sessions pane or tab (P-01) |
| `worktree.dirty` | not shown for a live tab (only in the integrate section) |
| `worktree.target` (the branch it will merge into) | only the section footer |
| `diff.files`, `diff.untracked` | only `+added −removed` |
| `skills.missing` names, `skills.first` | counts "0/6" inline, names in a tooltip |
| `plan` open-step text (API sends counts only; the plan file has the text) | "4/5 steps · updated 12m ago" |
| `cost.turns` | only dollars |
| `supervisor.openEscalations` | shown only when the supervisor is enabled |
| `updatedAt` | not shown on waiting rows |
- Fix: a hover card or an expandable row that shows these, not more inline text. Plan: show the name of the one open step on a waiting row ("last step: gated commit").
- Size: M. How I know: Live API versus source.

**W-10 · Medium · Metrics compete with status on every row**
- Where: `SessionsPane.swift:824-826` (`graph 4 · reads 14 (3.5×)`, `skills 0/6`, `$3.20` printed on every row).
- Experiences: "skills 0/6" on six of seven rows reads as six failures, at the same weight as "Waiting". The graph ratio is a measure for the owner of MARVIN, not a status of the tab.
- Breaks: Cognitive load (extraneous); selective attention.
- Fix: show a metric inline only when it is an exception (skills missing at a close, ratio above threshold). Otherwise hover card.
- Size: S. How I know: seen on screen: "graph 20 . reads 182 (9.1x) . $18.26" and "skills 0/10" print on every row in the same grey as everything else (shots/sessions-idle.png).

**W-11 · Medium · The overview lives in a 260pt side pane, while the chat is the narrow column**
- Where: old capture `old-capture-2026-09-03-overview-chat.png` (editor dominates, chat about a third of the width on the right); `LeftPane.restoreWidth = 260`.
- Experiences: for a supervisor the layout is inverted: the thing he watches is the smallest, most-hidden surface.
- Fix: a "Mission control" mode: the Sessions list at full width with the wait groups of W-02, or a detachable window (see M-01).
- Size: L. How I know: seen on screen (shots/full1.png, shots/pane-supervisor.png). The window is 2560 wide: Sessions pane about 330pt, the middle about 1000pt shows only "No file open", and the chat, where the work happens, is about 770pt in the right column.

### B. Moments that need you

**N-01 · High · Notifications cover one case: confirm count going from 0 to more than 0**
- Where: `NotificationManager.swift` (`updateConfirmCount`, `guard lastConfirmCount == 0, count > 0`), called from `ContentView.swift:161-163`; one fixed request id; body "N confirms pending".
- Experiences: while one confirm is open, a second from another tab is silent. A failed tab, an interrupted tab, a finished tab, a question, a stalled wait: no notification at all. The notification does not name the tab and does not jump to it when clicked.
- Breaks: Visibility; Jakob's law (macOS notifications carry a subject, a body and an action).
- Fix: one notification per event kind (needs-you, failed, interrupted, finished, stalled), title = tab title, body = the ask, click focuses that tab. Collapse bursts, keep an off switch per kind. Same events drive the dock badge.
- Size: M. How I know: Source.

**N-02 · Medium · The confirm sheet does not say which tab asked, and Return means Allow**
- Where: `ConfirmSheet.swift:80-90` (header: "MARVIN wants to use a tool" plus the tool name; no tab, no branch), `:186-191` (`.keyboardShortcut(.defaultAction)` on Allow, `.cancelAction` on Deny).
- Experiences: with 14 tabs, a modal naming only "Bash" gives no hint which worktree it will run in. Pressing Return approves. Mac convention: a risky action is not the default button.
- Breaks: Mental model; error prevention; Apple "Agency".
- Fix: header adds tab title and branch; make Allow the default only for low-risk tools, never for anything the gate marked boundary or push. Severity is Medium because every tab on this machine runs in `full` posture and rarely reaches this sheet (live API: all seven rows `permissionStrategy: full`).
- Size: S. How I know: Source only (I could not trigger a confirm).

**N-03 · Medium · Inline Allow/Deny rows are 9.5pt with the reason in tertiary 9pt**
- Where: `SessionsPane.swift:700-745`.
- Experiences: the decision is made from a 9.5pt monospaced excerpt (4 lines max) with the reason in the faintest text colour. Hit targets are small chips next to each other.
- Fix: raise to 11pt, reason in secondary, tab name above, a 2-second hold or undo for Allow on boundary actions. The existing "tell the tab no and carry on" tooltip is good; keep it.
- Size: S. How I know: Source only.

**N-04 · Low · "Dismiss" on an attention note has no undo**
- Where: `SessionsPane.swift:~686-697`. Fix: a 5-second "Undone" toast. Size: S. Source only.

### C. Long waits, restarts, errors

**R-01 · High · A restart leaves no visible trace on the tabs it re-queued**
- Where: sidecar label text "re-run after restart" (live API); no field or banner for it; the pane shows `interrupted` only for turns cut off mid-run (`SessionRowState.swift:45-52`).
- Experiences: after a restart he sees tabs "waiting" that are really jobs re-run from scratch; the lost time (17:49 restart, 53 minutes later still waiting) is not attributed.
- Breaks: Visibility; Peak-end (a bad restart is the last thing remembered).
- Fix: a one-time banner after launch: "Sidecar restarted at 17:49. 4 jobs were re-queued: [list, in order]." Mark those rows "re-queued after restart".
- Size: M. How I know: Live API + sidecar.log; the missing banner is from source.

**F-01 · High · The first launch after a quit sometimes shows no window. Cause not proven**
- Where: `MARVINApp.swift:531-560` (a single SwiftUI `Window("MARVIN", id: "marvin-main")`), `MARVINApp.swift:333-380` (`applicationDidFinishLaunching`), `:405-431` (`applicationShouldHandleReopen` returns true but opens nothing itself), `ContentView.swift:99` (`setFrameAutosaveName("MARVINMainWindow")` set after the window exists), `SidecarManager.swift:80-100, 220-245` (`reclaimPort()` runs synchronously on the main thread at launch: one `lsof` plus up to 1.5 s).
- Evidence for a window-state problem: `defaults` holds **two competing saved frames**: `NSWindow Frame MARVINMainWindow = "0 91 2560 1319"` and `NSWindow Frame marvin-main = "800 436 960 628"` (SwiftUI saves its own name per scene id, and the explicit call adds a second one). `exceptions.log` holds 20 "constraint storm" and 11 "layout-pass breaker tripped" reports, many with `NSGlassContentFrameView`, the window's own host, in the first seconds of a launch.
- Three candidate causes, in order of how well the evidence fits: (1) the SwiftUI scene restored a closed-window state or the second frame off-screen; (2) the layout breaker fired in the window host and the window was never ordered front; (3) the synchronous port reclaim delays the first draw. I cannot tell which from outside. Do not treat any as the diagnosis.
- Breaks: the primary task (getting in), with only a workaround (status-item "Show MARVIN", Dock click).
- Fix, in this order: (a) a safety net: 2 seconds after launch, if `NSApp.windows` has no visible main window, call `openWindow(id: "marvin-main")` and `makeKeyAndOrderFront`; (b) log window count, frame and `isVisible` at launch+0.5, +2 s to `exceptions.log` so the next occurrence names its cause; (c) drop one of the two autosave names; (d) move `reclaimPort()` off the main thread. Do not ship the guess without (b).
- Size: S for (a)(b)(c), M for (d). How I know: Source + `defaults` + logs. Not reproduced.

**F-02 · Medium · The "Sidecar not reachable" screen tells the installed app's user to run a repo command**
- Where: `ContentView.swift:705-740` ("Start the sidecar: `bin/marvin start`, run from the MARVIN repo root"). Offers Open Terminal, Start Sidecar, Reconnect.
- Experiences: the installed app bundles its sidecar. When that dies, the screen explains a developer workflow and does not show why: no log tail, no "Reveal sidecar.log", no "Restart sidecar".
- Fix: if a bundled payload exists, show the last 10 lines of `sidecar.log`, buttons "Restart sidecar" and "Show log in Finder". Keep the repo text for dev builds only.
- Size: S. How I know: Source only.

**F-03 · Medium · Connecting has no progress, no timeout and no word about restoring tabs**
- Where: `ContentView.swift:694-702` (spinner plus "Connecting to MARVIN sidecar…").
- Experiences: on the first launch after a quit the owner sits on a spinner that never changes its message; he cannot tell 2 seconds from 2 minutes.
- Fix: after 5 s add "Starting the sidecar… (14 tabs to restore)", after 20 s offer the log and a restart. Size: S. Source only.

### D. Settings, setup and per-tab posture

**P-01 · Medium (was High) · A tab's posture is invisible where he watches, though the API sends it**
- Where: live API `posture {model, advisorModel, personality, permissionStrategy, thinkingMode, mode}` per row; Sessions rows show none of it. The controls under the input (`ChatModeToolbar.swift:15-24`) read `bridge.mode` and `bridge.thinkingMode` (app-level names). From source I cannot confirm they follow the selected tab, as ADR-0108 says they should.
- Experiences: his policy is one posture for every tab (Sonnet high, advisor Fable). A tab that drifted (Fable executor, max effort, gated) is invisible until he opens it, and costs money meanwhile.
- Breaks: Visibility of status; Recognition over recall.
- Fix: a posture chip on a Sessions row or tab **only when it differs from the project default** ("fable · max · gated"). Also: check on screen that the toolbar follows the selected tab, because if it does not, changing it in one tab changes the next.
- Seen on screen: the chat header of each tab shows "sonnet-5-5 . advisor fable-5-2 . ultron . (red dot) full auto", and the input bar shows "high" and "advisor follow". So posture is visible once a tab is open; it is absent from the pane and strip. The tabs I opened had identical posture, so whether the toolbar follows the selected tab is still unverified. Downgraded to Medium. Size: M.

### E. Text, accessibility, Mac conventions

**T-01 · Medium · Much of the status text is 9 to 10.5pt**
- Where: 16 uses of 9 or 9.5pt in `SessionsPane.swift`; tab close glyph 8pt (`ChatPreviewView.swift:3178`); status bar 11pt monospaced.
- Contrast is fine where measured: `MarvinTheme.textMuted` on the sidebar background is 6.55:1 dark, 4.60:1 light (my calculation from the theme hex values). The faintest style (`.tertiary`, used for reasons and tooltips) I could not measure.
- Fix: 11pt minimum for anything a decision rests on; 10pt only for chrome. Size: S. Seen on screen (shots/sessions-idle.png, statusbar.png): row subtitles ~9px grey on near-black, status bar ~11px. Legible on this display but dim; the History "kept: marvin/tab/..." lines are the weakest.

**T-02 · Medium · Internal vocabulary in user-facing rows**
- Where: `SessionsPane.swift:~810-850`: "isolated: marvin/tab/…" while the tab chip says "own branch" (`SessionModeChip.swift`, "one vocabulary"); "graph 4 · reads 14 (3.5×)"; "supervisor waits — tab waiting on its build"; "Waiting on a wakeup"; "behind by 8" (behind what?).
- Seen on screen: rows say "isolated: marvin/tab/..." while the tab chip says "own branch" (sessions-idle.png vs tabstrip3.png). Fix: one word per concept: "own branch" everywhere; "behind main by 8"; "waiting for a scheduled check" for wakeup; hide graph ratio (W-10). Size: S. Source only.

**T-03 · Medium · The same setting has three names**
- "auto" (header chip in the old capture, AGENTS.md "auto-mode"), "full" (the API `permissionStrategy`), "gated". A reader of the API or a log sees `full`, a reader of the app sees `auto`. Fix: pick one (`full` or `auto`) and use it in UI, tooltips and logs. Size: S. Seen on screen: the tab header says "full auto", the API says `full`, the Supervisor says "Autonomous".

**T-04 · Low · Key facts live only in tooltips**
- `SessionsPane.swift:help(...)`: path, graph counts, missing skills, plan seeded. Hover is slow and not reachable by keyboard. Fix: the expandable row of W-09. Size: S. Source only.

**T-05 · Low · Some hit targets are 20pt**
- Tab close 20x20, step arrows 20x22, refresh 20x20 (`ChatPreviewView.swift:3178, 3205`; `SessionsPane.swift:~430`). Acceptable for a pointer UI, but they sit next to each other in dense rows. Rail buttons are 44x34 (good). Fix: 24pt minimum. Size: S. Source only.

**M-01 · Medium · One window only, on a Mac Studio**
- Where: `MARVINApp.swift:531` (main `Window`), but the app already opens other windows (`marvin-review`, `:768`).
- Experiences: he cannot park the Sessions overview on a second display while chatting in the main window.
- Fix: a "Sessions" `Window` scene (`id: "marvin-sessions"`, ⌘⌥S), same view as the pane. Size: M (the pane is a pure observer of `SessionRegistry`, so reuse is cheap). Source only.

**M-02 · Medium · No "go to the next tab that needs me" command**
- Where: `ChatPreviewView.swift:3195-3215` (⇧⌘[ and ⇧⌘] walk tabs in strip order). The pane's ↑ ↓ ⏎ works only with the pane focused.
- Fix: a "Next tab needing me" command (suggest ⌘⌥↓) in the Go menu, ordered Needs you, then Finished-not-reviewed, then Stalled. Size: S. Source only.

**M-03 · Low · Window title and subtitle describe the project, not the selected tab**
- Where: `ContentView.swift:~728` (`composeSubtitle()` uses `bridge.projectName` and `bridge.branch`). With every tab on its own branch, the title bar says the project and a branch that is probably not the tab's.
- Fix: subtitle shows tab title and its branch. Size: S. Inferred from source; Seen on screen (shots/tab-ga.png and the title bar): the title bar subtitle says "feature/s00-production-capability-truth" while the selected tab is "own branch . gate lane width more than one full suite". Confirmed.

### F. Seen only on screen (added by the visual pass)

**S-01 · Critical · Waiting tabs look idle: the pane and the tab strip show no waiting state at all**
- Where: Sessions pane (shots/sessions-idle.png) and tab strip (shots/tabstrip3.png), compared with the live API at the same minute (5 rows `waiting`, each with `waitingOn.label`).
- Experiences: the pane has only "Idle 11" and "History 4". The GATE-LANE-WIDTH row (API: waiting since 18:22, about 46 min) sits among Idle rows with a bare dot and "52m ago . graph 7 . reads 14 . $3.07 . 18m ago", no state word; other waiting tabs are folded under "5 more idle sessions". The tab strip gives it the same grey dot as an idle tab. Only inside the tab (shots/tab-ga.png) does a card say it is waiting on a job for 46 minutes; the orb above the chat says "idle" too. So at the place he watches, the five tabs blocked on the commit gate look the same as finished ones. Cause not proven (the app may derive the row from its own registry, not from the watch feed). W-01 to W-05 assumed the pane would print "Waiting".
- Breaks: Visibility of system status; it is the misleading-state case.
- Fix: find why the pane's derived state is idle while the feed says waiting (compare `SessionRowState.derive` inputs with the feed row), then show Waiting as its own group above Idle, never folded into "N more idle".
- Size: S to M for the diagnosis. How I know: seen on screen + live API. Cause not established.

**S-02 · Medium · An animated orb takes the top 200pt of the chat column**
- Where: right column above the tab strip, "STATE idle" under it (shots/tabstrip.png, tab-ga.png). Fix: shrink to a status dot in the header, or let it collapse; the space belongs to the chat. Size: S. Seen on screen.

**S-03 · Medium · The Supervisor says "Autonomous" while it watches none of the tabs**
- Where: Supervisor workspace (shots/pane-supervisor.png): header "Autonomous . 3 of 4"; text "autonomous: questions, nudges, posture . watching 21 . woke 22d ago"; the Tabs list "NOT WATCHED 11" with every tab "Off"; "Standing merge: off". Reads as contradictory; "3 of 4" is unexplained. Fix: one sentence at the top ("Supervising 0 of 11 tabs. Last acted 22 days ago.") and a plain label for what Autonomous covers. Size: S. Seen on screen; I did not hover or open Settings.

**S-04 · Medium · The rail icons and the ring on each session row have no labels**
- Where: left rail (Files, Search, Source control, Sessions, Skills, Plugins, Practice, Supervisor; identified by clicking) and the ring at the right of every Sessions row (shots/sessions-idle.png). I could not tell what the ring does without acting on it and did not hover it. There is no Plan or Backlog rail icon: backlog ("325 backlog items parked . Open") and plan ("Plan complete 5 of 5 steps") appear only as cards in a chat. Fix: labels or fast tooltips, a label on the ring. Size: S. Seen on screen.

**S-05 · Low · A chip is cut mid-word with no ellipsis**
- "own branch . docs ux public pages ux review 83 findin" (shots/tab-ux.png): the slug is cut at about 50 characters, also in History ("...two-medium-audit-findin"). Fix: shorten with an ellipsis, keep the tail. Size: S.

**S-06 · Low · Unexplained numbers in the status bar**
- "2.165 up" next to the branch (shots/statusbar.png) has no unit I could see; "graph 13 . reads 12" and "ctx 392K" are MARVIN-owner metrics at the same weight as the connection state. Fix: say what 2.165 is; move the graph ratio out of the always-visible bar. Size: S. Seen on screen.

**S-07 · Low · Practice cards carry four buttons each, in small grey text**
- Practice pane (shots/pane-practice.png): 8 findings, each with "Approve", "Draft message", "Fixed in MARVIN", "Dismiss", a score "0.89 / 1.00" with no legend, and two red "regressed" cards. The hierarchy (status pill, rule name, one sentence) is good. Fix: one accent button, the rest in a menu, explain the score on hover. Size: S. I clicked no button.

Other panes seen (no new finding): **Files** (clean tree, green and orange dots on changed folders; a blue focus ring stays on the rail icon after a mouse click); **Skills** ("Active in this project 36", toggles, 2-line descriptions cut with an ellipsis, many blue "Update" buttons, then LOCAL skills); **Plugins** (21 plugins, the orange "hooks never load" warning repeated on many rows turns a normal fact into noise). Search and Source control were not opened.

## Strengths worth keeping

- **A glyph for every state, never colour alone** (spinner, hand, arrow, cross, clock, tick): `SessionsPane.swift:~640-660`, `ChatPreviewView.swift:3126-3170` (Accessibility, Similarity).
- **Needs you sorts first and is answerable from the Sessions pane** (Allow / Deny without switching tabs), with the one-line tooltip saying what each does (Fitts, Minimize target distance).
- **The row state is derived in one place** (`SessionRowState.derive`) so tab strip, dock badge and pane cannot disagree (Visibility, one source of truth).
- **Integration is honest about cost and safety**: "Merge all ... stops at the first conflict. Never pushes"; "Prepare MR spends CI minutes" is neutral not primary (Agency, Responsibility).
- **Bulk "Keep all" in the backlog goes through a confirm** so it is not a rubber stamp (`BacklogPanel.swift:471-514`).
- **VoiceOver layer exists**: announcements, accessibility actions on rows, an Escalations rotor (`MarvinAccessibility.swift`, `SessionsPane.swift:117-123`). Not tested by me.
- **Plan staleness flag** "⚠︎ 3/8 steps · updated 12m ago" (`SessionsPane.swift:~855`) is the right idea; W-04 asks for the same treatment for waits.
- **Status bar degrades gracefully** (`ViewThatFits`, three detail levels).
- **Seen on screen:** the in-tab "Waiting on a background job" card (what, step count, run time, "the tab resumes when it finishes") is the right wording; reuse it in the pane. The chat (tool cards, red error card with the reason, green plan card, "Scope met" bar with three actions) has a clear hierarchy. Dark theme is consistent, window chrome and menu bar are standard.

## Top 10 to do first (value to someone watching 14 tabs), re-ordered after the visual pass

1. **S-01** Find why waiting tabs show as idle in the pane and strip; give Waiting its own, unfolded group. S to M.
2. **W-01** Print the job label and wait time on the row (reuse the in-tab card wording). S.
3. **W-07** Make the tab strip readable: titles that identify a tab, a state marker per tab, state in the overflow list. M.
4. **W-06** Fleet summary in the status bar and a badge on the Sessions rail icon. S to M.
5. **W-03** Two-line rows with the state sentence first, details behind a hover card. M.
6. **W-04** Oldest wait first, amber then red for long waits, also on the tab marker. S.
7. **N-01** Notifications for finished, failed, interrupted and stalled tabs, naming the tab. M.
8. **W-08** A "finished, not yet reviewed" state that does not collapse away. M.
9. **W-02** Queue position and "what is ahead" from the sidecar. L.
10. **W-11** Give the chat the empty middle area, or a mission-control layout. L.

(F-01 launch safety net, R-01 restart banner, S-03 and P-01 follow right behind; not re-tested on screen.)

Next if time allows: W-05 (since versus last activity), W-07 (tab strip at 14 tabs), M-02 (next-needing-me shortcut), M-01 (Sessions window).

## What I could not review, and why

- **Visual pass status:** done 2026-11-24 for the panes listed at the top; findings still labelled "source only" were not re-checked. The rest of this bullet is the original text, kept for those. Every visual claim (spacing, wrapping, how a truncated line looks) is from source or from the 2026-09-03 captures. Please grant Screen Recording to the terminal running this and I can redo the visual pass, or run the app's own surface renderer (`MARVIN_SNAPSHOT_VIEW=all MARVIN_PORT=39031 ...`, it does not touch the real sidecar) once you are happy for a second MARVIN process to start.
- **The web UI.** There is none at localhost:3030 (404 at `/`).
- **A real confirm card, a question, an escalation, a scope-met handoff, a backlog keep/dismiss, a practice item.** I may not trigger or click these. They are judged from source.
- **The Supervisor workspace, Practice and Plugins panes, Settings, the setup popover, onboarding.** Read only at headline level; no live or recent capture. The Supervisor row chips appear in my notes only where the Sessions pane embeds them.
- **First-launch behaviour (F-01).** Not reproducible without quitting the app, which I must not do.
- **VoiceOver, keyboard-only use, Dynamic-type-like scaling, increased contrast.** Not run. Source suggests VoiceOver support exists.
- **Whether the toolbar posture controls follow the selected tab** (P-01) and **which branch the window subtitle shows for a worktree tab** (M-03).
- **Sizes at your real window width.** The 260pt sidebar and 190pt tab figures are code constants; how many tabs fit is my arithmetic.

## Evidence files in this folder

- `web-root-404.png`: headless Chromium at http://localhost:3030 at 1440x900 (the sidecar has no web UI).
- `old-capture-2026-09-03-overview-chat.png`: copy of `~/Desktop/MARVIN-showcase/full/overview-chat.png`, **older build**, used for layout only.
