# MARVIN UX review, round 2 (2026-11-24, 22:34 to 22:45 local)

Target: MARVIN 1.1.2+8173fe0 running on the owner's main display (2560x1440, 1x, dark theme), eleven open tabs, seven of them paid and busy. Reviewer lens: someone watching up to 14 tabs all day.
Lenses applied: ux-review (workflow), ux-laws-auditor, ux-behavior-design, apple-design (Mac norms), emil-design-eng (polish). I ran the lenses myself, one after the other, over the same captures (no sub-agents, no browser).
Captures are in `shots2/` (cropped to the window, 2560x1319, local only; none shows a password, key or token).

## How this was done, and what I touched

- Read only. Clicks: left-rail icons (Search, Source control, Sessions, Skills, Plugins, Practice, Supervisor, Files), the overflow chevron (then Escape), and three tab titles: **GATE-LANE-WIDTH**, **REGES-GITHUB-READ** and then back to **B54 SECURITY-READ-2**, the tab that was selected when I started. No button inside a card or row was clicked, nothing was typed, no menu was opened (menus were read from source).
- Leaving a tab marks it reviewed (`SessionRegistry.noteSelection`). The tabs I left were B54, GATE-LANE-WIDTH and REGES-GITHUB-READ; none of them was in the "Finished" group, so no unreviewed tab was marked.
- One click did nothing: the first click on the Search rail icon (a tooltip showed, the pane stayed on Sessions). A second click opened Search. Nothing else surprised me.
- I ended on the Files pane (what was open at the start) with B54 selected.
- The live feed was read with GET only, several times, to compare with the screen. The fleet changes every minute (tabs wake, take the gate, finish), so every comparison below is between a capture and a feed read taken in the same minute, and I say which.

## Part A: the build's claimed fixes, checked on screen

| # | Claim | Verdict | What I saw (capture) | Defects |
|---|---|---|---|---|
| 1 | Waiting group: what they wait on, for how long, oldest first, amber when long | **Partly** | `b-pane-top.png`, `c2-pane.png`, `k-pane.png`: a "Waiting 3" group above Idle; each row has a second line in brighter text, e.g. "gated commit rerun after restart: baseline · 12 min". Order was oldest first (12, 3, 3 min). Amber could not be checked: the longest wait on screen was 12 min and amber starts at 15. | Only 3 of the 6 sessions the feed calls waiting are shown (R2-01). The wait clock restarts each time a tab re-arms, so serial waits behind one gate read as short (R2-04). The facts line under the wait still holds two different ages ("updated 59m ago ... last turn 11m ago"). |
| 2 | Fleet summary in the status bar | **Present, partly right** | `status-left.png`, `k-status.png`: "11 tabs · 3 waiting · 3 finished", grey, 11 pt, next to the project name. It equals the pane (3 waiting, 3 finished, 5 idle = 11). | Equals the pane, not the feed: at 20:40 UTC the feed said 6 waiting, 5 done, 1 idle (R2-01). Never changes colour for a long wait (R2-03). The click tooltip ("click to open Sessions", `AppStatusBar.swift:167`) did not show in 2.5 s of hovering; not proven either way. |
| 3 | Badge on the Sessions rail icon | **Missing on screen, by design in source** | `rail-b.png`, `g-sessions-icon-crop.png`: no badge. Source: the badge counts only "needs you" (`LeftPane.swift:409-411`), and nothing needed me. The tooltip "Sessions" appears at once. | With 3 finished-not-reviewed and 3 waiting, the rail is silent (R2-03). |
| 4 | "Finished (N)" group with a "Reviewed" chip | **Present** | `b-pane-top.png`: "FINISHED 3", blue dot, "Reviewed" chip per row, state "Done · 6m ago". I did not click a chip. | The state sits last on a 9.5 pt line that is still cut in the middle (README W-03). Blue dot is 6 px. |
| 5 | Readable tab titles | **Partly** | `tabstrip-a.png`, `tabstrip-b.png`: "B89 FARM… ✓", "B59 OFFLI… ✓", "B54 SECU… ✓", "GATE-LANE…", "REGES-GITH…", "UX-REVIE…". They identify a tab now (round 1: "# GA…"). | Still cut at about nine characters, and the Sessions pane names the same tabs by file path ("briefs/v31/b53a-security-hardening-lef…"), so the two surfaces disagree (R2-02). |
| 6 | Wider tabs | **Present** | Tabs are about 140 pt wide (round 1: about 65). Six of eleven are visible. | The strip scrolls the selected tab to a new place after a click (R2-18). |
| 7 | Pinned "needs you" chips | **Not verifiable** | Nothing needed me, so no chip appeared. | n/a |
| 8 | Overflow list with states | **Present, good** | `c-overflow.png`: eleven rows, a glyph plus words: "done", "done (open)", "waiting 8 min", "idle", "finished, not reviewed", "waiting 7 min". | Rows are in strip order, not by need. The row for the "b53a" tab prints "B53a B53a: v3.1 batch from the backlog…" (word doubled). Rows differ from the pane's names (R2-02). Escape dismissed it cleanly. |
| 9 | Go ▸ Next Tab That Needs Me (⌥⌘]) | **Not exercised; present in source** | `CommandRegistry.swift:129-138`: Go menu, ⌥⌘], disabled when no tab needs you, order needs-you, failed, finished-unreviewed, longest wait. I was told not to press it. | It sits in a Go menu that is otherwise code navigation (R2-17). |
| 10 | Restart banner | **Not visible; partly covered in source** | No tab was cut off, so no banner. Source: only interrupted turns, only inside the Sessions pane (`SessionRestartTrace.swift` header says re-armed jobs are not covered). | The live feed has "gated commit rerun after restart: baseline" for b53a, and nothing marks it (R2-10). |
| 11 | Named notifications | **Not triggered; source reads right** | `TabNotifications.swift`, `TabNotificationController.swift`: one per kind, title = tab name, burst collapsed over 2 s, click selects the tab, nothing for the tab in front. | No event for a long wait ("there is no stalled event", file header). Titles use the pane's naming, i.e. file paths (R2-02). |
| 12 | Confirm card names its tab | **Not seen; source reads right** | `ConfirmSheetText.askedBy` gives `Tab "title" · branch`; `ConfirmSheet.swift` now binds only Cancel, not Allow, to a key. | None found in source. Not on screen: no confirm was open. |
| 13 | New start-up screens | **Not seen** | Needs a launch or a dead sidecar. `StartupScreenText.swift`: quiet for 5 s, then "Still starting (8 s). Your 11 tabs are restored as soon as it answers.", then the log after 20 s. | None found in source. |
| 14 | Window ▸ Show MARVIN | **Present in source; menu not opened** | `MARVINApp.swift:741-745`. | No shortcut; sits among Check for Updates and Keyboard Shortcuts (R2-17). |

Counts versus the feed, in the same minute (`k-feed-vs-pane-2040.png`, feed read 20:40:40 UTC):

| | Feed | Pane | Status bar |
|---|---|---|---|
| waiting | 6 (GATE-SELECT-LIVE, R1, GATE-LANE-WIDTH, STRIPE-T6-DEV, JAVA-TESTS-PARALLEL, b53a) | 3 (b53a, GATE-LANE-WIDTH, R1) | 3 |
| finished or done | 5 done (two of them from yesterday), 1 idle | 3 finished, 5 idle | 3 finished |
| working | 0 | 0 | 0 |
| total | 12 rows | 11 | 11 |

The three missing waiting sessions are not open as tabs (the overflow list has eleven tabs, none of them these three). Earlier the same sessions DID appear in the pane, as "Working": STRIPE-T6-DEV at 20:35:28, GATE-SELECT-LIVE at 20:37:01. They disappeared at the moment the feed turned them to `waiting`. That is R2-01.

## New findings

Severity: Critical = misleads about system state or blocks the main task. High = significant difficulty on a frequent path. Medium = friction with a workaround. Low = polish. Size: S under a day, M a few days, L needs sidecar and app work.

### Fleet truth

**R2-01 · Critical · A session that waits and has no open tab disappears from the pane, the status bar and the badge**
- Where: `macos/MARVIN/SessionRegistry.swift:124-130` (`fleetSessionIds` is the open tabs plus ledger entries where `isLive`); `SessionLedger.swift:60` (`isLive` is "a turn is running"). The pane (`SessionsPane.swift:168`), the status bar and the notification controller all read it.
- Experiences: a tab started by the spawner or another client shows in the pane while it works, then vanishes when it starts waiting on the commit gate, which is exactly the state he supervises. Tonight three of six waiting sessions were invisible for at least 6 minutes (table above). Counts in the status bar are therefore wrong low, and no notification can ever come from them.
- Breaks: Visibility of system status; it is the misleading-state case. Funnel stage: Cue (nothing prompts him to look).
- Fix: put every non-closed session the feed knows into the fleet, whatever its liveness: `isLive || state in {waiting, needsYou, finished-unreviewed}`. Give those rows a small "not open as a tab" note and an Open button (the open act is the only click needed).
- Size: S. Evidence: `k-feed-vs-pane-2040.png`, `b-sessions-pane.png` (STRIPE as Working), `c2-pane.png` (gone). Source read to confirm the mechanism; not yet run with a fix.

### Names and signals

**R2-02 · High · The same tab has different names on different surfaces, and the pane's are file paths**
- Where: pane title `SessionsPane.swift:848-852` (raw `e.title`, cut at 38 characters); strip title `SessionTabStrip.swift` (`SessionTabTitle.display`); notification title `TabNotifications.swift` (`TabNotificationTitle.make`, same raw title as the pane).
- Experiences: strip "B53A", pane "briefs/v31/b53a-security-hardening-lef…", overflow "B53a B53a: v3.1 batch from the backlog…". The words he uses for a tab ("the B53 tab") are not on the row he looks at. Two rows in the pane start with `briefs/v31/`, so the first 12 characters tell nothing. A notification would say the path.
- Breaks: Recognition over recall; Jakob (one name per thing); Mental model.
- Fix: one `SessionTabTitle.display` for pane, strip, overflow, notification and confirm sheet; keep the long form for the tooltip. Fix the doubled word in the overflow.
- Size: S. Evidence: `b-pane-bottom.png`, `tabstrip-b.png`, `c-overflow.png`.

**R2-03 · High · The two always-visible signals never change colour for a long wait, and the rail badge ignores finished results**
- Where: `AppStatusBar.swift:151-170` (orange only for `needsYou`; grey otherwise), `LeftPane.swift:409-411` (badge = `needsYou` only), `SessionFleet.swift` (`longAfter` exists for rows, not for the counts).
- Experiences: row amber exists (not seen, nothing waited 15 minutes tonight), but with the Files pane open, a tab that has waited 50 minutes and three results nobody has looked at show as grey text and no badge. Round 1 asked for exactly this (W-04, W-06); the build gave the counts and left them quiet.
- Breaks: Von Restorff (the thing that matters must stand out); Zeigarnik (a finished-unreviewed result is an open task).
- Fix: `FleetCounts` gains `longWaiting`; status chip turns amber when `longWaiting > 0` and reads "2 waiting (1 long)"; rail badge shows needs-you + finished-unreviewed (blue when only finished, orange when needs-you or long). Same data feeds the dock badge.
- Size: S to M. Evidence: `rail-b.png`, `status-left.png`; source for the colours.

**R2-04 · High · The wait clock restarts when a tab re-arms, so a tab stuck behind the gate for half an hour reads "3 min"**
- Where: feed `waitingOn.since`, printed by `SessionsPane.swift:944-965` (`waitLine`); amber threshold `SessionFleet.swift` `longAfter` = 15 min.
- Experiences: GATE-LANE-WIDTH: `since` 20:27:54 at 20:35, then 20:37:07 at 20:40 with a new label ("gated commit: guards, core budget, README, hand-off"). The tab had been on the gate for 13 minutes in total and the row said "3 min". Five labels changed in ten minutes across the fleet. A tab that waits job after job never reaches 15 minutes, so amber (and any future alarm) never fires for the worst case.
- Breaks: Visibility of system status; Doherty (long waits need honest progress cues).
- Fix: sidecar keeps `waitingSince` per session across consecutive waits (reset only when a turn does real work) and adds `jobs` (count); row reads "gated commit: guards... · 3 min (13 min on the gate, 3rd job)". Amber from the total.
- Size: M (sidecar field plus row text). Evidence: feed reads at 20:35:11 and 20:40:40 (GATE-LANE-WIDTH `waitingOn.since`); pane `k-pane.png`.

### The chat column

**R2-05 · High · Stacked status cards take about half the transcript's height, and each is a different colour**
- Where: `ChatPreviewView.swift` (scope-met bar near 4074-4119, backlog strip near 4454, plan card near 3635, waiting card, files-changed bar).
- Experiences: in GATE-LANE-WIDTH (`e-tab-gatelane.png`) the transcript gets 310 of 1030 display px between the orb and the composer; the rest is: a purple plan card (about 100), a purple "waiting on a background job" card (about 50), an orange "2 files changed" bar, a blue backlog strip, then a 150 pt composer. In B54 (`a-full.png`) the stack is a grey scope-met bar, a blue backlog strip and a green plan card. The only text the owner reads, the assistant's last report, is squeezed to a dozen lines.
- Breaks: Cognitive load (extraneous); Prägnanz; Selective attention (five colours, none of them is "do this").
- Fix: one "tab status" strip, one line high by default ("4/5 steps · waiting on gate 3 min · 2 files · 325 parked"), expands on click; only the card that needs an action (a plan to approve, a confirm) stays open. Backlog and plan live behind it.
- Size: M. Evidence: `e-tab-gatelane.png`, `i-chat-bottom.png`.

**R2-06 · Medium · The orb takes 20% of the column and says "idle" for a tab that waits on a job**
- Where: orb above the tab strip (`BrainMetalView.swift:695-810`, caption "STATE"). Round 1 S-02 stays open; new: it moves all the time (a different shape in every capture) and says "STATE idle" while the selected GATE-LANE-WIDTH tab, in the same screenshot, says "Waiting on a background job".
- Experiences: 270 pt of height for a decoration that disagrees with the pane; two status words in one view.
- Breaks: Visibility (two statuses); Emil: never animate what is seen all day.
- Fix: shrink to a 24 pt state dot in the chat header driven by `SessionRowState` (working / waiting / needs you / finished), orb on demand.
- Size: S to M. Evidence: `e-chat-gatelane.png`.

**R2-07 · Medium · The scope-met bar is the quietest element of the most important moment**
- Where: `ChatPreviewView.swift:4074-4119` (three chips "Save session note", "Start fresh next turn", "Audit session").
- Experiences: label "Scope met" in dim 9.5 pt, three identical grey chips; none is the step the owner takes next (look at the diff, mark reviewed, merge). "Save session note" and "Start fresh next turn" are housekeeping.
- Breaks: Peak-end; Von Restorff; Funnel stage: Action.
- Fix: one primary chip "Mark reviewed" (also clears the Finished row), "Review changes" beside it when the tab has a diff; the other three in a "…" menu. Make "Scope met" the strip's state word, in the same colour as the Finished dot.
- Size: S. Evidence: `i-chat-bottom.png`.

**R2-08 · Medium · "Plan complete 4 of 4 steps" lists paragraphs, two lines each, in a nested scroll area**
- Where: plan card (`ChatPreviewView.swift:3635` area, `PlanModel.swift` text).
- Experiences: each "step" is a whole rule from the brief ("On the Mac (no Java): `git diff --cached --check`; ...") cut at two lines, with a scrollbar inside the card in GATE-LANE-WIDTH. It reads as a wall, and a card with its own scrollbar inside a scrolling chat traps the wheel.
- Breaks: Chunking; Miller; Mental model (a step is an action).
- Fix: show the first sentence or the bold lead only; click to expand; cap at five rows then "show all 8".
- Size: S. Evidence: `i-chat-bottom.png`, `e-chat-gatelane.png`.

**R2-09 · Medium · Machine messages are labelled "you"**
- Where: `ChatMessageRow.swift:148` (`case .user: "you"`); only supervisor-marked messages get another label (lines 50-62).
- Experiences: "[scheduled wakeup — background job done: gated docs commit]" and "A background job you started earlier has finished. Command: ... Result: exit code 0 ... It succeeded — continue the work" appear right-aligned in the user's bubble with the label YOU (`f-tab-reges.png`; the GATE-LANE-WIDTH card has the same bubble). He did not write them. Scrolling a tab back, he cannot tell what he said from what the system said.
- Breaks: Mental model; honesty of attribution (same class as ADR-0127's rule that nothing but the user is drawn as the user).
- Fix: mark machine-originated user turns (the sidecar knows: wakeup, job done) as "system · job finished", no bubble, collapsed to one line with the exit code.
- Size: S to M (a flag from the sidecar, or the text prefix `[scheduled wakeup` as a first cut).
- Evidence: `f-tab-reges.png`.

### Restarts and queue

**R2-10 · Medium · The restart banner cannot name the tabs that were re-queued**
- Where: `SessionRestartTrace.swift` (header: re-armed jobs "carry no structural mark"); banner only in `SessionsPane.swift:306`.
- Experiences: tonight's cause was re-armed jobs, not cut-off turns. The feed has "gated commit rerun after restart: baseline" for b53a and the pane prints it as an ordinary wait. A banner for cut-off turns exists, which is the rarer case. It is also only visible with the Sessions pane open.
- Fix: sidecar sets `waitingOn.rearmed: true` (and the restart time) on jobs it re-armed; the row chip says "re-queued after restart"; the banner counts them and shows in the status bar chip for the first minutes.
- Size: M. Evidence: feed (b53a label); source for the gap. Not seen: no restart happened while I looked.

### Panes

**R2-11 · Medium · The ring on every row is the supervisor-delegation menu, icon-only, with no label and a ragged column**
- Where: `SupervisorInboxViews.swift:673-720` (`SupervisorDelegationChip`, glyph only on pane rows, 10 pt in an 18x16 target); README S-04 could not name it, now it is named by comparing with the Supervisor workspace ("○ Off ▾" per tab).
- Experiences: eleven identical empty circles that look like unchecked radio buttons or placeholders. The column they and the chips (Reviewed, Stop) share has three different x positions (Finished 705, Working 730, Waiting 773 px in `b-pane-top.png`), so the right edge looks unfinished.
- Breaks: Recognition over recall; Law of similarity; Apple "Craft" (alignment); Fitts (18x16).
- Fix: while delegation is Off for every tab, show nothing; when anything is on, show the glyph with its word on hover and a 24 pt target. Pin the action column to one x.
- Size: S. Evidence: `b-pane-top.png`, `b-pane-bottom.png`, `d-pane-supervisor.png`.

**R2-12 · Medium · Source control shows the project's shared checkout whatever tab is selected**
- Where: Source control pane (`d-pane-scm.png`): branch `feature/s00-production-capability-truth`, "2171↑", "Commit 100" with 100 staged files; the selected tab B54 is an isolated worktree on its own branch. Cause not read in source (I read only the capture).
- Experiences: a big "Commit 100" button over staged work that belongs to nobody he is looking at, while every tab works on a worktree branch. The graph panel below shows tab branches in a list nobody can act on from here. Risk: a click commits the wrong tree.
- Fix: header names the tree ("Project checkout, not the selected tab"), and a switch to the selected tab's worktree; the commit button says what it commits ("Commit 100 files to feature/s00…").
- Size: M. Evidence: `d-pane-scm.png`. Source only for cause: not verified.

**R2-13 · Medium · Opening the Supervisor workspace removes the chat column and the tab strip**
- Where: `d-pane-supervisor.png`: the right column becomes Supervisor Tabs / Queue / Log / Settings; the strip with its states is gone, and the middle column holds the supervisor chat.
- Experiences: good use of the empty middle (it answers W-11 for this one pane). But while it is open he cannot see the strip's states or reach a tab's chat; and its content still contradicts itself ("Autonomous · 3 of 4", "watching 21", "NOT WATCHED 11", S-03 still open).
- Fix: keep the strip visible; put the Supervisor chat in the middle and leave the right column to the selected tab.
- Size: M. Evidence: `d-pane-supervisor.png`.

**R2-14 · Medium · Status bar: an internal metric in red, and three unlabelled items**
- Where: `AppStatusBar.swift:522-545` (graph/reads counters coloured by drift), 683 (cost), 703 (bell). `status-right.png`.
- Experiences: "graph 164 · reads 273" is red on every tab where reads exceed graph calls. Red means error everywhere else in the bar; this is "MARVIN bypassed graphify", which the watcher cannot act on. Next to it "ctx 196K" has no limit, "activity" has no explanation, "≈$431.27" does not say whether it is this tab, this project or lifetime (it moved to $432.17, 432.44, 432.80 while I switched tabs, so it is not per tab), and the bell has no count. (Round 1 S-06's "2.165 up" is the number of unpushed commits, now "2.171↑".)
- Breaks: Common region (red = error); Selective attention; Recognition.
- Fix: move the graph counter to the chat header and out of red; "ctx 196K / 1M"; "$431 today · project"; explain the sync number with its tooltip ("2,171 commits not pushed").
- Size: S. Evidence: `status-right.png`, `d-pane-supervisor.png`.

**R2-15 · Medium · Skills pane: three local skills show ">" as their description, eight rows carry the same blue "Update" button**
- Where: `d-pane-skills.png`: `evidence-pack-runbook`, `flyway-multi-tenant-migrations`, `gdpr-erasure-runbook` print ">" where the description should be. Likely cause: a folded YAML description (`description: >`) read literally by the index (`sidecar/packages/runtime/src/skills-index.ts` around line 126); not verified.
- Experiences: a bug that looks like a placeholder; the "Update" chip repeated on eight rows turns a normal state into noise, and 36 skills have no search or filter.
- Fix: parse block scalars; one "Update all (8)" action at the top; a filter field.
- Size: S. Evidence: `d-pane-skills.png`.

**R2-16 · Medium · Plugins pane: the three enabled plugins are scattered among 21, and the same warning repeats on nine rows**
- Where: `d-pane-plugins.png` (alphabetical; enabled: frontend-design, impeccable, playwright, ponytail ... farther down), orange "hooks never load" on nine rows although the header already says "Hooks are never loaded".
- Fix: enabled first, then the rest; drop the per-row warning or show it once as a footnote.
- Size: S. Evidence: `d-pane-plugins.png`.

### Mac conventions

**R2-17 · Medium · Menus: app-level items sit in Window, session stepping in File, the one command he needs in a Go menu full of code navigation**
- Where: `MARVINApp.swift:741-745` (Window: Show MARVIN, then the registry's `.help` items: Keyboard Shortcuts ⌘/, Check for Updates…, Copy App Diagnostics); `CommandRegistry.swift:118-135` (Previous / Next Session in File; Next Tab That Needs Me in Go with Quick Open, Go to Symbol, Definition, Line, Problem, Hunk...); Help menu has onboarding and GitHub only.
- Experiences: on a Mac, Check for Updates lives in the app menu and Keyboard Shortcuts in Help. Show MARVIN has no shortcut. Menu structure read from source; I did not open the menus.
- Fix: move the three `.help` commands to the App and Help menus; add a "Sessions" menu (Next Tab That Needs Me, Next / Previous Session, Show Sessions, Show MARVIN) or put them at the top of Window.
- Size: S. Evidence: source only.

**R2-18 · Medium · Selecting a tab slides the strip, and it still shows six of eleven tabs**
- Where: `ChatPreviewView.swift` strip (scroll to selection). `e-tab-gatelane.png`, `f-tab-reges.png`.
- Experiences: I clicked GATE-LANE-WIDTH at x 2130; it moved left by about 90 px and the tab that arrived under the pointer was a different one. Done and waiting tabs differ only by a ✓ or a clock in the same grey (at 8 pt); six of eleven fit, so five need the arrows or the list. A finished-unreviewed tab has no strip mark I could verify (those tabs were off-screen).
- Fix: scroll to selection only when the selected tab is not fully visible, and by the minimum; colour the clock amber past 15 minutes and the ✓ blue until reviewed (same colours as the pane); minimum tab width so 8 fit at 1x.
- Size: S to M. Evidence: `e-tab-gatelane.png`, `f-tab-reges.png`.

### Detail and craft (Low)

**R2-19 · Low · Raw timestamps and ids in tooltips**
- Where: tab tooltip prints "last active 2026-11-24T16:30:45.057Z" (`f-tab-reges.png`, `g-back-strip.png`). `ChatPreviewView.swift:3394-3400` `friendlyDate` uses `ISO8601DateFormatter()` without fractional seconds, so the sidecar's `.057Z` fails to parse and the raw string is returned. The History list uses the same helper. The row tooltip (`h-tip.png`) opens with the session UUID and the worktree path.
- Fix: `.withFractionalSeconds`, and print "last active 18:30 (4 h ago)"; show the id and path under a modifier key. Size: S.

**R2-20 · Low · Title bar: internal words, two magnifiers, an unexplained dot**
- Where: `ContentView.swift:346, 365`. Tooltips "Toggle panes — files, graph, brain, preview, terminal" and "Quick Open file (⌘P)"; the rail also has a magnifier (Search in files). The title's subtitle ends with a grey dot with no tooltip I found; it still shows the project branch, not the tab's (M-03 still open). `j-title-105.png`, `j-title-138.png`.
- Fix: "Show / hide panes", move Quick Open into the toolbar as a labelled field, explain the dot. Size: S.

**R2-21 · Low · Pane headers do not share a baseline or a style**
- Where: Files "agri-saas-platform" with two icons; Search no header; Source control "SOURCE CONTROL" without an icon, higher; Sessions "SESSIONS" with an icon, 9 px lower; Plugins "PROJECT PLUGINS 21", no icon, smaller. Titles sit at 55, 64, 61, 64, 65 display px (`d-pane-*.png`).
- Fix: one `PaneHeader` view with the same icon slot, baseline and size (`PaneChrome.swift` exists for this). Size: S.

**R2-22 · Low · The Idle list reshuffles when the selection moves**
- Where: `SessionsPane.swift:384-405` (`SessionIdleCollapse.partition` keeps the first three plus the selected). Selecting a Waiting tab turned "IDLE 5 / 1 more" into "2 more idle sessions", and the fourth row (REGES) disappeared (`c2-pane.png` versus `e-tab-gatelane.png`).
- Fix: keep the same visible rows; mark the selected row wherever it is. Size: S.

**R2-23 · Low · Composer: 150 pt of empty text area, an unlabelled icon, 11 pt controls**
- Where: `a-full.png`, `i-composer-bar.png`: the field is 160 pt tall when empty, the row below carries "Agent", "high", "advisor follow", a paperclip, a circled-dot icon I did not hover (a stop control?), and a disabled "Send". Fix: start at 2 lines and grow; label or tooltip every icon. Size: S.

**R2-24 · Low · Transcript: the role gutter repeats "marvin" on every tool card**
- Where: `ChatMessageRow.swift:140-150`, `e-chat-gatelane.png`: three Bash/MCP cards in a row each carry "marvin" in a 56 pt gutter; commands are cut at one line. Fix: gutter label only on the first row of a run. Size: S.

**R2-25 · Low · "Tell every tab…" does not say what it does**
- Where: `ProjectNoticesSection.swift:26`, `b-pane-bottom.png`: a small grey chip under the Idle list. With seven paid tabs live, a word on the consequence (a notice added to every tab's next turn, ADR-0131) belongs on the chip or its tooltip. I did not click it. Size: S.

**R2-26 · Low · A project-wide count lives in every tab's card strip**
- Where: "323 / 325 backlog items parked" with an Open button in every tab (`a-full.png`, `f-tab-reges.png`); it grew by two while I watched. It asks nothing and costs a row. Fold into R2-05's status strip. Size: S.

## Round 1 findings: still open, confirmed on screen

- **W-03** state line 9.5 pt, cut in the middle: finished and idle rows still end "... · $3.40 · Done · 6m ago"; waiting rows now have their own wait line (`b-pane-top.png`).
- **W-05** two ages on one row: "updated 59m ago" and "last turn 11m ago" on waiting rows (`k-pane.png`).
- **W-10** metrics on every row: "graph 20 · reads 19 (1.0×) · skills 0/6 · $4.10".
- **W-11** the empty middle: "No file open" fills 800 px beside a 770 px chat (`a-full.png`).
- **T-01** 9 to 10.5 pt text (the row subtitle peaks at about 5.8:1 contrast, so the problem is size, not colour).
- **T-02** "isolated: marvin/tab/..." on every row while the chip says "own branch".
- **M-03** window subtitle shows the project branch, not the selected tab's.
- **S-02** the orb (new fact in R2-06).
- **S-03** Supervisor "Autonomous · 3 of 4" watching none of the tabs (`d-pane-supervisor.png`).
- **S-05** a chip cut mid-word: "own branch · docs security b54 read of the unopened c" (`tabstrip-a.png`).
- **S-07** Practice cards with four buttons each (eight cards, about 30 buttons; two "regressed" tags say "the code fix did not hold"; `d-pane-practice.png`).
- **W-02** queue position: nothing says what is ahead on the gate.

Fixed since round 1 and checked: S-01 (waiting tabs read as waiting, for tabs that are open), W-01 (the job label is on the row), W-04 (oldest first; amber unproven), W-06 (summary present), W-08 (Finished group with a Reviewed chip), W-07 partly (titles, width, overflow states), N-02 (Allow is no longer the default key, source only).

## Strengths worth keeping

- The Waiting group row: label in brighter text, duration never truncated (`SessionsPane.swift:944`), the group above Idle and never folded.
- The overflow list: glyph plus words, "finished, not reviewed" in plain language.
- The rail tooltips appear at once; the in-tab "Waiting on a background job" card (what, step count, next step, "the tab resumes when it finishes").
- One derivation (`SessionRowStateDeriver`) feeds pane, strip and status bar, so those three agree with each other; the disagreement is with the feed (R2-01), not between surfaces.
- The tab header chips (own branch, model, advisor, permission) and the plan card's green ticks read well.

## Build order: the next 12 fixes

Ranked by value to someone watching 14 tabs. Groups are separated by files so they can go to different implementers without collisions; where groups share a data type the dependency is named.

**Group A: the fleet and the Sessions pane** (files: `macos/MARVIN/SessionsPane.swift`, `macos/MARVIN/SessionRegistry.swift`, `macos/MARVINLogic/SessionFleet.swift`, `macos/MARVINLogic/SessionRowState.swift`, `macos/MARVINLogic/TabNotifications.swift`, `macos/MARVINLogic/SessionRestartTrace.swift`, `macos/MARVIN/SupervisorInboxViews.swift` for the chip only)
1. R2-01 waiting sessions with no tab stay in the fleet (S)
2. R2-02 one name for a tab everywhere: pane, notification, confirm (S)
3. R2-11 and W-03 and W-10: two-line rows, state first, metrics to a hover card, one action column, label the delegation ring (M)
4. R2-03, count half: `FleetCounts.longWaiting` and `finishedUnreviewed` in `SessionFleet.swift`, which group B then reads (S)

**Group B: the signals outside the pane** (files: `macos/MARVIN/LeftPane.swift`, `macos/MARVIN/AppStatusBar.swift`; starts after step 4 of group A)
5. R2-03, display half: amber chip and rail badge for long waits and finished results (S)
6. R2-14 the red internal metric, context limit, cost label, sync tooltip (S)

**Group C: the chat column** (files: `macos/MARVIN/ChatPreviewView.swift`, `macos/MARVIN/ChatMessageRow.swift`, `macos/MARVIN/BrainMetalView.swift`)
7. R2-05 one collapsible status strip instead of five tinted cards, with R2-07 (one primary chip on scope met), R2-08 (plan steps as titles) and R2-26 (backlog count) (M)
8. R2-06 orb shrinks to a state dot that agrees with the pane (S to M)
9. R2-09 machine messages stop being "you", and R2-19 the fractional-seconds date bug in `friendlyDate` (S)
10. R2-18 tab strip: scroll by the minimum, amber clock, blue unreviewed tick (S to M)

**Group D: sidecar** (files: `sidecar/packages/runtime/src/session-watch.ts` and the wait/job code that fills `waitingOn`; coordinated with group A for the row text)
11. R2-04 cumulative wait and job count, then R2-10 `rearmed` marker for jobs re-run after a restart (M)

**Group E: panes and shell** (files: `macos/MARVIN/SkillsPane.swift`, `macos/MARVIN/PluginsPane.swift`, `macos/MARVIN/ContentView.swift`, `macos/MARVIN/MARVINApp.swift`, `macos/MARVINLogic/PaneChrome.swift`, `sidecar/packages/runtime/src/skills-index.ts`)
12. W-11 and R2-13: use the empty middle column (the Supervisor workspace already does) and keep the strip visible, then R2-17 menus and R2-12 Source control naming its tree (L overall, start with R2-17 and R2-15 as the small ones)

Where it sits against value: 1 to 6 are what he looks at every minute; 7 to 10 decide how much of the chat he can read; 11 makes the amber honest; 12 is the layout change that takes the longest.

## What I could not see, and why

- **Pinned "needs you" chips, a confirm card, a question, a failed or interrupted tab, a scope-met card with Review or Merge buttons in use**: nothing needed me, and I may not trigger or click these.
- **Amber for a long wait**: no wait reached 15 minutes (longest 12 min). Seen only in `waitLine` source.
- **Restart banner, notifications, Go ▸ Next Tab That Needs Me, Window ▸ Show MARVIN, all menus**: the first and last need a restart or a relaunch; notifications need a real event; the shortcut and the menus were off-limits. Read from source only; none was used.
- **Start-up screens and the launch window safety net**: need a launch or a dead sidecar.
- **The status-bar fleet tooltip**: hovered for 2.5 s, no tooltip showed; the rail and title-bar tooltips did, so this may be the bottom edge or timing.
- **Hover states of chips, row hover card, focus rings by keyboard, VoiceOver, light theme, other display sizes**: not exercised; only the dark theme at 2560x1440.
- **The cause of R2-12 (Source control showing the shared checkout) and of R2-15 (">" descriptions)**: seen on screen, mechanism not read or proven.
- **Search results, a long search, the Files pane with a file open, Settings**: Search was opened but not used (no typing allowed); Files was only seen as a tree; Settings is off-limits.

## Evidence files (`shots2/`)

`a-full.png` (start state, B54 selected, Files pane), `rail-b.png`, `status-left.png`, `status-right.png`, `tabstrip-a.png`, `tabstrip-b.png`, `b-sessions-pane.png`, `b-pane-top.png`, `b-pane-bottom.png`, `c-overflow.png`, `c2-pane.png`, `d-pane-search.png`, `d-pane-scm.png`, `d-pane-skills.png`, `d-pane-plugins.png`, `d-pane-practice.png`, `d-pane-supervisor.png`, `e-tab-gatelane.png`, `e-chat-gatelane.png`, `f-tab-reges.png`, `g-*.png` (hover and back to B54), `h-tip.png`, `i-chat-bottom.png`, `i-composer-bar.png`, `j-title-105.png`, `j-title-138.png`, `k-feed-vs-pane-2040.png`, `k-pane.png`, `k-status.png`, `z-final.png` (state I left it in).
