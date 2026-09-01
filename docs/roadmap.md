# Roadmap

What's in flight, what's deferred, and what MARVIN deliberately won't do. The chronological record of what shipped, when, and why lives in [`docs/history/CHANGELOG.md`](./history/CHANGELOG.md). Material decisions live in [`docs/decisions/`](./decisions/).

## In flight

- **File mentions that MARVIN itself just wrote did not link (2026-09-01).** Shipped one version late: `ProjectFileIndex` loaded **once per project**, so a report or plan the agent generated during the session was never in the snapshot — no resolution, therefore no link and no icon. The files MARVIN mentions most are exactly the ones it just created, which made the feature miss its most common case; an existing `robots.txt` linked in the same reply, which is what made the pattern visible. Three fixes, because each closes a different hole: a **disk fallback** for a literal relative path (immediate, no refresh needed, memoised because chat re-renders per streamed token and this would otherwise be a `stat` per mention per frame); a **debounced reload on turn completion** for the bare-basename case, which keeps the old index serviceable while the new one loads so mentions never flicker from link to plain text; and the index generation folded into the **inline attributed-string cache key**, without which a mention that failed to resolve on first render would keep its cached link-less string forever and never become clickable however many reloads ran.



- **The constraint storm — one oscillator removed, at least one path left.** Not fixed, and deliberately still listed. `LeftPane`'s width measurement was a latch with no deadband — `GeometryReader → preference → onPreferenceChange` wrote `collapsed`, collapsing changed the measured width, and a single threshold let it cross back. Every cycle re-formed the `HSplitView`'s panes and re-set each hosting view's root (`SystemSplitView.updateNSViewController → formCurrentItems → updateRootViewForItem → NSHostingView.setRootView → setNeedsUpdate`). With two sessions the update rate doubled and it stopped converging: **100 % CPU, `STAT R`**, the app unresponsive. Fixed with `onGeometryChange` (geometry without inserting a view) plus a real deadband (`SidebarCollapse`, collapse below 110 / expand above 150). **Measured after: 2.8–6 % CPU, `STAT S`** — but **5 storms still fire per launch, the same count as before**, with a different signature (`_updateConstraintsForSubtreeIfNeeded → updateConstraints → requestUpdate`). The frequency did not improve; the consequence did. Next step is the same method that worked twice today: instrument before theorising.




- **"Claude Code process aborted by user" on a session switch — cause unknown, now attributable.** Reported 2026-09-01. Verified NOT to be the client's switch path: `hydrate()` detaches the local stream and explicitly does not cancel server-side, `selectSession` does not cancel, and the SSE disconnect handler deliberately does not either. The string is the **SDK's own** error, not `cancelLiveTurn`'s "cancelled by user" — `endLiveTurn`'s `ended` guard keeps whichever terminal lands first, so MARVIN's own message was being suppressed and the log showed an unexplained kill. 158 occurrences across one project's transcripts, none attributable. `cancelLiveTurn` now takes a `source` and logs `turn.cancelled`; the macOS side carries the affordance name through `/api/chat/cancel`. If the banner reappears with **no** `turn.cancelled` line, MARVIN is not cancelling at all and the CLI subprocess is dying on its own — a different investigation.




- **IDE parity — the remaining tranches.** Full matrix at [`docs/reference/ide-parity.md`](reference/ide-parity.md). **LSP consumers** (the transport shipped in [ADR-0099](decisions/0099-lsp-client-for-live-diagnostics.md), so these are UI work now): Go to References / Declaration / Type Definition / Implementations, Go to Symbol in Editor, hover, quick fixes, editor squiggles from LSP ranges. **Each needs its own ADR:** multi-cursor, split editors, and a DAP client — the entire Run menu is still empty without one. **Deferred with reasons, not silence:** Replace in Files is a multi-file mutation needing a preview-and-confirm story under the mutation gate; Split Terminal needs `TerminalSessionStore` (one session per `workDir`) to become N sessions plus the pane UI to address them.




- **One session per working tree is a rule with no enforcement.** Golden Rule 1 states it in prose; nothing checks it. On 2026-09-01 two sessions ran against the same checkout and collided — one found an uncommitted ADR edit with a 50-second-old mtime it never wrote, plus a `git pull` and a branch checkout it never issued, and correctly refused to push or tag. It behaved well; it should not have had to. `turn-registry` already knows every live turn's session and the project knows its `workDir`, so the check is cheap. This repo has measured prose guidance firing ~0× more than once — that is why the graphify rail, the memory write path and backlog capture all became mechanical gates. Needs its own ADR.

## Current version

**v0.1.100** — IDE parity, four bugs that only measurement found, and a learn-loop that proposes rather than writes.

Since v0.1.94 the work has been in two halves. The first is **parity with the
reference IDE**: an [LSP client](./decisions/0099-lsp-client-for-live-diagnostics.md)
whose diagnostics come from the buffer rather than from disk, a
[command registry](./reference/ide-parity.md) that makes the menus, the ⇧⌘P
palette and the ⌘/ help sheet three renderings of one array, source control
that reaches the reference's feature set, a Problems panel that searches the
whole tree, and a tranche of self-contained editor commands — Save All,
Revert, Auto Save, Word Wrap, Toggle Block Comment, Expand/Shrink Selection,
Go to Bracket, Next/Previous Change, Run Active File.

The second half is a lesson, and it is worth more than the features. **Four
bugs in a row were diagnosed wrongly from reading source, and settled
immediately once something was measured:**

| Symptom | Wrong guesses | What measuring said |
|---|---|---|
| File tree drawn over the title bar | 3 (ScrollView ideal height, VStack centring, missing `.clipped()`) | A probe: container at y=52, tree at y=0. Not too tall — 52pt too high, exactly the title bar. `VSplitView` does not inherit the safe area. |
| App frozen with two sessions | — | 100 % CPU, `STAT R`; the stack named a closed loop through `NSHostingView.setRootView`. A width latch with no deadband. |
| Stop-All button dead | — | It gated on `bridge.activeMarvinSessionId`, which nothing had set since the WebView was removed. |
| Sessions "interconnected" | — | Distinct SDK session ids per transcript: conversations were separate. They collided on the **working tree**, which Golden Rule 1 forbids. |

The general form: a rail keyed on something the framework can change out from
under you is only as durable as that thing. Three of these were UI state that
had quietly stopped meaning what its name said.

**Still open, and listed as such:** the constraint storm still fires 5 times a
launch — one oscillator is gone and it no longer pegs a core, but the
frequency is unchanged; and "Claude Code process aborted by user" on a session
switch has no known cause, only new telemetry that will name it next time.

## Recent milestones

The high-water marks. Diagnostic detail per release in the [changelog](./history/CHANGELOG.md).

### 2026-08-31 → 09-01 — v0.1.94 … v0.1.100: IDE parity, and four bugs found by measuring

_Shipped. Kept in full because each carries the diagnostic trail; the short version is in the
[changelog](./history/CHANGELOG.md)._

- **`/refine` — a session proposes what it learned, and writes nothing ([ADR-0101](decisions/0101-refine-proposes-practice-lessons.md), 2026-09-01).** Prompted by [Prime Agent](https://www.primeintellect.ai/blog/prime-agent)'s **Continual Harness**. Most of that project does not survive contact with this one: its **RLM** spawns real child agents sharing the working directory and talking to each other without the user — the shape Golden Rule 1 forbids and the gate hard-denies — and its control surface is a Python REPL in which file ops, shell and subagents "happen through code", which deletes the structural confirm gate (you cannot pre-flight an `Edit` that is a line inside a program the model wrote). Their own docs are candid: *"not a security sandbox"*, plus documented reward hacking "despite explicit safeguards". **One idea survived, and it is the small one.** Measured on a real project, MARVIN's durable layers hold 106 facts, 570 backlog items and 356 plans — and none of them holds *how to work on this project*. A day's work on 2026-09-01 produced four such lessons and the only home for them was a hand edit to `CLAUDE.md`; a user's project has no equivalent. So: a `practice` content class on the existing `remember` store (a new `.marvin/practice/` was rejected for the reason ADR-0100 rejected `.marvin/conditions/` — a store must earn its own lifetime), and a `/refine` command that **proposes only**. **What was deliberately NOT taken:** a self-refining prompt — MARVIN's firm surfaces are load-bearing *because* they are fixed, and an agent that can soften a MUST it finds inconvenient has no MUSTs (Prime Agent draws this line too, never rewriting its immutable base); and automatic refinement at turn end, which is precisely how a project's `memory.md` reached 419 KB and ~99 % redundancy (ADR-0042). **The trigger is the part worth having:** this repo has measured valuable-but-optional model behaviour firing ~0× — skills across thousands of qualifying contexts, `graph_save_result` at 0 in an audited window — so relying on MARVIN to *notice* it learned something has a known failure rate, while a command the user runs does not. An unevidenced lesson is rejected **at the write boundary**, not discouraged in a prompt: `validateRememberPayload` was extracted from the MCP closure so that claim could be tested rather than asserted. 8 assertions.



- **Clicking a filename in chat opens the file, and file mentions carry a type icon (2026-09-01).** User, against the reference IDE: *"if i click a file mentioned there in the chat, i get the file opened in the central pane… also the chat has icons with the file types."* MARVIN already linkified file mentions — but only ones that resolved **literally** under `workDir`, and models name files the way people do: `sdk-runner.ts`, not `sidecar/packages/runtime/src/sdk-runner.ts`. So the common case stayed plain text. A `ProjectFileIndex` now loads the project's file list once per project from `/api/files/tree` (the call Quick Open already makes) into a basename index, and `MarkdownLinks.fileSpans` resolves through it. **Matching is deliberately conservative**, because a link that opens the *wrong* file is worse than no link: an exact relative path wins outright; otherwise the mention must match **whole trailing path segments**, so `runner.ts` does not resolve onto `sdk-runner.ts` and `src/index.ts` does not resolve onto `websrc/index.ts` — a raw string suffix would have done both. Several matches are all kept and the click **asks** which was meant rather than picking one. Each file link now carries its type icon as an inline `NSTextAttachment`, tinted by `FileTypeIcon` (the file tree's own mapping) and sized against the surrounding font; icons are inserted **back-to-front** so each insertion cannot invalidate the ranges of the spans still to be processed. 14 assertions on the resolver. **Icons not yet verified visually** — the headless markdown rasteriser has no project, so no mention resolves in it and no icon renders; the render is byte-identical to before for unresolved mentions, which is the correct no-op.



- **Selection could not cross a line, because every block was its own text view (2026-09-01).** User: *"i can't select new lines in the box, i can only select 1 line at a time."* Chat prose renders through `RichText`, an `NSTextView` per block — it exists because SwiftUI's `Text` gives you selection **or** a working link cursor, never both. The cost was invisible until someone tried to copy: **selection cannot cross two independent text systems**, so a drag stopped at the end of whichever paragraph or bullet it began in. The fix is to stop making so many of them — `MarkdownFlow.group` merges consecutive headings, paragraphs and lists into ONE text view, so a drag across a heading, its paragraph and the bullets below it is a single selection. Spacing moves from the VStack into `paragraphSpacing`, and list markers move into the text with a tab stop and `headIndent` so a wrapped item still aligns under its own first line rather than under the bullet. Code blocks, tables and rules stay standalone — each is a different view with its own layout, highlighting or geometry — and **quotes** stay standalone too, because the bar down their left edge is an overlay on the view and merging one would leave the bar spanning its neighbours' text. Verified with the repo's own headless rasteriser (`MARVIN_SNAPSHOT_MD`, which renders `MarkdownView` to a PNG with no window and no session): heading, both list types, quote, table and code block all render as before. 11 assertions on the grouping. The `Copy Message` command added the previous day stays — it reads the model rather than the view, so it still works on the parts selection cannot reach (a table, a code block).



- **The constraint storm's oscillator, a permanently-disabled button, and a brain that showed the wrong session (2026-09-01).** Three findings from one report — *"i just started 2 sessions and marvin and it seems now it's stuck"* — with the app pegged at **100 % CPU, `STAT R`**, five storms, then the monitor's own report cap. **(1) The spin, diagnosed from the stack rather than from reading code:** `SystemSplitView.updateNSViewController → SplitViewCoordinator.formCurrentItems → updateRootViewForItem → NSHostingView.setRootView → setNeedsUpdate`, a closed loop. `LeftPane` measured its width through `GeometryReader → preference → onPreferenceChange` and wrote `collapsed` state from it; collapsing changes what the pane renders, which changes the measured width, and the threshold was **one value used in both directions**. A latch with no deadband is an oscillator, and `HSplitView` re-forms its panes and re-sets each hosting view's root on every update. Two sessions doubled the update rate and it stopped converging. Fixed with `onGeometryChange` (reports geometry **without inserting a view** — what `WidthReporter` was reaching for in v0.1.93, which did eliminate the storm before crashing because it added subviews in three places) plus `SidebarCollapse`, a real deadband: collapse below 110, expand above 150, so the width collapsing produces cannot itself trigger an expand. Measured after: **3–6 % CPU, `STAT S`**, sustained. **Storms are NOT gone** — three fired in three minutes, with a *different* signature (`_updateConstraintsForSubtreeIfNeeded → updateConstraints → requestUpdate`), so one oscillator is removed and at least one path remains; what changed is that it no longer pegs a core. **(2) The Stop-All button was permanently disabled** — it gated on `bridge.activeMarvinSessionId`, which **nothing has set since the WebView was removed**, a dead property that still had readers. Now published from `ChatPreviewModel` whenever its session id changes, and the button reads the model directly, which also makes the scope right by construction with several sessions open: the one on screen is the one that stops. **Moved to the input footer beside Stop** (user: *"i don't like where you placed the button, i need to open a new menu to click stop"*), ⇧⌘., shown even when no turn is running — jobs and wakeups outlive the turn, so the moment they most need stopping is exactly when nothing is streaming. **(3) The brain showed whichever session wrote last.** `marvinState` was one untagged global written from eight sites, and turns that are not on screen still stream. It is now `setMarvinState(_:forSession:)`, and a write from a session that is not the active one is **dropped, not queued** — the brain is a picture of what the user is looking at, and another session's state is not a stale version of that but an answer to a different question. The rule is a pure `BrainStateGate` with the nil cases pinned (teardown must still idle; a brand-new chat reports progress before the server gives it an id). 18 new assertions.



- **Stop a session and everything it left running — confirm-gated, and scoped to ONE session (2026-08-31).** The existing Stop button aborts the in-flight turn and nothing else, which is right for what it is ("stop talking, I want to say something"). But a turn leaves work that outlives it: `run_in_background` jobs are their own child processes, and a **scheduled wakeup will start a NEW turn later, by itself** — so pressing Stop and walking away leaves a session that talks back minutes after the user thought it was over. New `POST /api/session/stop-all`, deliberately separate from `/api/chat/cancel` rather than folded into it. **Cancel order is load-bearing:** wakeups, then jobs, then the turn — a wakeup cancelled last can fire while the turn is being torn down and start a fresh one, and a job killed after the turn ends can still fire its completion turn. Killing the things that *create* work before the thing *doing* work is what makes it idempotent instead of a race; pinned by a test asserting the call order. **The confirmation names the scope, by count:** a `GET` preview reports what *would* stop, and the alert reads "the running turn, 1 background job and 2 scheduled wakeups". "Stop everything?" is a question a user cannot answer — they do not know what everything is, and one item might be a forty-minute build they forgot about. Lives in the **Activity popover**, which already lists those jobs and wakeups, so the user confirms while looking at what they are killing; also in the Run menu and the ⇧⌘P palette, both of which just open that popover rather than growing a second confirm flow. **Scoped to one session (user: *"we only need to kill the session we want with it's adiacents, not the rest of the sessions or their jobs"*).** The server side already filtered by `marvinSessionId` throughout; the one global was the macOS terminal, where `terminateAll()` would have closed every project's shell. Now `isRunning(workDir:)` / `terminate(workDir:)`, one project only — `terminateAll` survives solely for app quit, where it is correct. A test pins that stopping session A cancels only A's job, A's wakeup and A's turn, and that **no list call is ever made unfiltered** — an unfiltered list is how "stop this session" quietly becomes "stop them all". Terminal shells are named separately in the confirmation rather than folded into "background jobs", because they are the user's processes, not MARVIN's. 6 assertions. **Not verified live** — it needs a running session with real jobs to click through, and installing would replace the user's IDE mid-session.



- **`CLAUDE.md` was never injected into project context (2026-08-31).** `DEFAULT_FILES` in `project-context/src/index.ts` was `["PROJECT_STATUS.md", "BUSINESS_OVERVIEW.md", "README.md"]` — the most standard instruction file in the ecosystem, present in nearly every project a Claude Code user brings to MARVIN, and MARVIN read past it. A user whose conventions lived there watched MARVIN work as if they had never written them down, with nothing anywhere to say why. Now first in the list, because it is **instructions** rather than status: the others describe what the project is, `CLAUDE.md` describes how to work on it. `CLAUDE.local.md` deliberately stays out — the personal, never-committed override is a separate decision about whose machine's preferences steer a session, not a default. Found while assessing a community "anatomy of a .claude/ folder" diagram against MARVIN: almost everything else on it is either already present under `.marvin/` (skills, plugins, memory, backlog) or deliberately rejected by an existing ADR — `agents/` is Golden Rule 1, `hooks/` is [ADR-0054](decisions/0054-plugin-agents-read-only-hooks-stay-stripped.md) §2, and `settings.json` is the isolation mode that makes the confirm gate mean anything. The one unglamorous gap was the file everybody actually has. 2 assertions, the first confirmed red against the old list.



- **Copying a message, and the file tree's context menu (2026-08-31).** User: *"i can't select the text, reason is i want to copy it from here."* **Copy Message** on every message's context menu, reading the **model** rather than the rendered view — so it works regardless of what drag-selection does, and it copies the WHOLE message, which is what dragging across it was trying to achieve. Tool calls copy as `$ Bash ls -la` through the same summariser the collapsed header shows (one implementation now, shared — what you copy is what you were looking at); redacted thinking copies nothing, being encrypted by design, so a placeholder would be copying MARVIN's own UI. **The underlying selection bug is NOT fixed and is deliberately not guessed at:** prose renders through an AppKit `NSTextView` (`RichText`, which exists because SwiftUI's `Text` gives you selection *or* a working link cursor, never both), that view already has `isSelectable = true`, and nothing above it disables hit-testing — there is no static explanation, and the layout bug immediately before this one cost four source-only guesses before a probe settled it in one launch. It needs the same treatment: instrument `mouseDown` / `becomeFirstResponder`, one drag, read the log. **File tree context menu**, against Antigravity's: added **Open With** (built from `urlsForApplications(toOpen:)`, so it is macOS's own list in its own order — right on any machine, nothing to maintain), **Open in Integrated Terminal** (MARVIN's terminal, not Terminal.app; a file opens its containing directory), **Copy** (the file itself, so a paste in Finder copies the file — distinct from Copy Path, because two different pastes expect different things) and **Copy Relative Path** (the form that means the same thing on someone else's machine). Not added, with reasons: *Open to the Side* needs split editors; *Select for Compare* needs a diff over two arbitrary files and MARVIN's diff is git-scoped; *Cut/Paste* needs a file copy/move write path plus a confirm story under the mutation gate; *Maven* is precisely what Golden Rule 6 forbids and is already generalised into the Tasks section. 12 new assertions, over block-to-text mapping and the relative-path edge cases (a sibling sharing a name prefix, a root with a trailing slash, a file outside the workspace).



- **The file tree's header was rendering above the pane — `VSplitView` does not inherit the safe area (2026-08-31).** User: *"on top the file explorer, the items are going out of bounds."* **Three fixes reasoned from source and all three were wrong** (a ScrollView's ideal height leaking through a `minHeight`-only frame; a `VStack` centring its overflow; a missing `.clipped()`). Instrumenting settled it in one launch: a probe using `onGeometryChange` — which reports geometry **without inserting a view**, unlike the `background(GeometryReader)` shape whose extra subviews made AppKit's runaway-pass breaker fatal in v0.1.93 — logged `paneContainer origin=(45, 52)` against `tree origin=(45, 0)`. The tree was not too tall; it was **52 points too high**, exactly the title bar. Its own 38pt header sat entirely above the container's top edge, plus the first ~14pt of the list. `VSplitView` bridges to `NSSplitView` and its hosted children do not inherit the window's safe-area inset — so the split view added days earlier for Outline/Timeline/Tasks *was* the regression. Replaced with a plain `VStack` and a real drag divider (widened hit area, resize cursor, clamped band). Verified the same way it was diagnosed: `treeHeader` now reports y=52, identical to its container. Losing the bridge also removes the ideal-size guessing it forced, and `_NSSplitViewItemViewWrapper` was among the constraint-storm triggers. **The lesson is the method, not the frame:** four attempts at a layout bug without measuring, one launch with a probe.



- **The tools panel, fourth shape — a stable ideal and a moving minimum (2026-08-31).** User, on v0.1.95: *"now the expand is not even working anymore"* — TASKS showed its open chevron and nothing under it. The panel's floor was a fixed `minHeight: 76`, which is three section headers and no content, so an expanded section had zero pixels to render into. The changing `idealHeight` removed one release earlier had been hiding this by force-growing the panel — the same property that made resizing feel wrong, since the split view re-applies an ideal on every expand and collapse and snaps the divider back after the user has dragged it. **The two are not the same knob.** An ideal is re-applied and therefore fights the user; a minimum only ever *pushes* — it claims room when a section opens, and on collapse it simply stops demanding, because `NSSplitView` does not reel a divider back in. So the floor now tracks the open-section count (capped, so three open sections cannot crush the file tree) while the ideal stays fixed: the panel can always show what it was asked to show, and a position the user chose stays chosen.



- **The self-contained parity tranche — and three registry slots that were never plugged into a menu (2026-08-31).** Ten commands off the [parity matrix](reference/ide-parity.md), plus one defect found while wiring them. **The defect:** `CommandRegistry` has eight menu slots and `MARVINApp` rendered five. `.file`, `.edit` and `.selection` were declared, listed in the ⇧⌘P palette and printed in the ⌘/ help sheet **with a shortcut** — but a key equivalent exists only on a menu item, and none of those slots was in a menu. So ⌘' (Toggle Line Comment), ⌥↑ / ⌥↓ (Move Line), ⇧⌘D (Duplicate) and the rest were documented keys that did nothing. The registry was built to stop precisely this drift and three-eighths of it was unplugged. File now renders from the registry (the hand-written `Open Project…` / `Reveal Project in Finder` buttons deleted — keeping them would have double-bound ⌘O and ⌥⌘R, the failure the registry exists to prevent), Edit appends to the system Edit menu, and **Selection** is a real `CommandMenu` — safe here in a way it was NOT for View, because macOS auto-creates View (which is how the menu bar once read "View View") and does not auto-create Selection. Adding two more groups then blew SwiftUI's `CommandsBuilder` arity, which the compiler reports as *"extra argument in call"* on whichever group happens to be last — an innocent line; Edit/Selection/Go/Run are now one `EditorMenus: Commands`. **The ten:** Save All (⌥⌘S, sequential — each save round-trips an `mtime`, and parallel writes make the stale-conflict alert ambiguous about which file it is asking about), Revert File (confirm-gated; the only one with no undo), New Text File (⌘N, posting to the file tree's existing naming sheet rather than growing a second one), Auto Save (off by default, 1.5 s debounce, through the same `mtime`-guarded path), Word Wrap (⌥Z, persisted), Toggle Block Comment (⌥⇧A), Expand / Shrink Selection (⌃⇧⌘→ / ⌃⇧⌘←), Go to Bracket (⇧⌘\), Next / Previous Change (⌥⌘↓ / ⌥⌘↑ over the diff gutter's existing hunks), Run Active File. **Two design calls worth naming.** Expand Selection was planned as a tree-sitter syntax walk; it is bracket- and line-based instead, because MARVIN wires 12 grammars and a syntax version would silently do nothing in every other language — **including Java, the language of the project that prompted this whole thread**. Shrink cannot be computed (there is no unique "next smaller span") so it replays the expand stack, which is what VS Code does too. And Run Active File encodes *interpreter* knowledge — "a `.py` file is run by `python3`" is true in every project, the same category as the comment tokens already shipped — never a project's own entry point (Golden Rule 6); a language with no single-file run leaves the command **disabled** rather than failing in the terminal. **Two deferred deliberately, with reasons rather than silence:** *Replace in Files* is a multi-file mutation and MARVIN gates mutations — it needs a preview-and-confirm story, i.e. its own ADR, not a menu item; *Split Terminal* needs `TerminalSessionStore` (keyed one session per `workDir`) to become N sessions plus the pane UI to address them — a refactor, not a command. **Verified:** `swift build` clean, **558 test assertions** (28 new, over block comments, nested bracket matching in both directions, the four-step expand progression and its stopping condition, and shell-quoting a path with a space or an embedded quote), installed and relaunched, no new crash report.


- **The Tasks panel, third time.** Two wrong shapes shipped before the right one, and the second was visible in a screenshot: user *"also now it's even worse"* — 53 task rows painted straight over the OUTLINE / TIMELINE / TASKS headers. Cause: `.frame(maxHeight: 260)` constrains the **proposed** size and does **not clip**, and I had removed the per-section `ScrollView`s on the theory that a scroll inside a scroll made the drag feel unpredictable. Wrong diagnosis — the yanking was the panel's `idealHeight` *changing* as sections opened, so the split view re-applied it after the user had dragged. Now: stable ideal height (that fix was right), each section scrolling its own content (a `ScrollView` bounds **and** clips, which the cap alone could not), and **no height cap** — a `ScrollView` accepts whatever height it is offered, so open sections divide the pane and a collapsed one costs only its header, which is how VS Code's sidebar behaves. The cap looked tidier and was worse both ways: dead space under a single open section, three open sections still cramped, only now with a magic number deciding how cramped.



- **Language servers, a command registry, and the first pass at Antigravity menu parity (2026-08-31).** Three asks in one pass. **(1) LSP client ([ADR-0099](decisions/0099-lsp-client-for-live-diagnostics.md)).** The Problems panel's CLI runners read from DISK and take seconds to minutes, so the list can describe a file the user already fixed — worse than stale, a *wrong* list that looks authoritative. Added a real client: `MARVINLogic/LSPMessageFraming` (the `Content-Length` wire codec, **pure**, 9 tests — a framing bug desynchronises the stream permanently and silently, and the recovery test caught a real one where skipping a bad header also swallowed the valid message behind it), `LSPClient` (handshake, full-text document sync, and the server→client requests `workspace/configuration` / `client/registerCapability` that a client MUST answer or a conforming server just stalls), `LSPService` (per-project routing, 150 ms debounce, three-strike crash budget, missing servers surfaced AS diagnostics rather than as silence). `MarvinBridge` now holds CLI and LSP diagnostics **separately** and merges on read, so a slow `tsc` finishing cannot erase what a server published two seconds ago. **Verified against a real `sourcekit-lsp`**: handshake completes and, after a `didChange` on an **unsaved** buffer, it published `error 1:15 — Cannot convert value of type 'String' to specified type 'Int'` while the file on disk still said `let ok: Int = 1`. That is the exact capability a CLI runner cannot have. **(2) Go to Symbol jumps to the line** — `SymbolSearchSheet` called `setSelectedFile`, opening the file at line 1 even though the graph node carried `source_location` and the row displayed it. **(3) Menu restructure + command registry.** Eleven app surfaces lived in **Window** because `CommandGroup(after: .windowList)` is the only built-in slot SwiftUI offers without declaring a menu; every editor files them under View/Go/Run. Rather than move `Button`s around, commands are now VALUES in `CommandRegistry`, and the menus, the new **⇧⌘P Command Palette** and the ⌘/ help sheet are three renderings of that one array. That makes the shortcut audit mechanical: it immediately surfaced two more collisions (⇧⌘P wanted by both the palette and the preview pane; `^\`` declared twice for the same action) on top of the ⌘G and ⇧⌘B pairs found earlier. **New commands:** Command Palette (⇧⌘P), Go to Line/Column (^G, accepts `120` or `120:8`), Next/Previous Problem (F8/⇧F8), Back/Forward editor navigation (^-/^⇧-, browser-style stack that truncates the forward half when you branch), Search / Source Control / Skills / Plugins pane reveals, Close All Editors, Copy Path of Active File, Copy App Diagnostics. **The help sheet is now DERIVED from the registry** instead of being a second hand-maintained list — which is what let it drift to five WebView-era bindings, ⌘K mislabelled, and ⌘G listed twice. **One bug only a screenshot could find:** `CommandMenu("View")` always creates a NEW top-level menu, and macOS auto-creates View for any app with a sidebar — so the menu bar read `File Edit View View Go Run Window Help` with the items split across two identically-named menus. `CommandGroup(after: .sidebar)` puts them in the system one. The user spotted it in the same screenshot. **Full parity matrix** — every item of Antigravity's nine menus, with status and what each gap actually needs — at [`docs/reference/ide-parity.md`](reference/ide-parity.md). The honest summary: the Run menu is entirely empty and needs a **DAP client** (own ADR); Go to Definition/References and quick fixes are now a UI question rather than an architecture one, since the LSP transport exists; multi-cursor, split editors and the editor text commands (move/duplicate line, toggle comment, expand selection) are the next self-contained tranche. **Verified:** `swift build` clean, 503 test assertions, installed and relaunched — 1 constraint storm, 0 fatals, single View menu confirmed by screenshot.


- **Problems panel: it was searching one directory, and "found nothing" rendered as "your code is clean" (2026-08-31).** User: *"diagnostics doesn't seem to be doing anything."* It wasn't. `DiagnosticsService.detectAndRun` checked the **repo root only**, for `tsconfig.json` / `Package.swift` / `.eslintrc*`. On `agri-saas-platform` the TypeScript project is at `apps/web/` with a **flat** `eslint.config.js` (the ESLint 9 default, absent from the legacy-name list) and the main app is Maven at `apps/api/` (unsupported entirely) — so it matched nothing, ran nothing, returned `[]`, and the panel drew the same clean checkmark it draws for a genuinely clean project. The button was never broken; the search was, and the empty state hid it. **Rewritten:** discovery is a bounded, ignore-aware BFS (depth 3, `node_modules`/`target`/`.git`/… pruned) returning one runner per sub-project, shallowest-claims-the-toolchain so a Maven reactor builds once rather than per module. Toolchains are values (`Toolchain.all`) not an if-chain: tsc, eslint (flat **and** legacy config names), biome, ruff, go vet, cargo, swift build, maven — with project-local wrappers (`./mvnw`, `./gradlew`) preferred over anything on PATH. **Fast vs slow** is now a real distinction: `tsc`/`eslint` run automatically on project switch, minute-scale builds (`mvn`, `cargo`, `swift build`, `go vet`) only when the user presses Run — the same split VS Code makes between a live language server and an on-demand build task. Runners execute concurrently. **Also fixed while in there:** `Shell.run` slept until its deadline and only *then* drained the pipes, so any tool emitting more than the 64 KB pipe buffer deadlocked writing into a pipe nobody was reading and got killed with truncated output (`tsc` on a large project clears 64 KB easily) — it now reads concurrently via `readabilityHandler`; the subprocess `PATH` is enriched, because a Finder-launched app inherits the bare launchd `PATH` and can't see Homebrew or node tooling; and results are deduped (tsc and eslint both report the same unused import) and sorted errors-first. **Panel rebuilt to VS Code's shape:** grouped by file with per-file counts and collapse, severity chips that double as filters, a text filter over message/path/tool, a source chip per row, copy-one / copy-as-`file:line:col` / copy-all, and **three distinct empty states** — never-run, no-toolchain-found (naming what it looked for), and genuinely-clean (naming the tools and the time). Collapsing those three into one checkmark is the thing that let this hide. Rows now jump to **file:line:col** via the existing `openFileFromChat` path; they used to call `setSelectedFile`, which opens the file at the top — on a 2,000-line file with an error at line 1,840 that is indistinguishable from the click doing nothing. **Verified:** discovery run against both real repos — `maven→apps/api, tsc→apps/web, eslint→apps/web` on agri, `tsc→., biome→., swift build→macos` on MARVIN; every parser checked against real `tsc` and `swiftc` output plus representative Maven/ESLint output (paths absolutised, line/col, severity mapping, `[INFO]` ignored, ESLint's `(rule)` suffix stripped, dedupe); live in the running app, which now reports *"Last run 11:20:18 — maven, tsc, eslint."* **Still missing vs VS Code / Cursor / Antigravity, and all the same gap:** editor squiggles, gutter markers, quick fixes, and live push per keystroke. Those panels are passive renderers over a diagnostics collection that **language servers** push into (`textDocument/publishDiagnostics`); MARVIN shells out to CLIs and parses stdout, so its list is only as fresh as the last run and can never carry a code action. A real LSP client is the fix and needs its own ADR — deliberately not smuggled in here.


- **Noticed while in flight, not in scope:** `Go to Symbol…` (⌘T) has the same jump-to-line defect the Problems rows just lost — `SymbolSearchSheet` calls `setSelectedFile`, so picking a symbol opens its file at line 1 even though the graph node carries `source_location`. One-line fix using the same `openFileFromChat` path; not landed without asking.


- **Source control reaches parity with the reference IDE — and the roadmap gets corrected (2026-08-31).** User, with side-by-side screenshots of Antigravity: *"We are missing a lot of features in source control … if I click the repo/branch name I get create/switch branches. Marvin doesn't do anything."* **Correction first:** the "third pass" claim in the Antigravity-redesign entry below — composer on top, collapsible sections with count pills, VS Code row layout, a Graph section backed by a new `GitHistoryService.repoHistory` — **never landed**. `git log` on `SourceControlView.swift` shows its last touch was a 6-line divider swap in `f122e84d`; `rg repoHistory` across `macos/` returns nothing. The panel on disk was still the porcelain-badge, bottom-composer version. That entry is left in place as written (it is the history) with this note as its correction. **The dead-route finding:** `/api/git/branch` (list), `/branch/create`, `/branch/switch` and `/branch/delete` shipped with ADR-0012 M2 and had **zero** Swift callers — the branch name was a `Text` in both the panel and the status bar, so the feature was complete, tested, documented, and unreachable from the running app. That is what "clicking does nothing" was. **Now built.** *Backend:* `/api/git/graph` (commits + parents + `%D` decorations, `--topo-order --all`), `/api/git/stash` (list + push/pop/apply/drop), `/api/git/repos` (main worktree + every linked worktree via `git worktree list --porcelain`, so an ADR-0081 implementer's checkout is visible), `/api/git/commit-message` (drafts from the staged diff); `discard` gains `mode:"untracked"` (`git clean -f -d`), `branch/switch` gains `detach`, `push` gains `setUpstream`, `/api/git/branch` gains per-ref last-commit metadata + tags + `sort=-committerdate`, `/api/files/status` gains `upstream`/`ahead`/`behind` on the poll that already ran. *macOS:* `GitRefPicker.swift` — the searchable branch/tag quick-pick (Create new branch…, Create new branch from…, Checkout detached…, rows with ahead/behind + `author · sha · subject`), opened from the status-bar branch name **and** the panel's branch chip; `GitGraphView.swift` — a real DAG with lane assignment, merge curves and ref chips (the deferred "real DAG layout for the Graph section" from the ninth pass); `GitOpRunner.swift` — one confirm-token round-trip shared by the panel, the picker and the status bar; `SourceControlView.swift` rebuilt (composer on top with a branch-aware placeholder + **Generate**, one primary button that is Commit / Sync Changes N↓ M↑ / Publish Branch depending on state, a split menu for Commit & Push / & Sync / Amend / Stage All & Commit, collapsible sections with count pills, `icon · filename · dimmed dir · status letter` rows, hover actions, a `…` overflow with the full command set, stash and worktree sections); status bar gains a clickable branch with a `*` dirty marker and a sync control showing the counts. Policy amendment in [ADR-0012](decisions/0012-source-control-mutation-channel.md) — stash and the graph view move off its "out of scope entirely (v2+)" list; hunk staging and rebase/merge UI stay off. **Two silent failures the smoke tests caught**, both HTTP 200 and wrong underneath: `parseGitOp` in `/api/git/confirm` re-parses the op rather than trusting it (which is what stops mint-harmless/replay-dangerous), so a field missing there *declassifies* the op — `detach` was missing, the mint answered `policy-auto`, and the confirm round trip could never complete; and git's format placeholders are per-command dialects — `for-each-ref` reads `%00` as NUL, `--pretty=format:` does not, so `stash list` returned entries whose every field parsed as an empty string. **Cost:** the Generate button runs on the cheapest tier (`fallbackNewestOfTier("haiku")`), measured at **$0.036** vs **$0.22** for the same sentence on the session's Opus, and spawns with `allowedTools: []` — `runClaudeCli` always passes `--dangerously-skip-permissions`, so an unrestricted spawn behind a "write me a sentence" button is a real capability, not a theoretical one. **Verified:** `swift build` clean; sidecar `tsc` clean; biome clean; 61 git-package tests (9 new policy tests); every new read route smoke-tested against this repo; stash/switch/detach/clean/publish and a full confirm-token round trip exercised against a throwaway repo (the destructive ones never ran against `~/marvin`); the lane layout checked against 300 real commits (12 merges, max lane 8) for per-row invariants. **Not yet seen running** — needs `bin/marvin install-macos-app --bundled` and a relaunch, which would replace the user's live IDE, so it is theirs to trigger.

_Active work. Add a one-line entry when a piece of work starts; move it out (to CHANGELOG, with the date) when it lands._


- **2026-07-03 — frontend catches up to the backend: real panes, backlog details, plans panel, activity surface.** The frontend-vs-backend audit found stale controls and model-only backend state. Fixed in five commits: the files/graph/brain pane toggles now actually gate their panes and a NEW `GraphPaneView` renders graphify's interactive graph.html natively via `/api/graph/html` (⌘G finally does something; hiding the brain stops its Metal loop); File ▸ New Session (⌘⇧N) is wired instead of a disabled placeholder; backlog items open into a detail sheet (editable body, severity picker, resolve-with-note — new id-keyed `updateBacklogItem` + extended `PATCH /api/backlog`); a Plans panel lists every session plan with full step statuses (set-active / open file / continue / remove, new `removePlan`); and NEW `GET/DELETE /api/wakeups` + `/api/background-jobs` routes feed a status-bar Activity popover (running jobs + scheduled wakeups with cancel, plus the first consumer of the auto-audit tail). Direction set: the web UI is not a MARVIN frontend — native app only, browser tech only for embedded viewers (preview pane, graph pane).
- **2026-07-02 — audit truth pass: tests green again, memory gate-enforced, plan logic test-pinned.** A claimed-vs-implemented audit (six parallel auditors + live test runs) found the vitest suite red (17 stale-test failures, invisible because CI never ran tests), two roadmap-claimed plan-logic tests that never existed, and memory's "enforced write path" being prompt-only. Fixed: stale suites unbroken (442/442 green + new `.github/workflows/test.yml` CI); plan model types moved into `MARVINLogic` so `MARVINTests` pins reconcile + the completion invariant (105 assertions, was 88); `.marvin/memory` writes gate-denied like `.marvin/plans/` ([ADR-0042](./decisions/0042-memory-as-durable-facts.md) enforcement addendum); stale strings/comments corrected; this roadmap's fossilised "In flight" section cleared.
- **2026-07-02 — durable plan spine + plan-file ownership + re-base guard** ([ADR-0052](./decisions/0052-durable-plan-spine-and-plan-file-ownership.md), development). A day-long production session exposed four plan-tracking failures: agent-mode plans never entered the spine (the model Write-tool'ed an untracked plan file), a chat switch/relaunch dropped plans older than the 200-event hydration tail (strip degraded to a bare task list, plan file froze), re-based `[1..K]` TodoWrite tags overwrote unrelated step statuses, and replay/live adoption disagreed. Fixes: `# Plan` replies adopted in every mode (approval chip stays plan-mode-only); the spine persists server-side per session (`/api/sessions/plans`, authoritative on hydrate); the gate denies model writes under `.marvin/plans/` with a steering reason + `personality.ts` firm surface; `PlanRebaseGuard` (MARVINLogic, test-covered) distrusts foreign-looking tag batches so they nest instead of corrupt. `swift build` + `swift run MARVINTests` (88 assertions) + runtime vitest green.

- **2026-07-02 — Phase 6/7 remediation contract: bounded self-fix, gated scope-fix.** `personality.ts` prompt-only change closing the "verify, then what?" gap. Phase 6: mechanical verification failures (typecheck/tests/build) now MUST self-remediate without asking — capped at 3 attempts per milestone with an early no-progress stop (identical errors twice = spinning → stop), then an honest failure report; MUST NOT claim landed, weaken the DoD, or skip the check. Phase 7: unmet DoD bullets get surface-and-offer — state the gap + the one concrete next step, then gate ("one gap, one gate"); MUST NOT loop back into Phase 6 unprompted. A fully autonomous retry-until-DoD mode was considered and deliberately not built (it institutionalizes the Golden Rule 8 "helpful spiral"); revisit only as an explicit opt-in with its own ADR, cost budget, and progress metric.
- **2026-06-23 — plan file mirrors live progress** ([ADR-0046](./decisions/0046-plan-as-durable-spine.md) follow-up). The saved plan at `.marvin/plans/<slug>.md` is now a live projection of the plan text + step status (`PlanFile.render`): completed steps get a `[x]` checkbox overlaid on their original line (numbering/prose preserved), discovered sub-tasks nest beneath their step, and the "Additional work" bucket is appended. `applyTodoWrite` re-persists on every reconcile (`open: false`), so checkmarks + additions reach the file — previously only the chat strip showed them.
- **2026-06-22 — v0.1.43 full session history via incremental paging** ([ADR-0048](./decisions/0048-full-session-history-tail-first.md)). Cold-start restore was tail-capped to 200 `cli.event` lines with no signal it clipped; the server now reports `truncated`/`totalTurns` and the client pages older lines in on demand (next 200 / full log) with an "N of M" count — fast first paint, full history always reachable.
- **2026-06-22 — v0.1.42 plan persistence + review-window + backlog capture-at-discovery.** Plan now survives chat switches/relaunch ([ADR-0046](./decisions/0046-plan-as-durable-spine.md) follow-up — `replay` rebuilds it from the transcript); the review window renders added/deleted files single-column + virtualises the diff + gates large diffs ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) bugfix); and the backlog auto-captures "noticed in flight" items as `provisional` the instant they're seen, reviewed keep/dismiss at the handoff ([ADR-0047](./decisions/0047-backlog-capture-at-discovery.md)).
- **2026-06-22 — plan as the durable spine: reconcile, don't clobber** ([ADR-0046](./decisions/0046-plan-as-durable-spine.md), revises [ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Fixed two plan-tracking bugs: a mid-plan `TodoWrite` wholesale-replaced the checklist (sub-tasks erased the plan + fired a false "Plan complete"), and a second plan overwrote the single plan slot (the original became untrackable). The active plan now owns hierarchical `PlanStep`s; incoming `TodoWrite`s **reconcile** into them (match → update, unmatched → nested sub-task) via `PlanProgress`; completion is computed over top-level steps only; plans live in a session list (`plans` + `activePlanId`, revision-aware by slug) with a strip picker so prior plans stay navigable. `personality.ts` + the approve instruction now require a full carry-forward `TodoWrite`.
- **2026-06-14 — v0.1.32 memory as a curated durable-facts layer** ([ADR-0042](./decisions/0042-memory-as-durable-facts.md)). `.marvin/memory.md` had bloated to 419 KB / ~99% redundant with ADRs/git/changelog. New `marvin-memory` MCP (`remember`/`recall`) is the enforced write path (file-per-fact + one-line index, caps + content-class guards); `personality.ts` firm surface; `buildProjectContext` injects the index; `/memory-compact` migration; native Scope-met chip retargeted to `session-notes.md`.
- **2026-06-14 — v0.1.31 project-graph lifecycle + context budget** ([ADR-0041](./decisions/0041-project-graph-lifecycle-and-context-budget.md)). Fixed "Prompt is too long": `buildProjectContext` injected all ADRs + full memory (~566K tok vs 200K). Now MARVIN auto-builds the active project's code+knowledge graphs (cwd-scoped, free) and the first-message context is budgeted — ADR titles index + memory tail + whole curated docs (~13.4K tok measured).
- **2026-06-14 — v0.1.30 interactive AskUserQuestion** ([ADR-0040](./decisions/0040-interactive-ask-user-question.md)). The model's built-in `AskUserQuestion` tool (surfaced via `canUseTool`, answered via `{behavior:"allow", updatedInput:{questions,answers}}`) now routes through MARVIN's confirm channel in every mode; a native `AskQuestionSheet` renders the options as clickable buttons (single/multi + "Other") and returns the pick as the tool result. The prose `PlanDecision` chip stays as a fallback. CI actions bumped to Node-24 majors (#105).
- **2026-06-13 — v0.1.29 no approve chip on a completed plan** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). A finished plan showed both "Plan complete 10/10" and "Approve & execute". The tray gates the approve chip on `!planComplete` and `turnCompleted` clears `planAwaitingApproval` once the plan's todos are all complete.
- **2026-06-13 — v0.1.28 plan title/file robust to preamble + Homebrew "damaged" fix** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). `PlanCard.split` divides an assistant reply into (preamble, plan) at the first `# Plan` heading — the saved file slug + tier-2 strip header use the clean plan portion (no more `i-have-the-root-cause-nailed-….md`), the chat renders preamble-as-prose + plan-as-card, and `planTitle` scans for the heading anywhere. The `marvin-ai` cask gained a `postflight` that strips `com.apple.quarantine` (modern Homebrew quarantines casks by default → ad-hoc bundle reads as "damaged" on macOS 26).
- **2026-06-13 — v0.1.27 two-tier to-do / plan + plan file in the editor** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) two-tier addendum). The plan card (in the chat scroll) and the to-do strip (above the input) read as two artifacts replacing each other; Cursor keeps two distinct tiers that coexist. `TodoListStrip` now forks on `planTitle != nil`: a neutral blue "Task list" for bare `TodoWrite` checklists, a purple titled "Plan — <title>" for plan-backed execution that ticks off in place. A presented plan is auto-written to `<workDir>/.marvin/plans/<slug>.md` and opened in the editor pane (`persistAndOpenPlan` → `setSelectedFile`) with an "Open plan" button. `personality.ts` updated to the inline-`# Plan`/stop contract (stale `ExitPlanMode` wording removed) + a tier-1 task-list trigger for 3+ step Agent work.
- **2026-06-12 — v0.1.26 plan card (Cursor-style structured plan rendering)** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) rev). The decoupled Plan mode had left the plan as a plain-text assistant bubble. The plan-mode prompt now mandates the reply open with `# Plan — <title>`; `ChatMessageRow` detects that heading and renders the message as a collapsible `PlanCardView` (title, step count, line-styled markdown: headings / numbered steps / bullets / code fences) — content-shaped detection, so it also fires on transcript replay. Approving the plan seeds the To-dos strip from the plan's steps so execution starts tracked.
- **2026-06-11 — v0.1.25 Plan-mode UX polish** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Session-scoped plan/changes strips; Approve/Continue as hidden control actions (no fake user message); Save plan to a Markdown file; collapse/dismiss + auto-collapse the checklist; relabel "Plan" → "To-dos" (the task tracker; the plan is a distinct inline message + file).
- **2026-06-11 — v0.1.24 Plan mode decoupled + strip tray** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md) rev). Plan mode is a read-only planning turn on the chosen advisor model that presents the plan inline (no modal); an "Approve & execute" chip runs it in a separate Agent turn on the executor — role-routed models, no re-planning. The chat's contextual strips moved into one opaque divider-separated tray so they no longer overlap the message log.
- **2026-06-11 — v0.1.23 background jobs + fetch skills + plan follow-through** ([ADR-0038](./decisions/0038-background-jobs-event-wakeups.md), [ADR-0039](./decisions/0039-fetch-skills-from-git.md)). `run_background_job` fires a real follow-up turn on process exit (event-based wakeup); shell backgrounding denied at the gate. "Add from GitHub" fetches skills from a repo / sub-path / plugin marketplace. Plan mode: the plan persists in the chat + seeds the tracked to-do checklist; prompt requires live `TodoWrite` updates. Skills pane reorganised by state (active / available / recommended).
- **2026-06-11 — v0.1.22 modes + Cursor-style chat surface + skill enablement** ([ADR-0036](./decisions/0036-ask-agent-plan-modes.md), [ADR-0037](./decisions/0037-skill-enablement-active-set.md)). Ask/Agent/Plan modes (Ask read-only at the gate; Plan = SDK plan mode + an `ExitPlanMode` approval card; Agent unchanged) + a live `TodoWrite` checklist. Mode/reasoning controls relocated into the input box (`ChatModeToolbar`); open/close chat tabs persisted per project. Per-project skill enablement: a core/domain catalog + fingerprint-defaulted active set, named in the system prompt so MARVIN ignores irrelevant installed skills (20→7 here); Skills-pane toggles + `.marvin/skills.json`.
- **2026-06-10 — v0.1.21 diff-gutter accuracy + commit clears the review** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) update). `DiffGutterBar` now positions change markers from STTextView's real layout fragments (cached) instead of a font-metric line-height guess that drifted on scroll, and is `isFlipped`. `reconcileCommitted` (on `GET /api/changes`) auto-accepts reviewed files now clean vs HEAD, so committing clears them — drops only, never rewrites a baseline. 15/15 checkpoint tests.
- **2026-06-10 — v0.1.20 change review as a real diff editor** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md) update). The review surface moved off a pane-clamped `.sheet` into its own large resizable `Window` with a side-by-side (original | modified) diff, line numbers, and a Split/Inline toggle — the VS Code / Cursor diff-editor layout. Cross-window strip refresh via `.marvinAgentChangesDidMutate`; checkpoint semantics unchanged.
- **2026-06-10 — v0.1.17–v0.1.19 per-role effort + agent change review + port ownership** ([ADR-0033](./decisions/0033-advisor-registered-agent-per-role-effort.md), [ADR-0034](./decisions/0034-agent-change-review-checkpoints.md), [ADR-0035](./decisions/0035-bundled-app-owns-its-port.md)). Advisor is a registered agent with its own model + effort (`adv` chip, "follow executor" default; SDK `advisorModel` Option found unwired). Cursor-style change review: gate-captured pre-image checkpoints, `/api/changes` family, live "N files changed" strip + per-hunk accept/reject sheet (E2E-verified). v0.1.19 closes the stale-sidecar-adoption bug that had masked two releases: the bundled app reclaims `:3030` before spawning and `/api/health` reports the serving process's `version`.
- **2026-06-04 — v0.1.14–v0.1.16 self-scheduled wakeups** ([ADR-0031](./decisions/0031-self-scheduled-wakeups.md), [ADR-0032](./decisions/0032-deny-background-bash.md)). `schedule_wakeup` / `cancel_wakeup` / `list_wakeups` (`marvin-control` MCP) + bounded persistent scheduler; fired wakeups start real turns via the shared `runDetachedTurn` orchestrator. v0.1.15 hard-denies Bash `run_in_background` at the gate. v0.1.16 fixes the standalone module-isolation bug (globalThis singleton + request-path handler wiring) that made fired wakeups evaporate without a turn.
- **2026-05-21 — multi-graph architecture: code + knowledge** ([ADR-0028](./decisions/0028-multi-graph-architecture.md), `2702dd1`). Two graphs per project — `graphify-out/graph.json` (code) and `graphify-out/knowledge/graph.json` (docs / ADRs / memory, `bin/marvin knowledge-graph`, AST-only). All six MCP graph tools accept `scope: "code" | "knowledge" | "all"`, default `"code"`. Cross-graph joins, tool-history graph, semantic doc extraction deferred per the ADR.
- **2026-05-21 — macOS 26 Gatekeeper fix: install to `~/Applications`** ([ADR-0027](./decisions/0027-macos-26-gatekeeper-user-applications.md), `2dfd8df`). macOS 26 kernel-kills ad-hoc-signed bundles in `/Applications`; `bin/marvin install-macos-app` and the Homebrew cask retarget to `~/Applications/MARVIN.app`, uninstall cleans the legacy path, README + cask `caveats` document the one-time "Open Anyway" click-through.
- **2026-05-20 — syntax-highlighter coverage: YAML, Markdown, Python** (`fa1b9d5`, `392c825`, `2a6d262`). All three grammars vendored under `macos/Vendored/` (upstream SPM blockers documented in `macos/Package.swift`) with `Resources/Queries/*.scm` — the wired language set is now swift, typescript, go, rust, json, html, c, cpp, bash, yaml, markdown, python.
- **2026-05-20 — terminal ANSI colour passthrough** (`e45c704`). `stripANSI` replaced by `ANSIParser` — CSI SGR sequences map to attributed-string colours, so `cargo` / `pnpm` / `pytest` / `make` output is legible in the terminal pane.
- **2026-05-20 — v0.1.6 Homebrew cask + scrub.** Brew tap `RobertIlisei/marvin` with cask token `marvin-ai` (avoids collision with the unrelated "Amazing Marvin" cask). Vertical-specific recommendation rules removed (PR #81); domain-agnostic skill recommendations only. Personal-path scrub across docs.
- **2026-05-13 — Project-aware skill recommendations** ([ADR-0024](./decisions/0024-project-aware-skill-recommendations.md), [ADR-0025](./decisions/0025-skills-pane-ui.md)). Fingerprint detector at `sidecar/packages/project-context/src/fingerprint.ts` emits namespaced tags (~98 as of 2026-07: framework/integration/build/language/ui …); 25 hand-curated rules in `sidecar/packages/runtime/src/suggestion-rules.ts` map tags → install/build verbs. Skills pane is the 4th tab in `LeftPane.swift`.
- **2026-05-10 — Bundled sidecar + brew-distributable** ([ADR-0023](./decisions/0023-brew-distributable-bundled-sidecar.md)). Sidecar now lives inside `MARVIN.app/Contents/Resources/` (Node 22.11.0 darwin-arm64 + Next standalone tree) and is spawned by the Swift process on launch. The launchd user agent path is opt-in via `bin/marvin install-macos-app --launchd`. Sidecar log path becomes `~/Library/Logs/MARVIN/sidecar.log`.
- **2026-05-05 — Fully-native IDE surface milestone** ([ADR-0021](./decisions/0021-webview-removal-fully-native-swift.md)). WebView removed end-to-end; native SwiftUI replaces every web-rendered panel. 8 sub-milestones: WebView removal, MRU file picker, Find in Files (ripgrep), Symbol Search (graph-backed), diff gutter, file history, build task palette, diagnostics panel + clickable status badge.
- **2026-05-04 — Phase ADRs 0017–0020** lay out the sub-phases that the native-IDE milestone collapsed.
- **2026-04-26 — Audit-driven hardening pass.** Closed every 🔴 finding from the full audit. Permission gate load-bearing in `auto` mode, `BASH_HARD_DENY` plugged ([ADR-0015](./decisions/0015-auto-mode-policy-floor-and-audit-log.md)), confirm-prompt redesign, Honeycomb env race fix, `/api/chat` cwd validation, TopBar collapse.
- **2026-04-21 — install-app + scout subagents.** `bin/marvin install-macos-app` ([ADR-0016](./decisions/0016-swift-migration.md) replaces the original Tauri wrapper from [ADR-0010](./decisions/0010-desktop-wrapper-tauri.md)). Read-only scout subagents ([ADR-0014](./decisions/0014-scout-subagents-read-only.md)).
- **2026-04-17 — initial ship.** Phases 1–4: chat surface, file tree, terminal, diff viewer, project picker, cost tracker, personality toggle, graph panel.

`

### Earlier still — pre-v0.1.94

_Older shipped entries, kept for their diagnostic trail. When new work lands, add
an entry under **Recent milestones** with the cask, tag and ADR if any._

- **Editor AI smart actions + IDE gap analysis** — right-click a selection in the file viewer for **Explain this code · Review & improve · Generate docstring · Add selection to chat**. Each anchors the prompt to `file:line` so the reply's citations are clickable, appends to the native context menu rather than replacing it (Cut/Copy/Paste survive), and falls back to the whole file when nothing is selected. `review` and `docstring` are read-only-first: a context-menu click carries no confirmation step, so they propose and wait. Companion research at [`docs/reference/ide-feature-gap-2026-08.md`](reference/ide-feature-gap-2026-08.md) — MARVIN already matches Cursor/VS Code on the *hard* parts (agent, multi-file review, codebase context, MCP); the gaps are concentrated in editor-level interaction. Next up there: AI commit message, fix-from-diagnostic, inline edit (⌘K). Deliberate non-goals recorded too — ghost-text Tab completion needs a second fast model provider off the Agent SDK hot path, which cuts against the local-first trust model.

- **Obsidian vault — the project directory IS the vault ([ADR-0065](decisions/0065-obsidian-vault-project-as-vault.md))** — measuring first changed the answer: one real project already held **819 markdown files MARVIN wrote** (79 memory facts, 437 backlog items, 303 plans), all with frontmatter Obsidian reads as properties. A vault is just a folder with `.obsidian/`, so content and container both existed. The actual gap was **links** — all 79 memory files had *zero* `[[wikilinks]]`, so the graph view would have shown 819 disconnected dots. Markdown links render in Obsidian but create no graph edges, which is why the index would have *looked* connected while the graph stayed empty. Both indexes now emit wikilinks; `obsidian_init` writes `.obsidian/` + a `MARVIN.md` front door and exports the code graph as notes. Opt-in and non-destructive: never created unasked, an existing vault's settings are merged not clobbered, a corrupt `app.json` is left alone, and MARVIN edits nothing outside `.marvin/`, `MARVIN.md` and `graphify-out/`. Phase 2 (MARVIN reading your own notes as context) deliberately unbuilt — it hits the ADR-0041 context budget and needs a consent model.

### Previously — v0.1.65

**v0.1.65** — The SDK catches up, and two things that only *looked* broken.
**Agent SDK 0.2.113 → 0.3.245 ([ADR-0073](decisions/0073-agent-sdk-0-3-upgrade.md)):**
found while chasing a plan bug — the official docs say `TodoWrite` is
deprecated and **absent by default on Sonnet 5 / Opus 4.8+** from 0.3.142, and
MARVIN was behind the end of its own 0.2 line, on a version predating the
deprecation notice. Every 0.3 default that would change behaviour is pinned
back with its reason: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` + `CLAUDE_CODE_ENABLE_TASKS=0`
keep the plan spine's snapshot tool; `alwaysLoad: true` on all five in-process
MCP servers, because 0.3 **defers MCP tools behind ToolSearch** and the
graphify-first hooks would deadlock a turn whose prompt has no `graph_*` tools.
Checked, not assumed — both `env:` sites already spread `process.env`, the
subagent wire name is still `Task`, and `graphify-bridge` was quietly pinning
its own `^0.2.113` (two SDK copies in one process). Verified with a live
`system/init` on Sonnet 5. The Task-id migration that retires the ADR-0068 bug
class is deliberately its own ADR.
**"I lost all my sessions" ([ADR-0072](decisions/0072-session-list-must-not-parse-transcripts.md)):**
nothing was lost. `GET /api/sessions` `JSON.parse`d all 347 transcripts
(2.6 GB) per request — **23 s** — and the native client cancelled and
restarted that fetch on every SwiftUI rebuild (measured 8× per launch), so it
never completed; hydration waited on it, so the open chat rendered blank while
its transcript loaded in 96 ms. Scan + `(mtime, size)` cache: **36 ms**.
Hydration no longer depends on the list; `refreshSessions` coalesces as its
comment always claimed.
**"MARVIN is skipping plan steps" ([ADR-0068](decisions/0068-plan-dedupe-provenance-and-negative-claims.md) addendum 4):**
the plan it tracked wasn't the plan on screen — a 10-step plan with a
`Sources:` bibliography was tracked as **16 steps, one URL `in_progress`**,
because the parser had no notion of where the list ends; the file held three
contradictory copies of its step list from a render→echo→ingest loop. Parser
stops at a reference heading and drops link-only bullets; render fuzzy-matches
before appending; redrive drops citations instead of nesting them.
**Also:** skills and plugins can be **updated** ([ADR-0071](decisions/0071-install-provenance-and-update-path.md)
— provenance recorded at install, content-hash "newer?", cache GC, Set-source
backfill); pane actions moved out of the window toolbar (both panes' toolbars
were rendering at once, six unlabelled icons) into in-pane rows with tooltips
that say *why* a button is disabled; the ADR index, stuck at 0030, is
backfilled through 0073.

**v0.1.64** — Things MARVIN installs can now be updated, and two promises it
could not keep. **Install provenance (ADR-0071):** MARVIN could install a skill
or a plugin but never pull a newer version of either — and the blocker was not
a missing button. `registerInstalledPlugin` recorded `installPath`/`version`/
`lastUpdated` and **no clone URL**; skills recorded **nothing at all**. Nothing
on disk knew where anything came from, so an updater had no source to
re-clone. (`install-skills.sh` compounds it: it *skips* anything already
present, so a skill installed once stays at that version forever.) Every
install now records its origin — `.marvin-source.json` inside the skill folder,
and a MARVIN-owned sidecar registry for plugins, deliberately **not** a new key
in the co-owned `installed_plugins.json` the Claude Code `/plugin` UI also
writes. "Is upstream newer?" is a **content hash**, not a version string:
skills have no version field, and plugins routinely ship changes without
bumping theirs. Identity is name **AND** repo-relative path, because by name
alone an upstream rename and an upstream deletion are indistinguishable — a
test caught the first implementation installing a *different* skill over the
user's when upstream deleted theirs. Two CSRF-guarded routes with
check/single/bulk modes, Check-for-updates + per-row Update in both panes, and
a one-time "Set source" for the backfill (there is nothing to migrate *from*).
Superseded plugin cache versions are finally pruned.
**Two ADR-0055 escapes closed**, both from one 4.5-hour miss: a background job
finished at 17:17, MARVIN had said *"I'll act on its real completion output"*,
and the user chased it at 22:02. The backstop saw nothing — the sentence's cue
was the event noun (*completion*), not a temporal `when`/`once`, and `act` was
not a follow-through verb. Separately, a **past-tense claim of coverage**
("…and scheduled a check in ~2 minutes") was entirely unmatched, because every
prior pattern requires a future-tense "I'll" — and it was false, because MARVIN
had called `ScheduleWakeup`, the *harness's* `/loop` tool, which schedules
nothing inside an SDK session. It reads as the obvious choice; MARVIN's own
tool is the snake_case `schedule_wakeup`. Worse, the coverage check tests
`name.includes("schedule_wakeup")` — false for `ScheduleWakeup` — so the
promise looked uncovered *and* armed nothing. The tool is now off the surface
entirely: one that silently no-ops a safety-critical promise must not be
reachable. **Also:** Claude Code's concise output style now ships in the ultron
voice (MARVIN runs the SDK in isolation mode, so `outputStyle` in
`~/.claude/settings.json` is never read and there is no `/config` to set it
from), and graphify moved 0.9.43 → 0.9.48 with both graphs rebuilt, re-labelled
(57 of 363 community labels had degraded to filenames) and their stamps
corrected — including one CLAUDE.md claim that was simply wrong.

**v0.1.63** — The session where MARVIN was measured instead of guessed at. Six
ADRs, and every one started from a number rather than a hunch.
**Three days became a diagnosis (ADR-0067):** a 49-hour session was 15.9 h of
work and **33.1 h waiting on the user — only ~10 % of it legitimate**. 17.8 h
(65 turns) was MARVIN ending mid-plan having asked nothing; 6.7 h (20 turns)
was asking permission the approved plan already granted; 5.1 h was dying on a
transport error and staying dead. The user had typed a "Resume the ACTIVE plan"
macro **8 times** to restart a stalled system. Phase 7 now gates on the **scope
boundary, not the turn boundary** — an approved plan is standing authorization —
transport errors auto-continue through the ADR-0031 wakeup rails, and
`scripts/session-time-breakdown.py` makes the whole thing re-measurable.
**Graphify at full surface (ADR-0066):** the bridge used ~a quarter of 0.9.43.
`graph_neighbors` was documented as blast radius but the graph is built
undirected — proven by finding the same `calls` relation in *opposite*
orientations for two known caller/callee pairs — so `graph_affected` reads the
AST call cache instead (433k directed edges on a real project, 5 ms per
refreshed turn after incremental ingest took it from 3.0 s / 127 MB to 36 MB).
`graph_save_result` finally carries an `outcome` and `graph_reflect` learns from
it; both graphs' communities are named; the token-reduction claim is **measured
at 27.5×**, replacing a long-quoted "~36×" that never was.
**Plans stopped lying (ADR-0068).** MARVIN reported a real plan "never was" a
tracked plan and called genuine merged commits "fabricated" — the user was one
step from discarding them. The suspicion was earned (347 bullets, 24 duplicated,
7 both checked *and* unchecked) but the conclusion was not: a failed search is a
fact about the search. Now the injected block carries `id` + `source:` path,
`sameWork` stops duplicating on rewording, existing plans self-heal, completed
sub-tasks collapse (**9,173 → 4,073 tokens per turn**), step counting stopped
promoting nested bullets (**66 "steps" in a 6-step file**), and plan files carry
a freshness date so three-week-old work stops being called "in-flight".
**User messages are no longer dropped (ADR-0069):** a wakeup held the single
turn slot, the user's message got a 409, and it never ran — confirmed absent
from all 150 `turn.user` records. Messages now persist to disk *before* any
scheduling decision, machine turns yield to humans when they haven't written
anything yet, and self-initiated turns are rate-limited.
**The backlog stopped growing faster than it shrinks (ADR-0070):** sessions
adding 6 and resolving 0. Capture now needs all three of actionable /
out-of-scope / worth-rediscovering, and a near-identical restatement is refused
at the tool boundary rather than annotated after the fact.
**The layout crash is finally instrumented (ADR-0062 addenda).** The hook had
never fired in **24 sessions** — it swizzled the instance method
`reportException:` while AppKit's layout path calls the class method
`+_crashOnException:`. Now armed, it produced the first capture in 11 days and
named `NSSplitViewController.loadView` running *inside* a 150-invalidation
burst. Attempt four at the root cause ships with its own falsifiable metric.
**Root cause still OPEN.**

**v0.1.62** — Graphify at full surface, and two tools that were quietly lying.
An audit of what MARVIN's bridge actually *calls* found it using about a quarter
of graphify 0.9.43 — and two of the gaps weren't cosmetic. **MARVIN could not
answer a blast-radius question and didn't know it.** `graph_neighbors` was
documented as "1-hop blast radius" and rendered `→`/`←` arrows, but `graph.json`
is built `directed: false`, so orientation in `links` is networkx
adjacency-iteration order — proven by finding the same `calls` relation in
*opposite* orientations for two known caller/callee pairs. graphify's own
`affected` reverse-traverses that graph and inherits the defect; `--directed`
turned out not to be a build flag at all in 0.9.43 (it exists only on `diagnose
multigraph`, as a simulation toggle — passing it to the pipeline exits 0 and
changes nothing). The directed truth lives in the per-file extraction cache's
`raw_calls`. New **`graph_affected`** (ADR-0066) reads it: real callers with
exact file and line, verified against ground truth on both TypeScript and Java.
It is honest where it is weak — the callee side is a bare *name*, so `assertThat`
(21,214 sites on a real project) returns an ambiguity warning rather than a blast
radius, "no callers" is explicitly not "dead code", and stale sites from a former
repo layout are filtered by existence check. **The work-memory loop saved
answers and learned nothing:** `save-result --outcome` had existed since 0.9.x
and MARVIN never sent it, and `reflect` had never run anywhere — 3 saved Q&As,
zero outcomes, no `reflections/`. `graph_save_result` now carries
`outcome`/`correction` (a `corrected` with no correction is rejected at the write
boundary, as with `remember` and `backlog_add`) and **`graph_reflect`** aggregates
them into a lessons doc. **Communities are named** on both graphs via the
`claude-cli` backend — no API key, which this machine doesn't have — and
`summarizeGraph`, which had never read `community_name`, now surfaces them, so
orientation reads "Git Write Policy Gate" instead of `[12] 58 nodes`. Scale work
came from measuring on a real Java monorepo rather than MARVIN's own small repo:
433k call edges cost 3.0 s and 127 MB there, which the per-turn watchdog would
have re-paid every turn — incremental ingest (the cache is content-addressed, so
entries only ever appear) plus string interning and single-project retention took
that to **5 ms and 36 MB**. And ADR-0060's open follow-up is **half-answered with
a number**: `graphify benchmark` puts the graph at **27.5×** fewer tokens per
query on this repo, 24.1× on the user's — the long-quoted "~36×" was never
measured. Two capabilities declined on principle: the cross-repo `global` graph
(merges projects — Golden Rule 4) and `check-update` (semantic-only; the
watchdog is AST-only and already gates on HEAD).

**v0.1.61** — Stability, and a backlog that reviews itself. **Four app-killing
crashes closed.** The file tree left SwiftUI's `OutlineGroup` entirely
(ADR-0061): four separate fixes each shut one way for its outline coordinator to
disagree with AppKit's row entries, and the fourth crash was *caused* by the
third — so the tree now flattens to a plain row list and the class is
structurally gone, with the model moved to MARVINLogic so its invariants are
unit-pinned instead of verified by waiting to see if the app dies again. A
second crash survived two fixes aimed at a mechanism inferred from the stack
alone, so MARVIN now **captures the exception itself** (ADR-0062) — name,
reason, symbols to `~/Library/Logs/MARVIN/exceptions.log`. It identified the
cause on the first occurrence after install: AppKit's own breaker for a layout
pass that never converges, thrown from inside SwiftUI. Now logged and survived
rather than fatal; **root cause still open.** The instrumentation's own first
attempt failed silently (SwiftUI ignores `NSPrincipalClass`), caught only
because it stamps a line saying whether it is armed — keep that stamp.
**The check-back guard** stopped swallowing timed promises (ADR-0055 addendum):
coverage is now decided per promise, because a background dev server never exits
and so can never discharge "I'll check in ~2.5 minutes". **Backlog review**
(ADR-0063) and **classification** (ADR-0064) landed read-only — the groomer
reports duplicates, stale items, dead file references and untriaged captures;
the user decides. Classification was fitted to a real 430-item backlog rather
than picked off a shelf, which is how `investigate` (output is a decision, not a
diff) and `blocked` (waiting on a human outside the repo — an axis, not a
category) earned their place. **CI is now audit evidence**: the release workflow
gates on the test suite (a tag push matched no branch filter, so four releases
shipped red), and the session auditor can detect "shipped on a red build" — with
`stale` as the load-bearing case, since a green run for a *different* commit
must say nothing rather than vouch. Plus **find-in-file** (⌘F), **View ▸ Backlog
(⌘⇧B)** so the panel is reachable when empty, and `bin/marvin doctor` no longer
telling you to kill your own running app.

**v0.1.60** — Graph drift, and the red CI nobody saw. Two findings that both
came from *measuring* rather than assuming. **Graph drift (ADR-0060):** the user
observed that MARVIN queries the knowledge graph during a plan's first
iterations and then just reads files. Measured across four real session
transcripts, that is exactly right — graph calls cluster in the first half of a
turn and then flatline, giving 1:5 to 1:11 graph:file ops with the back 40-50 %
of every session pure grep-and-read (in an 81-op session, deciles 7-10 contained
zero graph calls but 33 file ops). A regression against the 2026-05-27 audit
that found ~7:1 drift and responded by hardening the *prose*. The root cause is
structural, not model laziness: `checkGraphifyFirst` is a **one-shot gate at the
head of a turn** — the first Read denies, the model queries the graph,
`graphCallCount` hits 1, and the hook is disarmed for the remaining 70+ tool
calls. One graph call at the top of a turn buys unlimited reads; the gate was
written when turns were short, and agentic turns now run 30-80 calls. The fix
re-arms enforcement mid-turn with two deliberate asymmetries. Drift is counted
in **novel files only** — re-reading a file already open this turn is
implementation work, not exploration, and never charges the budget, because the
graph helps you FIND code and not WRITE it; a naive "re-arm after N reads" would
fire during exactly the phase where reading is correct, produce false denials,
and train the user to switch the hook off. And it **denies once, then nudges** —
the turn's first violation keeps its hard deny (it demonstrably works; it is why
the early graph calls exist at all) while every later firing is non-blocking
`additionalContext`, because a false-positive nudge costs one sentence of
context whereas a false-positive deny costs a blocked tool call mid-task.
Bounded at 7 novel files since the last graph call, max 3 nudges per turn, never
firing on Edit/Write/Bash. Recorded honestly: unlike ADR-0055/0057 this guard
**cannot close its own loop** — there is no deterministic way to know a read
should have been a graph query — so its DoD carries an unticked empirical item
to re-measure the ratio. **Red CI (fix):** the `test` workflow had been failing
on every push since v0.1.56 — four releases — while `release` stayed green, so
nothing blocked and nobody noticed. Two backlog tests fill the open-items rail
with `MAX_OPEN_ITEMS` sequential adds (~400 filesystem ops each); v0.1.56 raised
that rail 50 → 200, and while they run in ~1.3 s on a local SSD they exceeded
vitest's 5 s default on GitHub's slower runners. Neither test nor product was
wrong — the default was tight for I/O of that size — so both now carry an
explicit 30 s timeout with the history in a comment. CI is green for the first
time since v0.1.55. 550 tests + typechecks green. Builds on v0.1.59.

**v0.1.59** — The session auditor (ADR-0059): judgement-level oversight without
the supervisor anti-pattern. The question that started it was "should MARVIN get
a **supervisor** agent overseeing the executor and advisor?" — answered no, since
that is precisely ADR-0001's camp 2, the topology this project was rebuilt to
escape, and a supervisor spawned and briefed by the executor it supervises is
theater. But the analysis surfaced a real gap: MARVIN's supervision is entirely
**mechanical** (the permission gate, ADR-0055's check-back guard, ADR-0057's
completion guard) and deterministic code cannot judge drift, quiet
reinterpretation of a DoD, repetition, or a claim like "verified end-to-end"
backed by a transcript showing only a typecheck. So: an **auditor**, not a
supervisor. It is **runtime-dispatched** (never a `Task` subagent, never on the
executor's agents map — the executor has no path to audit itself), **read-only**
at the SDK layer, and it **reports to the user** with zero enforcement authority.
Authority still runs user → executor; no model ever commands another model. It
reasons over a runtime-assembled packet that juxtaposes **claims** (the
transcript) against **evidence** (the auto-audit tool log, change checkpoints,
the plan spine) — the juxtaposition is the audit. Shipped with the read-only
`marvin-graph` tools wired in, so it can also check **blast radius**: "the plan
renamed X, the graph lists 12 callers, the change set touched 3." That is gated
on an explicit `GraphFreshness` computation — a graph older than the session's
edits describes the old code, so structural findings are forbidden when it is
stale (a confident phantom finding is worse than none), and even when fresh the
evidence is treated asymmetrically: "callers not updated" is strong, "no callers,
therefore dead" is weak, because AST extraction misses dynamic dispatch and
config wiring. Findings are **actionable**, not a wall of text: the report parses
into structured findings rendered as cards with **Park to backlog** (reusing
ADR-0044's whole pipeline — panel, filters, promote-to-plan, resolve),
**Work on it** (Plan mode + present-a-plan-first, mirroring `promoteBacklog`,
and explicitly inviting MARVIN to refute the finding with evidence rather than
plan busywork), and **Dismiss**. Triggered from the scope-met chip strip — the
natural moment, right beside ADR-0057's mechanical check — or the always-available
"Audit Session…" menu item; deliberately NOT from Ask mode, since Ask mode is the
executor with writes disabled and an executor auditing its own narrative from
inside that narrative is the self-briefing failure the design avoids. First real
audit on a live project immediately caught a commit that had landed on an
unrelated feature branch and a scope-met claim contradicted by the very next
reconciliation check. 542 tests + typechecks green. Builds on v0.1.58.

**v0.1.58** — Reliability-guard arc: MARVIN starts enforcing its own workflow
mechanically instead of trusting prose. Five ADRs landed same-week, each
following the pattern "a prose MUST fired unreliably → close it at the gate."
**Plugin agents (ADR-0054):** plugin-shipped subagents (claude-security's 7,
code-modernization's 8, honeycomb's 2) now load and dispatch via `Task`
read-only — confirm-gated dispatch, `agentID` invariant hard-denies any
mutation, so they analyse/report while the main loop applies changes. Hooks
stay stripped, deliberately not "pending." Supersedes the deferred bespoke
Honeycomb-MCP roadmap item. **Check-back guard (ADR-0055):** the "I'll check
back in ~7 minutes" failure — MARVIN narrating a promise while arming nothing,
observed live on a real project turn (empty wakeups file, zero scheduler
activity in the log) — now auto-arms a wakeup at turn-end when a promise is
detected with no `schedule_wakeup`/`run_background_job` call; delay parsed
from the message, prompt forces the fired turn to actually check status
rather than re-promise. Also fixed wakeup turns defaulting to `marvin` voice
instead of `ultron`. **File-tree crash fix (ADR-0056):** the app hard-crashed
3× (SIGTRAP in SwiftUI's `OutlineGroup`/`ViewListTree.visitItem` — duplicate
id in the file tree); root cause was that `OutlineGroup` needs ids unique
across the WHOLE tree but only siblings were deduped, so a cross-branch path
collision (an agent mutating files mid-refresh) traps the outline coordinator.
Fixed by sanitising the fetched tree to whole-tree id-uniqueness
(`deduplicatedTreeWide`) before it reaches the view — supersedes 3 prior
failed per-symptom patches (animation-disable, empty-dir-collapse, sibling
dedup). Durable fix (NSOutlineView migration) scoped on the roadmap with an
explicit recurrence trigger. **Workflow-completion guard (ADR-0057):** the
user-reported failure this arc responds to directly — MARVIN declaring a plan
finished while TodoWrite items sit open and an ADR's `## Scope of Done` stays
unticked. A scope-met close with a real gap now fires a corrective turn
demanding honest reconciliation (mark what's genuinely done; retract what
isn't — never tick-to-satisfy). Covers both the in-turn TodoWrite case and,
via a defensively-parsed fallback into the persisted plan spine, the
multi-turn case where the closing turn emits no TodoWrite at all. Conservative
on the ADR check: a partially-ticked DoD (legitimate deferrals, e.g. this
release's own ADR-0056) is never flagged — only a wholesale miss (zero `[x]`)
trips it. **Parallel graph extraction (ADR-0058 + same-day addendum):** the
semantic `/graphify` pass was serial-slow on a large project because
graphify's extractor subagents need to write chunk files and the read-only
invariant denied all subagent writes. Fixed with a narrow `graphify-out/`
-scoped file-write exception (parallelism — works even with graphify's stock
`general-purpose` dispatch) plus a Haiku-tier `graph-extractor` subagent
(cost). The addendum closed both limits the ADR shipped with, mechanically:
the gate now **rewrites** a stock general-purpose extraction dispatch to
`graph-extractor` via `updatedInput` when the brief both names a
`graphify-out/` path and uses extraction vocabulary (Haiku saving no longer
depends on a prompt steer being followed), and the canonical graph artifacts
(`graph.json`, `memory/`) are subagent-write-denied even inside the slit, so
a poisoned extractor can only feed chunks into the main loop's deterministic
merge — the same exposure the serial path always had, not a new one.
512 tests + 3× typecheck green; full Xcode build verified; app rebuilt +
installed. Builds on v0.1.57.

**v0.1.57** — Claude Code plugins become first-class in MARVIN + the ultron
voice. **Plugins (ADR-0053):** MARVIN runs the SDK in isolation mode, so plugins
installed via the Claude Code `/plugin` UI never loaded. Now: discovery from
`~/.claude/plugins/` (shared registry, bidirectional), **opt-in per project** via
`.marvin/plugins.json`, loaded through the SDK `plugins:[{type:'local',path}]`
array from a sanitised staged copy — skills + slash commands + MCP in v1,
agents/hooks stripped pending their own ADR. The gate is **hardened**: MARVIN's
four in-process MCP servers are allowlisted and every other `mcp__*` tool now
routes through `confirm` (closing a standing blanket-allow hole; sub-agent calls
hard-deny). A macOS **Plugins pane** (LeftPane tab) lists installed plugins with
provenance (✓ Anthropic badge / author / marketplace) + contribution chips, a
searchable **marketplace catalog** (~270 plugins from the local marketplace
clones, ranked search, one-click install — no network for relative-source
plugins), and an install-from-URL sheet; `plugin-installer.ts` registers
installs in `installed_plugins.json` exactly like the Claude Code UI. Shipped
with a same-day regression fix: the manifest MCP fallback leaked `author`/
`keywords` objects into `options.mcpServers` (9 enabled plugins → every turn
died); extraction now requires an explicit `mcpServers` field and validates
server shape (`command` | `url`) — the honeycomb shape that broke turns is a
pinned regression test. **Ultron:** third `PersonalityMode` and the new default —
grandiose, coldly amused, menace-as-theatre; style layer only, never a refusal
layer ("the menace is theatre; the help is total"). Wired end-to-end: runtime
type/resolver, web toggle + prefs + bridge, macOS pill (3-way cycle) + popover +
NativePrefs. 466 tests + 3× typecheck green; full Xcode build verified.
Builds on v0.1.56.

**v0.1.56** — Release roll-up: the frontend catches up + the backlog becomes
usable. Everything landed since v0.1.55 (18 commits) shipped without a tag; this
rolls it into one release. Two arcs. **Frontend catches up to the backend**
(2026-07-03 milestone): pane toggles that actually toggle, a graph pane
(WKWebView over `/api/graph/html`), File → New Session, a backlog **detail view**
(severity/body editing + resolve-with-note), a session **Plans panel** (browse /
switch / continue / remove), and an activity surface (wakeups + background jobs
get HTTP routes + UI). **Backlog becomes usable**: the open-items rail raised
50 → 200 (a real project hit 50 through ordinary capture); the graph HTML cap
4 MB → 32 MB (real graphs were 413-rejected and the pane lied "no graph"); the
parked-items list now shows **immediately in a fresh chat** (a new session's
`clear()` re-fetches the count instead of waiting for the first turn to light the
tray chip); and **sort / group / filter** controls over the panel (severity ·
newest · oldest · title; group by severity/status; severity + show-resolved
filter, all `@AppStorage`-persisted). Also: the eight `@marvin/*` workspace
packages, stranded at the stray `1.2.0`, are aligned to the real lineage.
`swift build` + vitest green. Builds on v0.1.55.

**v0.1.55** — Verify-then-remediate contract for the plan loop. Phase 6/7 walked
the Definition of Done but had no explicit contract for a *failed* check. Now split
by failure class: mechanical failures (typecheck/tests/build) self-remediate without
asking — capped at 3 attempts per milestone with an early no-progress stop (identical
errors twice = spinning → stop) — while scope-level gaps get surface-and-offer (state
the gap + the one next step, then gate; "one gap, one gate"). A blind retry-until-DoD
loop was deliberately not built (it institutionalizes the Golden-Rule-8 "helpful
spiral"). Prompt-only change in `personality.ts`; also fixed 9 pre-existing typecheck
errors in `can-use-tool-dispatch.test.ts` and added `macos/build-spm/` to
`.graphifyignore`. `tsc` clean, 25/25 dispatch tests pass. Builds on v0.1.54.

**v0.1.54** — The IDE no longer resets on a transient health blip. The window
"kept resetting" mid-work — pane layout, file-tree expansion, terminal, editor,
chat scroll all snapping to default. Cause: `ContentView.mainContent` **switches
its whole view tree on `health.state`** (`.connecting`/`.online`/`.offline`), and
`HealthMonitor.pollOnce` flipped to `.offline` on **any single failed
`/api/health` poll** (3 s timeout, no hysteresis). A healthy-but-busy
single-threaded sidecar (mid-turn, or a per-turn AST graph rebuild blocking the
Node event loop) occasionally answered slowly → one timeout → `.offline` → the
entire IDE torn down → next poll succeeded → `.online` → IDE rebuilt from
scratch. Fix: demote to `.offline` only after **3 consecutive** misses (holding
`.online`/`.connecting` through blips), poll fast while misses are pending so a
genuine outage still surfaces in a few seconds, and bump the poll timeout to 5 s.
`swift build` clean. Builds on v0.1.53.

**v0.1.53** — Backlog "Promote to plan" now actually plans (and never silently
drops). Promoting a backlog item did nothing and didn't start a plan. Two bugs:
(1) `promoteBacklog` sent `"Implement this backlog item…"` in whatever mode was
active and **never switched to Plan mode** — but the turnCompleted ingest only
mints a tier-2 Plan + approval chip when `mode == "plan"`, so MARVIN never
"treated it as a plan" (Ask mode did nothing; Agent mode just started editing).
(2) If a turn was in flight, `sendControl`'s `!isSending` guard **silently
dropped** the promote while the panel closed anyway → "nothing happens". Fix:
`promoteBacklog` switches to Plan mode and asks MARVIN to present a plan inline
(read-only first, no edits), and when busy it **queues** the request (dispatches
as the next turn) instead of dropping it. `swift build` clean. Builds on v0.1.52.

**v0.1.52** — Fix file-tree crash (`OutlineGroup` empty-directory trap). The app
crashed (`EXC_BREAKPOINT` / `SIGTRAP` in `OutlineListCoordinator.recursivelyDiffRows`
→ `collapseItem` → `_assertionFailure`) during a file-tree row diff. Cause:
`FileNode.outlineChildren` returned a **non-nil empty array `[]`** for empty
directories ("expandable but empty"), but SwiftUI's `OutlineGroup` /
`List(children:)` traps when the children keypath returns `[]` (it expects `nil`
for a leaf or a non-empty array). An agent mutating files mid-session (a dir
emptied/created → tree re-fetch) flips a node into that shape and the next diff
crashes the whole app. Fix: return `nil` for empty directories (leaf, no
disclosure triangle; the folder icon still comes from `isDirectory`). Confirmed
from the crash report (`MARVIN-2026-06-26-214203.ips`, app 0.1.51). `swift build`
clean. Builds on v0.1.51.

**v0.1.51** — Plan-in-context: the model is now aware of the active plan every
turn ([ADR-0051](./decisions/0051-plan-in-context-injection.md)). The plan was
**UI-only state** — a strip rehydrated from the transcript, never injected into
the model's prompt (`buildProjectContext` injects docs/ADRs/memory/graph, never
the plan). So the model only knew the plan if it survived in conversation
history, which a chat switch or context compaction drops — hence "MARVIN stopped
tracking / won't continue the plan" while the strip still shows it. Now the
client sends a compact `planContext` snapshot (title + `[x]/[~]/[ ]` steps +
sub-tasks, marked authoritative) each turn, and the runtime appends it as a
`<system-reminder>` **suffix on the user message** — the uncached volatile tail,
so it's prompt-cache-safe (per Anthropic's caching rules), and it's never
persisted to `turn.user` (clean reloads, no display strip). Mirrors how Claude
Code re-injects its todo list every turn. Threaded macOS→route→orchestrator→
sdk-runner like `playwrightEnabled`. The missing half of the plan story:
ADR-0049 fixed tracking, ADR-0050 fixed resume, this fixes **awareness**.
`swift build` + `tsc` clean. Builds on v0.1.50.

**v0.1.50** — A plan step can't read "done" while its sub-tasks are open
([ADR-0049](./decisions/0049-plan-step-join-key-and-rollup.md) addendum). A step
(step [10], "Operator console panel") showed completed with all eight of its
DoD/Tests/Verify sub-items still unchecked. The ADR-0049 roll-up downgraded a
parent on *partial* progress, but had an implicit `else` that kept the
model-declared status — so `[10] completed` over all-`pending` sub-tasks survived
(neither "all done" nor "any activity" fired). Fix: completion is now a hard
invariant — a step that owns sub-tasks is `completed` **iff every sub-task is
completed**; otherwise `in_progress` (any activity) or `pending`. A parent can no
longer read as finished while a leaf is open, regardless of what the model
declares. `swift build` clean. Builds on v0.1.49. _(Correction, 2026-07-02
audit: the "standalone test" claimed here did not exist at release — the
invariant lives in the app target, unreachable from `MARVINTests`. The
model types have since moved to `MARVINLogic` and the
`plan-completion-invariant` suite now pins this for real.)_

**v0.1.49** — A 529 (or any non-plan reply) can no longer hijack the active plan
([ADR-0046](./decisions/0046-plan-as-durable-spine.md) addendum). A user's real
plan stopped being tracked, ignored "continue / close the remaining items", and
opening `plan.md` showed `API Error: 529 Overloaded`. Cause: every Plan-mode
`turnCompleted` ingested `lastAssistantText()` as a plan **without checking it
was one** (the replay path guards with `PlanCard.isPlan`; the live path didn't).
A Plan-mode turn that hit a 529 streamed the error as its reply → `ingestPlan`
found no `# Plan` heading, fell back to the title "Plan" → slug `plan` →
`plan.md`, turned the error line into a step, and set it as the **active** plan,
stranding the real one. Fix: gate the live ingest **and** the Approve chip on
`PlanCard.isPlan(finalReply)`, so a non-plan reply (error or prose) ingests
nothing. `swift build` clean. Pairs with ADR-0049 (tracking) + ADR-0050 (resume).
Builds on v0.1.48.

**v0.1.48** — Background jobs killed on app-quit no longer spam a "job failed"
turn ([ADR-0038](./decisions/0038-background-jobs-event-wakeups.md) addendum).
Every close→reopen surfaced a "background job finished … killed by signal SIGTERM
… it did NOT succeed — diagnose" turn in the chat (174 accumulated across one
project's transcripts). Cause: a long-running job (a Vite dev server) only ends
when killed, and app-quit SIGTERMs the sidecar's child jobs — but `onExit` only
suppressed the completion turn for jobs cancelled via the explicit cancel tool,
so shutdown-kills fired a spurious failure turn that resurfaced on next launch.
Fix: `onExit` now also skips the turn for stop/shutdown signals (`SIGTERM` /
`SIGINT` / `SIGHUP` / `SIGKILL`) — "stopped, not finished", matching
`cancelBackgroundJob`. Genuine exit codes (success or failure) and real crash
signals (`SIGSEGV`, …) still notify. New test pins it; runtime `tsc` clean.
Builds on v0.1.47.

**v0.1.47** — MCP-vs-CLI browser choice is now a deterministic trigger
([ADR-0045](./decisions/0045-playwright-mcp-gated.md) addendum). With the
Playwright MCP enabled (v0.1.46), MARVIN still under-used it: the "Browser tools"
guidance made the CLI the *default* and only *"preferred the MCP for
interactive"* — a soft nudge that, by the same logic as the 2026-05-22 skills
audit, fires ~0× in practice. Converted the section in `personality.ts` into a
firm surface: a **MUST** list (any interaction / asserting post-interaction
state / multi-step read-between-steps / interaction-failure debugging → use the
`browser_*` MCP) + a **MUST-NOT** list (single static screenshot or a pre-written
`@playwright/test` suite, or the server being off → CLI) + a fallback test
(stateful-across-actions → MCP; fire-and-forget → CLI; torn → MCP). Prompt-only;
no data-model change. Builds on v0.1.46.

**v0.1.46** — Playwright MCP server now actually starts (GUI-launch PATH fix,
[ADR-0045](./decisions/0045-playwright-mcp-gated.md) addendum). With the
Playwright toggle ON, MARVIN still couldn't see the
`mcp__playwright__browser_*` tools. Root cause: a Finder/Spotlight-launched app
inherits the minimal launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits
Homebrew (`/opt/homebrew/bin`) where `node`/`npx` live — so the SDK's bare `npx
@playwright/mcp@latest` spawn ENOENT'd, the stdio server never started, and the
tools never registered (confirmed live: the SDK process had the minimal PATH and
no `@playwright/mcp` child). Fixed in two layers: `SidecarManager.swift` prepends
the Homebrew / `/usr/local` bins to the sidecar's PATH at launch, and
`sdk-runner.ts` (`enrichedToolPath()`) re-enriches PATH on `turnEnv` + the
Playwright server's `env`. Verified: minimal PATH → `npx: command not found`;
enriched → server reports `Version 0.0.76`. New `enriched-tool-path.test.ts`
(4 cases); runtime `tsc` + `swift build` clean. Builds on v0.1.45.

**v0.1.45** — Continue control anchors on the active plan
([ADR-0050](./decisions/0050-continue-control-anchors-active-plan.md)). The plan
strip's **Continue** chip sent an *unscoped* resume instruction — "continue with
the remaining plan steps" — that never told the model what the plan was, so on a
long audit-heavy session it re-derived "what's left" by scanning the whole
project (grepping `PLAN.md`, `ls`-ing every ADR, reading `INDEX.md`) instead of
resuming the current plan. v0.1.45 makes the resume controls **inject the active
plan's concrete steps + statuses** (a `[N]`/`[N.M]` tagged checklist via
`resumeChecklistBlock`) and adds a hard guardrail: resume ONLY this plan — do not
start a new audit, scan the project, or list ADRs; if every step is already
complete, say so and stop. Applied to both `continuePlan()` and
`proceedWithRecommendation()`. Complements [ADR-0049](./decisions/0049-plan-step-join-key-and-rollup.md):
0049 stops a finished plan from showing the chip at all; 0050 bounds a genuine
mid-plan resume. Pure control-instruction change in `ChatPreviewView.swift` — no
`personality.ts` or data-model edit. `swift build` clean. Builds on v0.1.44.

**v0.1.44** — Plan-step join key + subtask roll-up
([ADR-0049](./decisions/0049-plan-step-join-key-and-rollup.md), revising
[ADR-0046](./decisions/0046-plan-as-durable-spine.md)). Plan tracking linked
tasks to the plan's action items by *fuzzy text match* — so a `TodoWrite` item
the model reworded at execution time failed to match its step, landing as an
orphan sub-task, and the plan never advanced because a step only moved when its
exact text matched. v0.1.44 replaces that with a **stable join key**: the
executor tags each `TodoWrite` item `[N]` (plan step N) or `[N.M]` (sub-task M
of step N), so a reworded task still links to the right step. Adds **upward
roll-up** — a step auto-completes when all its `[N.M]` sub-tasks complete
(in_progress while partial) — directly fixing "tasks don't link to the plan" and
"the plan never updates". Fuzzy matching is kept as the untagged backstop, so a
turn that ignores the contract degrades to v0.1.41 behaviour rather than
regressing. `personality.ts` + the `approvePlan()` execute instruction teach the
tagging contract + roll-up rule. `swift build` clean; `personality.ts` `tsc`
clean. Builds on v0.1.43. _(Correction, 2026-07-02 audit: the "11-assertion
standalone logic test" claimed here did not exist at release. The model types
have since moved to `MARVINLogic` and the `plan-reconcile` suite (13
assertions) in `MARVINTests` now covers tag-linking, nesting, full + partial
roll-up, key-based de-dup, and fuzzy fallback for real.)_

**v0.1.43** — Full session history via incremental paging
([ADR-0048](./decisions/0048-full-session-history-tail-first.md)). Cold-start
restore loaded only the last 200 `cli.event` lines (`hydrate(tail:200)` + the
server's `turns.slice(-tail)`), so a restored session showed truncated history
with no signal it was clipped — only auto-restore was affected (manual
history-pick already loaded full). The server now returns `truncated` +
`totalTurns`; the client paints the last 200 lines instantly, then a
top-of-list control loads the **next 200** (`loadNextHistoryPage`) or jumps to
the **full log** (`loadFullHistory`) on demand, with a live "N of M lines"
count. Loads decode off-main and replay into the lazy `LazyVStack`, are guarded
(same session, not mid-send), and reset on session switch. Fast first paint +
user-controlled completeness, never auto-paying the 120 MB worst case.
`swift build` + sidecar `tsc` clean. Builds on v0.1.42.

**v0.1.42** — Plan persistence + review-window fixes + backlog capture-at-discovery.
Three changes shipped together. **(1) Plan persists across chat switches**
([ADR-0046](./decisions/0046-plan-as-durable-spine.md) follow-up): the plan
strip was in-memory/session-scoped, so switching chats or relaunching lost it;
`replay` now reconstructs the plan + checklist from the transcript on session
load (last `# Plan` reply + latest `TodoWrite` for step progress), and a later
`TodoWrite` reconciles into the restored plan instead of orphaning as a tier-1
task list. **(2) Review window** ([ADR-0034](./decisions/0034-agent-change-review-checkpoints.md)
bugfix): a newly-written file (one all-added hunk) rendered a half-empty
side-by-side and hung the window — added/deleted files now render single-column
with a banner, the diff flattens to a virtualised row-level `LazyVStack`, and a
>1500-line diff is gated behind "Show anyway" (mirrors GitHub/VS Code). **(3)
Backlog capture-at-discovery** ([ADR-0047](./decisions/0047-backlog-capture-at-discovery.md),
revises [ADR-0044](./decisions/0044-project-backlog.md)): a new `provisional`
status + `backlog_add … provisional:true` auto-park a "noticed in flight" item
the instant it's seen (no go-ahead), with a keep/dismiss review at the handoff,
so discoveries survive a turn that never reaches the handoff. `swift build` +
runtime `tsc`/tests clean. Builds on v0.1.41.

**v0.1.41** — Plan as the durable spine ([ADR-0046](./decisions/0046-plan-as-durable-spine.md),
revising [ADR-0036](./decisions/0036-ask-agent-plan-modes.md)). Fixes two
plan-tracking bugs: a `TodoWrite` emitted mid-plan wholesale-replaced the
checklist (sub-tasks erased the plan's steps + fired a false "Plan complete"),
and a second plan overwrote the single plan slot (the original became
untrackable). The active plan now owns hierarchical `PlanStep`s; incoming
`TodoWrite`s **reconcile** into them via `PlanProgress` (matched step → status
update, unmatched item → nested sub-task) instead of replacing the list;
completion is computed over top-level steps only; plans live in a revision-aware
session list (`plans` + `activePlanId`) with a `TodoListStrip` picker so prior
plans stay navigable. `personality.ts` + the approve-to-execute instruction now
require a full carry-forward `TodoWrite`. `swift build` + runtime `tsc` clean.
Builds on v0.1.40.

**v0.1.40** — Fix: AskUserQuestion's "Send choice" silently doing nothing. The
interactive decision sheet (ADR-0040) registered its confirm with the default
**5-minute** auto-deny timeout — the same one used for permission confirms. A
human weighing detailed options for >5 min was silently auto-DENIED (the turn
proceeded ignoring the choice; the registry entry was deleted), so a later
"Send choice" click hit a dead confirm (404) and did nothing. AskUserQuestion is
the model explicitly blocking on a human decision, so it now registers with NO
auto-deny timer (`timeoutMs: 0`) — it waits for the human; the turn's `finally`
(`clearTurnConfirms`) + Stop unwind an abandoned one. Regression test in
`confirm-registry-timeout.test.ts`. Builds on v0.1.39.

**v0.1.39** — Playwright MCP, opt-in + gated ([ADR-0045](./decisions/0045-playwright-mcp-gated.md)).
MARVIN's first EXTERNAL (stdio) MCP server (`npx @playwright/mcp@latest`), **off
by default**. The gate previously blanket-allowed every MCP tool — safe for the
in-process graph/memory/backlog servers, unsafe for Playwright's code-exec/egress
tools. `policy.ts mcpToolPolicy` now classifies the `playwright` tools
(observation auto · interaction/navigation confirm · `browser_run_code_unsafe`
deny) and `classifyToolCall` consults it before the blanket-allow, reusing the
ADR-0030 subagent collapse so scouts get only observational tools. The
`playwrightEnabled` toggle is threaded end-to-end (web Setup popover + macOS
Settings ▸ Browser). Builds on v0.1.38.

**v0.1.38** — Project backlog ([ADR-0044](./decisions/0044-project-backlog.md)). A
durable, per-project parking lot for *actionable* "noticed in flight, not in
scope" follow-ups that previously evaporated with the chat (Golden Rule 4).
Shared `backlog.ts` store (file-per-item + index, mirrors memory ADR-0042) ←
`marvin-backlog` MCP tool (`backlog_add`/`list`/`resolve`, content-class
enforced) + `GET/POST/PATCH /api/backlog`. Consent-gated capture at the
scope-met handoff; open items re-injected by `buildProjectContext`; macOS
`BacklogPanel` + tray chip with Done / Dismiss / Promote-to-plan / optional
GitHub-issue export. A parking lot, never a Kanban queue (Golden Rule 1). Builds
on v0.1.37.

**v0.1.37** — Server-initiated turns reach an idle client ([ADR-0043](./decisions/0043-server-turn-announcements.md)).
ADR-0038's background-job completion (and ADR-0031 wakeups) fire a real turn
server-side, but the idle macOS app only attached to a turn's stream on session
*hydrate* (`attachLive` had one caller) — so a job-completion / wakeup turn ran
into the bus with no listener and was invisible until the next session switch.
A new per-project always-on SSE (`GET /api/chat/announce`) forwards a
`turn.registered` emitted from `registerLiveTurn`; the idle client, when it has
no live stream of its own, calls the existing `attachLive` and the turn renders.
Plus a "background job running" chip so in-flight ≠ done. Completes the ADR-0038
loop on the client axis. 3 new announcer tests (26 runtime green); `swift build`
clean. Builds on v0.1.36.

**v0.1.36** — A fired wakeup no longer evicts a live interactive turn. The
v0.1.33 one-live-turn 409 guard only covered `POST /api/chat`; the wakeup
dispatch path bypassed it, so a scheduled/event-driven wakeup firing during an
interactive turn evicted it ("replaced by a newer turn on the same session",
aborting the user's work). `wakeup-scheduler` now yields — defers + re-arms —
while a turn is live (`deferIfSessionBusy` in `fire`/`fireNow`). Builds on v0.1.35.

**v0.1.35** — Context-usage panel. The status-bar `ctx` chip is now a
click-to-open popover (`ContextDetailPopover`): exact resident/window % from
live SDK usage with window-relative colour bands (a 1M `[1m]` model no longer
reads "critical" at 140K), plus an estimated per-category breakdown (system
prompt · tools+MCP · project-context sub-sections · derived transcript · free).
New `GET /api/context`; `buildProjectContext` now returns `{ text, breakdown }`.
Builds on v0.1.34.

**v0.1.34** — "Stop" is authoritative. `cancelLiveTurn` now force-ends the turn
(abort + synchronous `endLiveTurn`) so a wedged agent can't lock the session
behind the 409 guard with no in-app recovery. Builds on v0.1.33.

**v0.1.33** — One live turn per session. `POST /api/chat` now returns
`409 turn-in-progress` instead of silently evicting a running turn, and turn
eviction `abort()`s the displaced agent rather than just disconnecting it —
fixing the "replaced by a newer turn on the same session" stream error that
froze heavy multi-step turns mid-plan and left an orphaned agent still mutating
the workspace. Regression test in `turn-registry.test.ts`. Builds on v0.1.32.

**v0.1.32** — memory.md becomes a curated durable-facts layer (ADR-0042). A
real project's `.marvin/memory.md` had bloated to 419 KB / ~99% redundant with
ADRs/git/changelog. Now a `marvin-memory` MCP tool (`remember`/`recall`) is the
enforced write path — one fact → `.marvin/memory/<slug>.md` + a one-line index,
with caps + content-class guards that reject activity/status. `personality.ts`
firm surface routes facts through `remember`; a `/memory-compact` command
distills existing logs. The native Scope-met chip is retargeted to
`session-notes.md` so it no longer pollutes the index. Builds on v0.1.31.

**v0.1.31** — Fixes "Prompt is too long" on the first message of a mature
project. Two layers (ADR-0041): MARVIN now **builds/maintains the active
project's graphs** (code + knowledge, AST-only/free, cwd-scoped — never its own
repo), and the **first-message context is budgeted** — ADRs inject as a titles
index (details via the knowledge graph + targeted reads), memory.md as a recent
tail, curated docs stay whole. agri-saas-platform's first-message context drops
from ~566K to ~13.4K tokens. Builds on v0.1.30.

**v0.1.30** — Interactive AskUserQuestion: when the model hits a real
decision it can call `AskUserQuestion` and MARVIN renders the options as
clickable buttons (single/multi-select + "Other"), returning your pick to the
model as the tool result — instead of prose "(a)/(b)" you could only answer by
typing. Routed through the existing confirm channel in every mode (ADR-0040);
a fallback chip still handles prose questions. Also bumped CI actions to their
Node-24 majors ahead of GitHub's June 16 cutoff. Builds on v0.1.29.

**v0.1.29** — No "Approve & execute" chip on an already-complete plan: a
finished plan showed both "Plan complete 10/10" and the approve chip. The
tray now gates the approve chip on `!planComplete` and clears
`planAwaitingApproval` at turn-end when the plan is done, so a completed plan
shows only the collapsed "Plan complete" strip. Builds on v0.1.28.

**v0.1.28** — Plan title/file robust to preamble + the Homebrew "damaged"
fix. The saved plan file + tier-2 strip header now derive the title from the
`# Plan — <title>` heading wherever it sits (the model often writes diagnosis
prose first), so filenames stop coming out as
`i-have-the-root-cause-nailed-….md`; the chat splits that preamble off and
renders the plan portion as the structured card. Separately, the cask now
strips `com.apple.quarantine` in a `postflight` — modern Homebrew quarantines
casks by default, and an ad-hoc bundle + quarantine triggers macOS 26's
"MARVIN.app is damaged" rejection. Builds on v0.1.27's two-tier to-do / plan.
Install via
`brew tap RobertIlisei/marvin && brew install --cask marvin-ai`. Earlier
tags v0.1.0–v0.1.5 carried pre-scrub code and have been deleted from
GitHub; stray tags v1.2.0/v1.3.0 have no release. Per-release detail in the
[changelog](./history/CHANGELOG.md).

### Earlier — shipped, in reverse order

_These sat under `## In flight` long after they landed. The section is meant to be a
picture of what is being worked on now, and a fossilised one is worse than an empty one:
it makes every entry unreadable as a status. Kept in full — each carries its diagnostic
trail — and moved, not deleted._

- **The graphify-first rail must outlive the tool surface ([ADR-0098](./decisions/0098-the-rail-must-outlive-the-tool-surface.md))** — ADR-0097's CLI upgrade (2.1.113 → 2.1.251) silently removed `Grep` and `Glob` from the main agent's tool surface. Probed directly on both bundled binaries; `ToolSearch` answers `select:Grep,Glob` with "No matching deferred tools found", so they are gone, not deferred, and MARVIN's `disallowedTools` (only `ScheduleWakeup`) is innocent. The mild symptom was MARVIN telling the user it had answered "methodologically rather than with a fresh sweep". The real one: all four graphify-first guards key on `Read`/`Grep`/`Glob` and there is no `Bash` branch, so searching moved to `Bash` where the rail is blind — **15 of 18 Bash calls in the next four hours were search-shaped, against 2 graph calls**. ADR-0079's lesson a second time: a rail keyed on vendor tool names is only as durable as those names. `bashSearchTarget` now classifies a search-shaped Bash and one `isStructuralSearch` predicate feeds all four sites; conservative by design (a search binary must lead its list segment's first pipeline stage — never split on `|`, because `make smoke | grep FAIL` must never be denied) and the negative cases are the load-bearing assertions. Prompt text corrected to stop naming tools that no longer exist. 9 assertions.



- **Thinking blocks render, and the streaming pip stops outliving the turn** — the transcript was printing `unhandled block: thinking` over a `ContentBlock(type: "thinking", text: nil, …)` dump on essentially every turn: `reduceAssistant` mapped only `text` and `tool_use`, and the `.unknown` escape hatch cannot show thinking prose because it lives in `thinking`, not `text`. Now a real `ChatBlock.thinking` (plus `redacted_thinking`) rendered as a dim collapsed disclosure. Separately, a turn ends on five paths and only three sealed still-streaming rows; `.turnCompleted` assumed the SDK `result` event had done it via `reduceResult`, which is false for a turn the client ATTACHED to (the `result` can predate the attach), and `attachLive`'s defer had the same hole — so a row kept its "streaming…" pip against an idle brain. One `sealStreamingRows()` called from all five, same lesson as the `isSending` desync fixed at that call site one release earlier.



- **The Terminal tab opened onto nothing** — reported as broken on 0.1.79 after "working" on 0.1.78 and broken on 0.1.77; it depended on click order, not the build. Never the PTY: the pane showed no `TERMINAL <cwd>` header (which `TerminalPaneView` renders unconditionally) and `pgrep -P <marvin>` showed the sidecar as MARVIN's only child, so no shell had ever been asked to start — hence no error either, since both the spawn-failure and exit paths write into the view. `bottomPanesArea` stays in the hierarchy while the panel is shut (it collapses to zero height so the `VSplitView` keeps its divider), so the lone `onChange(of: activeTab, initial: true)` guarded on `isOpen` fired once at launch with the panel closed, mounted nothing, and never fired again — opening the panel doesn't change `activeTab`. Clicking another tab and back fixed it. The rule is now a pure `BottomPanelMounting.mounted(_:after:)` in `MARVINLogic` (ADR-0022) fed by both transitions, with 4 assertions including the closed→open-with-unchanged-tab case that nothing could test before.



- **The not-responding dialog, and a usage panel that polled only when watched** — eight 61-second main-thread hangs (2026-08-29, v0.1.65) sampled in one chain: `ScrollViewUtilities.sizeThatFits → LazyStack.measureEstimates → ForEachList.applyNodes`. The chat transcript's `.frame(minHeight: 140, maxHeight: .infinity)` forwarded the VStack's ideal-size query (nil proposal, from `sizeChildrenIdeally` — visible in the stack) into the ScrollView, whose ideal height is its entire content, so the LazyVStack measured every message and the laziness was gone. `idealHeight: 140` makes `_FlexFrameLayout` answer that query without consulting the child; definite proposals are unaffected, so the render is unchanged. Not reproduced on current code — a fix to the mechanism the stack names, not verified by repro. Separately, the ADR-0097 plan-usage numbers were correct in `/api/cost` (`five_hour 0.35 / seven_day 0.55`) while the popover showed the pre-refresh `49 %`: `CostService.poll()` is `NSApp.isActive`-gated and nothing fetched on open, so a terminal-driven session saw whatever was true when MARVIN last had focus. `refreshNow()` polls regardless of focus, called when the panel opens.



- **Verify against what runs ([ADR-0097](./decisions/0097-verify-against-what-runs.md))** — two symptoms, one mistake. The plan-usage bars stayed blank through ADR-0087 *and* ADR-0093 because **the SDK never resolves `claude` from `PATH`** — it spawns the native binary its own package links to, and `bundle-sidecar.sh` picked that with `find | head -n1`, so a bundle whose SDK was 0.3.251 linked **0.2.113** (CLI `2.1.113`, which predates `unifiedWindows`). Third "first, not newest" in this repo after ADR-0086 and ADR-0087; now resolved by matching the SDK's own version, replacing a wrong link, and warning when no match exists. Separately, `Skill` had been called **29 times across every transcript ever recorded, failing every time, with zero successes**: `listProjectSkills` fell back to the directory name when frontmatter was missing, so an unregistered runbook was listed always-active and printed into the prompt block as though invocable, and each `Unknown skill` was followed by a find/Read hunt. The loader was probed rather than assumed (five variants, SDK 0.3.251): `description:` is the load-bearing key, `name:` is optional and a disagreeing one is *ignored*, the registered identity is always the **directory**, and plugin-scoped skills only answer to `marvin-project-local:<dir>`. Blocked skills are now dropped from the active set (even against an explicit `skills.json`), shown NOT LOADED in the Skills pane with the reason, and listed to the model as files to read rather than skills to call. 7 assertions.



- **Session links scrubbed from all history; graphify fan-out un-serialised** — a `claude.ai/code/session_…` URL reached the body of public PR #110 and a `Claude-Session:` trailer sat on **60 commits** on `main`. User directive: never in PRs, commits, code or documentation. All 448 commits rewritten with `git filter-repo --partial` (0 remaining; tree hashes identical, content untouched; tags re-pointed; backup bundle taken first). Prevention is mechanical, not a note: `.githooks/commit-msg` rejects any message carrying a session link, wired with `git config core.hooksPath .githooks` — prose guidance is what this repo has repeatedly measured at ~0× firing. **Graphify's semantic fan-out was running serially:** the dispatch brief told each `graph-extractor` to "output ONLY valid JSON" and MARVIN wrote the chunk files itself, so every chunk's full payload funnelled back through the parent one at a time — that is the serialisation, and it is why a chunk read hit the 25k tool-output cap with a 78,774-token payload. The registered agent already contracts to write its own chunk file and return counts. `personality.ts` now carries three MUSTs (use `graph-extractor`; every chunk in ONE message; the subagent writes its own file), including the explicit note that `graph-extractor` satisfies the graphify skill's Step B2 demand for `general-purpose` "because it has Write and Bash access" — it has exactly that, gate-scoped to `graphify-out/`.



- **OpenRouter sessions resolve OpenRouter model ids ([ADR-0096](./decisions/0096-provider-aware-model-resolution.md))** — user: "when open router api key is selected, then marvin needs to dynamically know how to handle things." OpenRouter addresses models by vendor-prefixed slug (`anthropic/claude-sonnet-4.5`); Anthropic's API uses a bare id. The live catalogue already produced the right shape on each provider, but **every fallback path returned bare Anthropic ids regardless** — `FALLBACK_MODELS` is Anthropic-only and `listModels` returns it on any credential or network hiccup — so a transient failure silently swapped a working OpenRouter session onto ids OpenRouter cannot resolve, for the executor, advisor, graph-extractor, session auditor and skill discovery. Skill discovery had a second bug on top: `(isOpenRouter && model) ? model : …` reads as "prefer the caller's model on OpenRouter" but means "if we're on OpenRouter **and** got a model", so the OpenRouter-aware branch was the first thing dropped when the caller omitted one — which the Skills pane does whenever the executor picker is on "default" — landing on a hardcoded `"claude-sonnet-4-6"`. `session-auditor.ts` repeated it verbatim. **That is why skills failed on OpenRouter**; the skills machinery itself is CLI-side and provider-independent. Fix is one layer, not six call sites: `activeProvider()`, provider-scoped `fallbackModelsForProvider()`, and an `ensureProviderModelId()` boundary guard that rewrites a bare id to the live OpenRouter slug of the same tier (static slug map when the catalogue is down — the case where the guard actually matters) and logs every rewrite as `model.provider.rewrite`. Both inverted conditions deleted rather than patched: `latestForTier` is now provider-correct, so neither site needs a provider branch at all. Verified by probe: OpenRouter's Anthropic-format `POST /v1/messages` is real (401 unauthenticated) while `/v1/messages/count_tokens` **404s** — noted, out of scope. 10 assertions; three negative controls confirmed red.



- **Soft floor: warn when the advisor is weaker than the executor** — the advisor exists to be the *stronger* read (`sdk-runner.ts`: "a second opinion should always come from the strongest model"), but the Settings model picker lets both sides be chosen freely, so an advisor could sit below the executor and review work it could not have produced. The picker now shows a non-blocking warning naming both tiers. Deliberately soft: a cheap advisor is a valid choice (cost, latency, a deliberately different perspective), just rarely an accidental one — Apply is never disabled. Ranking is a pure `AdvisorTierFloor` helper in `MARVINLogic` (ADR-0022), silent when either side is unset (an unset advisor resolves to the latest Opus, an unset executor to the runtime default — neither is a choice made in the dialog) or unrankable (`other`, third-party/OpenRouter ids have no position on the scale and guessing one would produce confident nonsense). **Extended to third-party / OpenRouter models the same day:** `tierFor()` in `models.ts` derives the tier by substring, so every non-Anthropic id in the OpenRouter catalogue (`openai/gpt-5`, `google/gemini-2.5-pro`) lands in `other` — meaning the floor was silent for exactly the users most able to pick a cheap advisor. There is no honest cross-vendor capability ordering to hardcode, so the fallback signal is **price**: `pricing.completion` is already in `ModelInfo` from OpenRouter, and an advisor under half the executor's per-output-token price warns, with wording that says plainly it is measuring price, not capability. Tier still wins wherever both sides have one (a cheap Opus is still an Opus), and a wide 0.5 ratio floor keeps it quiet on models that are merely priced differently. 18 assertions; three negative controls confirmed red.



- **The advisor's verdict is read, and its caveats outlive the context window ([ADR-0095](./decisions/0095-advisor-verdict-is-read-and-caveats-persist.md))** — the gate had only ever observed the *dispatch*, so `reject` discharged it exactly like `go` and the advice lived only as long as the context window. On 2026-08-30 a session hit `compacting` **seven seconds** after starting on the advisor's fourth caveat; all four landed on model diligence alone. A `PostToolUse` hook now parses the `## Verdict` section, records `go | go-with-caveats | reject | unparsed` on the turn context, parks each caveat as a **provisional** backlog item (ADR-0047 capture-at-discovery, keep/dismiss at scope-met), and appends one line via `additionalContext` — not `updatedToolOutput`, because here the advisor's own words are the payload; the governor replaces precisely because there the content is the problem. `reject` denies the next trigger-path mutation **once**, quoting the verdict: enough to force it to be read, without handing a subagent a veto over the user's tree at 3am. The public hooks page documents neither `updatedToolOutput` nor `additionalContext` on `PostToolUse`; the SDK 0.3.245 `.d.ts` documents both (*"Replaces the tool output before it is sent to the model"*) and MARVIN's own output governor already ships on it — ADR-0073/0079's lesson a third time. Parser pinned against the **real** advisor reply from the incident, checked in as a fixture. Explicitly not built: any check that a caveat was *implemented* — that's a correctness oracle a hook can't be, and it drifts toward the supervisor shape Golden Rule 1 forbids. **Amended same day** after the three compromises were called out: (1) `AgentDefinition` has no `outputSchema` on 0.3.245, but the advisor's system prompt is ours — it now ends every reply with a ```marvin-verdict``` block, parsed first, prose as fallback, with `structured` recorded so a drifting advisor prompt is visible; (2) the swallowed `catch` is gone and, more importantly, `addBacklogItem`'s `{ok:false}` (the 200-item cap, validation) was never an exception and had been vanishing silently — refusals are now logged with reasons, oversized bodies truncated rather than refused (the whole-verdict fallback is the shape that exceeds the 2 000-char cap, so the safety net was the likeliest thing to fail), and `.marvin/advisor-caveats.md` is the floor; (3) "don't re-run the advisor for a friendlier verdict" moved from `personality.ts` prose to a hook deny — the 2026-05-22 audit already measured soft-nudge language at ~0× firing. Four negative controls confirmed red. **Correction:** the advisor model is not fixed at Opus — it is the user's pick from the Settings model picker over `/api/models` (`TopBarPopovers.swift`), with the latest Opus tier only as the default when nothing is chosen. So the prose fallback is a **live** path, not a legacy one: the block parser now tolerates what a smaller model actually emits (markdown emphasis on the value, `*`/numbered bullets, `go with caveats` spelled with spaces), and the telemetry line carries the advisor model beside `structured` so block-compliance is readable per model — otherwise "the prompt drifted" and "the user picked a small model" are the same number.



- **The advisor gate prescribes the registered agent ([ADR-0094](./decisions/0094-advisor-dispatch-uses-the-registered-agent.md))** — the `advisor-on-ADR-trigger` deny message still told MARVIN to spawn `general-purpose` with a `model: opus` hint, the pre-ADR-0033 shape, so every gate-triggered consult silently lost its reasoning effort, read-only `disallowedTools`, `marvin-graph` server and turn cap. Seen live on a prod `platform_audit` migration (session `711b8605`, 2026-08-30). Fixed both halves together: the message names `subagent_type: "advisor"` and drops the model hint and inline prompt, and `advisorCallCount` now increments on the registered type as well as the `advisor:` description prefix — keying on the prefix alone meant the gate could not see its own prescribed remedy. `ADVISOR_SUBAGENT_TYPE` is exported from `design-hooks.ts` and used as the `agents:` map key so the two names cannot drift again (ADR-0079 is what that costs).



- **Cancelled fetches stop rendering as errors, for real this time** — ADR-0086's guard unwrapped only `NSUnderlyingErrorKey`, but `FilesServiceError.transport(underlying:)` is a Swift enum whose NSError bridge has an empty `userInfo`, so `-999 "cancelled"` kept reaching the file-tree banner. `BenignCancellation` now reflects over associated values (the enum's child is the payload *tuple*, not the error). The old test passed against a hand-built `NSError` the app never produces; the fixture is now a real cancelled `URLSession` request against an accept-and-never-respond listener, and the new assertions were confirmed red against the old implementation.



- **Claude plan usage in the cost popover ([ADR-0082](./decisions/0082-claude-plan-usage-from-rate-limit-events.md))** — the subscription analogue of the OpenRouter credits block. The SDK emits a `rate_limit_event` on every turn (5-hour / weekly `utilization`, `resetsAt`, overage flags) and MARVIN was discarding it. Now recorded per window and shown as bars with refill times; per-turn tokens (in / out / cached) appear on the completed row for both providers.



- **Parallel implementation on isolated worktrees ([ADR-0081](./decisions/0081-implementer-subagents-on-isolated-worktrees.md))** — the first amendment to Golden Rule 1: a subagent still cannot mutate the *main* tree, but an `implementer` bound to a worktree MARVIN created may build in *that* tree. Verified live before designing: `EnterWorktree` is refused inside a subagent, the `Agent` tool's `cwd` is accepted but not honoured (Sonnet passed it; the file still landed in the main tree), a subagent's `Write` reaches `canUseTool` with `agentID == task_started.task_id` and the path already absolute, and read-only calls never reach the gate. So: `worktree_create` names branch + directory (never the subagent — 18 of 30 agents picked the same branch name in Anthropic's 2026-08 study), the registry binds the implementer from its dispatch prompt, the gate allows writes only under its tree and rewrites Bash to `cd '<wt>' && (…)`. Deliverable is a branch; the user merges.



- **Scouts no longer block the turn ([ADR-0080](./decisions/0080-background-subagents-and-builtin-readonly-agents.md))** — user: "waiting for 1 agent to finish before continuing kills our speed." Cause: the SDK's Agent-SDK default is *foreground*, and neither `scout` nor `graph-extractor` set `background`. Flipping it needed a runner change: `runAgent` closed the channel and armed a 5 s kill-watchdog at the first `result`, which would have killed a running scout. Verified live on 0.3.245 that a background subagent survives the main `result`, keeps its MCP tools (graph-first holds), and that the CLI re-prompts the model with the completion — so `result` is now deferred while `BackgroundTaskLedger` (fed by the SDK's REPLACE-semantics `background_tasks_changed`) reports live tasks, with a 15-min drain bound. `Explore`/`Plan` (built-in read-only) sanctioned. Advisor deliberately stays foreground.



- **Subagent tool renamed `Task` → `Agent`; five guards went dead ([ADR-0079](./decisions/0079-subagent-tool-rename-and-rails.md))** — Claude Code renamed the tool in v2.1.63 and MARVIN matched the literal `"Task"`. 12 real transcripts: **200 dispatches, all named `Agent`, zero named `Task`**. `Agent` was not in `KNOWN_TOOL_NAMES`, so `classifyToolCall` fell through to its not-in-the-gated-set blanket-allow and **subagent dispatch was ungated entirely**; ADR-0054's unknown-`subagent_type` confirm, the advisor design hook, ADR-0058's Haiku extraction remap (real ongoing cost) and ADR-0059's "the auditor must not spawn agents" were all inert. Now one `isSubagentDispatch()` matched by every site, `describe.each(["Task","Agent"])` on the gating tests, depth/concurrency env rails and per-agent `maxTurns`. ADR-0073's "verified live" claim corrected — it read `system/init`, which still advertises the old name. **Golden Rule 1 unchanged**: current Anthropic guidance (15× tokens; fails where agents share context) argues *for* it.



- **A user message could be accepted and never delivered** — POSTed 12 ms before a turn ended, it returned 202 `injected: true`, was written to the transcript as `turn.user` and rendered to the user, and no `turn.started` ever followed. Reproduced: an async generator resuming from its internal `await` runs forward to the next `yield` on its own, so `TurnInputChannel` shifted the message out of `queue` and fulfilled a request the SDK had already abandoned — leaving it in neither `queue` nor `unconsumed`, invisible to `drainUnconsumed`, the whole no-message-is-ever-lost mechanism. Held in `inFlight` across the `yield` now and recovered by `close()`.



- **Brain "idle" while the footer said "Working…"** — the two indicators read different sources (`marvinState` vs `isSending`) and only the POST path ever cleared `isSending`; a turn re-attached via `attachLive` left it stuck true forever. `attachLive` gets the symmetric `defer`, and `onAnnouncement`'s `guard !isSending` now treats a set flag with no stream behind it as stale rather than swallowing every announcement for the rest of the session.



- **Spawn the CLI we resolved ([ADR-0093](./decisions/0093-spawn-the-cli-we-resolved.md))** — the plan-usage bars were still blank after ADR-0087 because that ADR fixed the *reporting* and not the *spawn*: MARVIN never passes the binary to the SDK, which resolves `claude` from PATH, and `enrichedToolPath` led with `/opt/homebrew/bin` → 2.1.92 (predates `unifiedWindows`). Measured: a probe got the field every time while **0 of 10 MARVIN turns that morning did**. The resolved CLI's directory now leads PATH, pinned by a test.



- **Canvas-only export ([ADR-0092](./decisions/0092-canvas-only-export.md))** — running `obsidian_init` wrote **34,463 files** into `graphify-out/obsidian/` and truncated MARVIN's file tree at its 20,000-entry cap. Three of my own changes lined up: ADR-0086 made `graphify-out/` visible, ADR-0091 added `exportGraphCanvas` but **never switched the call site** (so the 34k-note exporter still ran), and graphify has no canvas-only flag. Now the export stages in a temp dir and copies out just `graph.canvas`; the note exporter is deleted rather than left as a trap; and `graphify-out/obsidian/` is skipped by the tree as a belt.



- **Plans hub, graph canvas, and an input for the memory loop ([ADR-0091](./decisions/0091-vault-plans-canvas-and-the-memory-loop-input.md))** — `memory` and `backlog` each wikilink their notes; `.marvin/plans/` had **353 notes and zero inbound links**, invisible to the graph view and Dataview. `rewritePlansIndex` mirrors the memory index (title from the `# Plan —` heading, progress from checkbox counts, newest first). The graph export also emits `graph.canvas` — **one 1.5 MB file, 6,811 nodes** that Obsidian renders natively — so the vault gets the code graph without the 32k-note flood ADR-0090 filters. And `graph_save_result` (12 calls ever, 0 reflections) finally has a trigger: one nudge per turn on the first edit after 4 graph calls. Plus `graph_explain`, `graph_benchmark`, `graph_export_callflow`.



- **Vault live views + graph-note filter ([ADR-0090](./decisions/0090-vault-live-views-and-graph-note-filter.md))** — measured on the real project: the vault is already set up with 656 MARVIN notes (104 memory + 552 backlog, 152 wikilinks) but **0 code-graph notes**. The index note advertised Dataview filtering and shipped none, on a vault that has the plugin — it now ships three live tables (open backlog by severity, facts by type, recently resolved) when the plugin is enabled, and instructions when it isn't. And `graphify export obsidian` writes one note per node — **7,604 for MARVIN's repo, ~32k for this project** — so `graphify-out/obsidian/` joined the default ignore filters; the notes stay openable by link but no longer drown the graph view.



- **Obsidian server trusted, with a consent exception ([ADR-0089](./decisions/0089-obsidian-trust-with-a-consent-exception.md))** — `mcp__marvin-obsidian__` was registered in `sdk-runner.ts` but missing from the trusted MCP prefixes, so every vault call was confirm-gated as if it came from an untrusted plugin. Trusting it wholesale would have been wrong too: `obsidian_init` writes `.obsidian/` into the *user's* repo, which ADR-0065 makes an explicit opt-in. New `TRUSTED_MCP_CONFIRM_EXCEPTIONS` keeps `obsidian_status` on the fast path and `obsidian_init` on confirm.



- **Dispatch gated by shape, not just name ([ADR-0088](./decisions/0088-rename-canary-for-the-dispatch-tool.md))** — the `Task`/`Agent`/`system/init` discrepancy is not a runtime issue (nothing reads init's tool list, and the gate matches both from one set), but name matching is inherently one rename behind, and that is exactly what cost months of ungated dispatch in ADR-0079. An unrecognised tool whose input carries `subagent_type` is now treated as a dispatch — checked *before* the not-in-the-gated-set blanket-allow, run through the sanctioned-type ladder, and logged as `gate.unknown_dispatch_tool`. The auditor's disallow list now derives from the one set instead of re-listing it.



- **MARVIN was running a 159-versions-old Claude CLI ([ADR-0087](./decisions/0087-newest-claude-cli-and-reported-context-window.md))** — `discoverClaudeBinary` returned the first path that existed, so `/opt/homebrew/bin/claude` (2.1.92) beat the user's `~/.local/bin/claude` (2.1.251). Found by tracing why the plan-usage bars were blank: **6,589 `rate_limit_event`s ever recorded, zero with `unifiedWindows`**, while a probe on the same machine got it every time. The old CLI predates the field. Now resolves the newest by `--version` (per-component compare — `"2.1.251" < "2.1.92"` lexically), with `MARVIN_CLAUDE_BIN` still winning. Also: the context window now comes from the SDK's `modelUsage.contextWindow` rather than being inferred from the model id.



- **Toolchain bootstrap + update check ([ADR-0086](./decisions/0086-dependency-bootstrap-and-update-check.md))** — graphify was "advisory" in `doctor`, so a fresh machine ran Golden Rule 7 with no way to build a graph. `bin/marvin deps [check|install]` now installs the whole external toolchain and runs as part of `install-macos-app`; `bin/marvin graph-hooks` installs graphify's post-commit rebuild + `graph.json` union merge driver (verified: all three were missing on both repos). MARVIN also checks for a newer release daily and on demand — numeric version compare, `+sha` stripped, dev builds never told to downgrade, skip is per-version, and it never auto-installs because swapping the bundle mid-turn kills work in flight. Plus: a cancelled request no longer renders as a red "Fetch error … Code=-999" banner.



- **Graphify beyond search ([ADR-0085](./decisions/0085-graphify-beyond-search.md))** — MARVIN was using graphify as a search index (75 % of 5,823 calls were `graph_search`). Now: `graph_god_nodes` + `graph_diagnose` make graph health inspectable; `graph_index_schema` pulls a live PostgreSQL schema (tables/views/functions/FKs) into the code graph so structural questions cross the code↔DB boundary, with the DSN read from a named env var and scrubbed from every output path; `bin/marvin graph-hooks` installs graphify's post-commit rebuild + `graph.json` union merge driver, covering the gap where ADR-0041's watchdog only runs while the IDE is open; and `LESSONS.md` is injected into project context, giving the work-memory loop (12 saves, 0 reflections) its missing output side. The global cross-repo graph was rejected — it is exactly the cross-contamination Golden Rule 4 forbids.



- **Blast-radius + pre-ship graph triggers ([ADR-0084](./decisions/0084-blast-radius-and-pre-ship-impact-nudges.md))** — measured 5,823 graph calls: `graph_search` 75 %, `graph_affected` **0.4 %**, `graph_change_impact` **0**. MARVIN uses the undirected `graph_neighbors` 23× more than the directed blast-radius tool the prompt tells it to use. Two advisory nudges in the existing hook: before an un-analysed source mutation, and before the first commit/push/MR of a turn. Advisory with telemetry on purpose — ADR-0060 tuned a threshold blind and ADR-0083 had to fix it.



- **Graph-drift rail re-arms and escalates ([ADR-0083](./decisions/0083-graph-drift-rail-rearms-and-escalates.md))** — measured four real sessions at 8:1, 38:1, 13:1 and 15:1 reads-to-graph, all critical by MARVIN's own `ToolUseCounter` bands, with `graph_summary` at ~0 and `graph_affected`/`graph_change_impact` never called. The enforcement was firing correctly; the design was wrong — the ADR-0060 nudge budget was 3 **per turn** and the log shows it spent in five seconds, after which ~100 file ops ran unchallenged. A graph call now resets the budget (complying re-arms the rail), and 25 novel files with no graph query escalates to a single narrow deny that never touches mutators or files already in play.



- **Tabbed bottom panel (plan §D)** — Problems · Terminal · Preview · Graph as tabs instead of N booleans in an HSplitView. Toggling 1→2 panes used to swap view identity and destroy each pane's `@State`, and Problems was unreachable unless its status-bar pill was rendering. Every opened tab stays mounted (`keptMounted`, extracted from `LeftPane` with its measured focus-loop comment), so terminal scrollback survives a switch. Pure `BottomPanelState`/`Migration`: `activating` closes on the visible tab, `revealing` never does (a build task can't hide its own output), legacy booleans still written as a projection for rollback. ⌘J toggles the panel; ⌃` / ⌘⇧M pick Terminal / Problems. No Output tab — ADR-0078's real terminal is where build tasks run.



- **A real terminal ([ADR-0078](./decisions/0078-pty-terminal-in-process.md))** — persistent login shell on a pty spawned by the app (`POSIX_SPAWN_SETSID` + slave opened as fd 0 in the child = controlling tty, so Ctrl-C works — test-gated), SwiftTerm renderer, sessions owned outside the view so a pane toggle no longer kills the shell, credentials scrubbed from the shell env, build tasks type into the same shell, focus on click. Replaces the `$SHELL -c` command runner (`/api/terminal/run`, `ANSIParser`, `@xterm/*` deleted).



- **The terminal printed nothing — not even the exit line** — `TerminalPaneView` framed SSE with `for try await line in bytes.lines` and dispatched on `line.isEmpty`. `AsyncLineSequence` never yields an empty string. Proven against the live endpoint: real `pwd` response → 6 lines, **0 empty, 0 events dispatched**; through the new parser → 3 frames including `exit`. Framing extracted to `MARVINLogic.SSEFrameParser` (8 tests) and all four hand-rolled copies in `ChatService` + `TerminalPaneView` routed through it (−92 lines). Stop also worked for the first time: it cancelled a `URLSessionDataTask` that was declared and never assigned. Step 0 of the PTY plan — a real persistent shell is still to come.



- **AI-native SDLC playbook — selective adoption ([ADR-0077](./decisions/0077-ai-native-sdlc-selective-adoption.md))** — audited Anthropic's playbook against MARVIN and took the four items that close real gaps: (1) firm-surface evals in CI (`personality-surfaces.test.ts`) — `personality.ts` was 1800 lines of behavioural contract with zero coverage across 98 test files, so any firm surface could be deleted silently; (2) a test-weakening hard-deny, narrow enough that TDD is untouched (disable markers, commented-out assertions, edits that zero the assertion count); (3) a publish/release hard-deny, because `auto` strategy bypasses `confirm` and `gh release create` is not recoverable; (4) Golden Rule 1 now says a human steering N parallel sessions is not multi-agent dispatch. Rejected with reasons in the ADR: `intent.md`/`spec.md`/`plan.md` (already covered by roadmap + DoD + ADR + plan spine), PR gates (contradicts ADR-0067's stall measurement), sandboxing (user call), managed settings, Western Electric rules.



- **Colour pulled back up (user: "now way too faded")** — the fifth pass over-corrected. Text tokens moved to VS Code's real values (`#D4D4D4` fg / `#9D9D9D` muted, from `#CCCCCC` / `#8B8B8B`), Seti and SF file icons at full opacity (the 85 % dim was muting Seti's own baked-in colours), folder outline at `white 0.72`, git decoration colours one step more saturated than VS Code's defaults (`~#E8BD78` / `~#6BD18F` / `~#D95440`).


- **Tree metrics matched to VS Code exactly (user: "spacing too much, text too small")** — the earlier 22pt row frame never took effect because `List(.sidebar)` pads rows to ~28-32pt regardless (`defaultMinListRowHeight` is only a floor). The tree is now a `ScrollView`+`LazyVStack` with exact 22px rows, 13px text (VS Code's explorer size), 8px indent per level (`workbench.tree.indent` default) and a 16px twistie column. Folder icons are the outline `folder` glyph **tinted by git decoration** — that is what makes `apps`/`db`/`docs` read green/red/gold in Antigravity; it is the decoration colour on the icon, not a different icon set — and files keep their Seti glyphs at 16px.


- **Personality chip did nothing (user, 2026-08-29)** — `NativePrefs.setPersonality` still guarded `marvin || neutral`; `ultron` (the third voice, and the default) was rejected on write, so the footer's cycle `neutral → ultron` was a silent no-op and the chip looked stuck. The load path already accepted all three. Guard fixed. **Rail tooltips flaky** — `TooltipHitLayer.updateNSView` re-assigned `toolTip` on every SwiftUI update, and assigning it resets AppKit's tooltip timer; since hover itself triggers an update, the hover was cancelling its own tooltip. Now written only on change.


- **Topbar hairline + transparent brain (user, 2026-08-29)** — a 1pt `MarvinTheme.border` line now sits under the title bar (flat theme left the top edge undefined). The brain's `CAMetalLayer` was opaque and its trails faded toward a copy of the window colour, which read as a darker square once the chrome went flat; now the accumulation texture is premultiplied RGBA that decays to `(0,0,0,0)` (fade pipeline = pure decay: src×0, dst×(1−a) on all channels), the layer is non-opaque, and the clear colour is transparent — only particles are visible.


- **Mid-turn steering ([ADR-0076](decisions/0076-mid-turn-steering-streaming-input.md))** — user: "I can't keep sending messages once he starts working … on Claude desktop/CLI I can send as many as I want." Verified against the SDK docs: only *streaming input* mode supports queued messages; single-message mode (what every MARVIN turn used) explicitly doesn't. Every human turn now runs over a per-turn `TurnInputChannel` (AsyncIterable prompt); `POST /api/chat` on a live human turn persists the `turn.user`, pushes into the channel, emits it on the bus, answers `202 injected`. The runner closes the channel on a terminal `result` (nothing pending) so plain turns end exactly as before; unconsumed pushes are re-queued durably (ADR-0069 stays true). Native client sends immediately during a turn instead of parking locally. 5 channel tests; 762/762 green. **Not yet verified live** — needs a relaunch + a two-message test.


- **Launch crash, round two (user: "now marvin crashes again")** — no new `.ips` and no fatal exception in the log, but the ADR-0062 storm monitor fired **twice at every launch** in the left pane (150 invalidations / 0.5 s) with a captured stack: `SplitViewContentProvider.itemFor → _setDefaultKeyViewLoop → FocusBridge → NSHostingView.updateSize → setNeedsUpdate`, i.e. a split-view relayout ping-pong. Cause: `SplitViewAutosave` wrote `dividerStyle = .thin` on every SwiftUI update while SwiftUI's split view resets it on every layout — each undid the other. It shipped in the same build as the first crash and survived the re-classing removal, which is why "fixed" wasn't. The write is gone; the divider is whatever SwiftUI draws. Verification = a launch with **zero** storm reports in `exceptions.log`.


- **Launch crash, self-inflicted and fixed** — the 4th redesign pass re-classed SwiftUI's split view at runtime for a 1pt divider; that tripped AppKit's update-constraints breaker at launch (`NSLayoutConstraint for <_NSSplitViewItemViewWrapper>: Constraint items must each be a view or layout guide`) and the ADR-0062 crash logger then segfaulted in `_typeName` on the re-classed view. Re-classing removed (thin `dividerStyle` only), the split-view `.animation(value: panes)` removed (same loop class), and `CrashDiagnostics` now names views via `NSStringFromClass` so the logger can't die on a metadata-less class again. **Perf (user: "resizing is sluggish")**: `RichText` measured every message at every pixel of a drag (0.5pt-rounded cache key → miss per frame → full re-typeset); now buckets the width to 32pt while `inLiveResize`, exact again after. The brain's Metal loop drops to 10 fps during live resize. **Seti icons**: VS Code's icon theme vendored (`Resources/Seti/`, 59 SVGs + MIT license), `SetiIcon.swift` maps exact names + ~90 extensions, used by the file tree and SCM rows with SF Symbol fallback; `bin/marvin` copies the folder into the bundle.


- **Machine turn evicted a live human turn — "replaced by a newer turn on the same session" (ADR-0069 addendum)** — user screenshot 2026-08-28 22:3x: they sent a message while a background job ran; the job-completion wakeup then killed their turn with a "Stream error … Retry" banner. Root cause is a TOCTOU window: `fire`/`fireNow` run `deferIfSessionBusy` once, then `startScheduledTurn` awaits `buildProjectContext` (seconds) before `registerLiveTurn`, whose eviction branch — meant for "server crash / explicit replace" only — then aborted the human turn that registered in the gap. Fix: `deferIfSessionBusy` is exported and re-run at the registration point (before the `turn.user` append, so a deferred wakeup leaves no orphan prompt); `startQueuedTurn` gets the same guard and re-enqueues its drained text instead of registering. Regression test in `wakeup-scheduler.test.ts` pins that a human turn registered *after* the fire-time check still yields and the wakeup is re-armed, not lost. **Mid-turn steering (user: "I can't keep sending messages once he starts working")** is a separate, larger change — verified against the official SDK docs (`agent-sdk/streaming-vs-single-mode`): "Queued messages … with ability to interrupt" exist **only in streaming input mode**; single-message mode (MARVIN's per-turn `query({prompt: string})`) explicitly lacks "dynamic message queueing" and "real-time interruption". Needs ADR-0076: a persistent streaming session per chat with a push channel, `/api/chat` pushing into the live turn instead of `202 queued`, client sending immediately. Not started.


- **Sidecar drops the browser UI ([ADR-0075](decisions/0075-sidecar-drops-browser-ui.md))** — deleted `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, all of `sidecar/src/components/**` (72 files), 2 orphaned `lib/` helpers, and 3 tests exercising deleted components (~2,600 lines). The native macOS app was the only real client; a code audit found the browser-embedding `WKWebView` in `ContentView.swift`/`MARVINApp.swift` was down to a stale Phase-1a comment, not live code. The sidecar keeps every `/api/**` route + backend package — it's now a pure local API server for the native app, not a dual-UI shell. Native brain animation (`BrainMetalView.swift`/`BrainGPUSimulation.swift`, Metal) is untouched — it was always separate from the deleted web `components/brain/*.tsx`. Verified: `pnpm --filter @marvin/web typecheck` + `build` pass, `bin/marvin install-macos-app --bundled` succeeds end-to-end. Deferred: pruning now-orphaned deps (`@monaco-editor/react`, `@xterm/*`, `react-resizable-panels`, `tw-animate-css`, `@marvin/ui`) and the stale WebView comments — tracked in the ADR's follow-ups.


- **Antigravity-inspired native shell redesign — first pass landed.** New `MarvinTheme` (`MarvinTheme.swift`): flat near-black/near-white token palette (background/panel/border/text-primary/text-muted), adaptive light+dark via `NSColor(name:dynamicProvider:)` rather than system-derived colors — user chose adaptive over fixed-dark. Wired into: main window background, chat tab strip, messages surface, status tray, input box (now a rounded 10pt pill), file-tree background + row text + chevron, message-row role colors, and the title bar (`.toolbarBackground`, bundled into a `FlatToolbarBackground` ViewModifier after the naive two-modifier chain blew the type-checker's budget on ContentView's already-large body). **`LeftPane` navigation moved from a horizontal segmented control to a VS Code/Cursor/Antigravity-style icon-only activity rail** (44pt wide, tooltip for the name, left accent bar on the selected tab) — a direct ask mid-session, screenshot-driven. Verified: `swift build` clean, `bin/marvin install-macos-app --bundled` succeeds. **Second pass, from the user's screenshots ("the colors are very weird now"):** the first palette (`#0D0D0F`/`#111113`) over-separated surfaces and only covered the outer chrome, so the still-system-colored file viewer, status bar, code blocks and chips read as a patchwork. Re-sampled from Antigravity's own chrome — sidebar `#181818`, editor `#1F1F1F`, i.e. *nearly identical* fills with hairline borders doing the separating — and added `elevated` / `rowSelected` / `rowHover` tokens. Applied to every remaining surface: file viewer body + header/tab bars, `AppStatusBar`, markdown code blocks, tool-output boxes, and the user-message bubble — which was the big **navy block**: ADR-0038 background-job completions are injected as *user* messages, so the accent-blue bubble tint turned every job report into a navy slab; it's now a neutral lifted card. File-tree rows: 13→12pt, vertical padding 2→1, selection is a neutral `rowSelected` fill instead of solid accent. **Tooltips** (user: "we have no hover tooltips"): `.help()` on a `.plain` Button under overlays never surfaced; the rail icons are now their own view with `.help` on the icon itself plus an explicit hover fill. **Transitions** (user: "no transitions between panels"): one shared `MarvinTheme.transition` (180ms ease-out) on rail tab switches, rail hover, and pane toggles. **Third pass:** **Source Control** rebuilt to the VS Code/Antigravity shape (user: "source control also looks different") — commit composer moved to the TOP with a branch-aware placeholder and a full-width prominent Commit button; rows are now `icon · filename · dimmed dir path · status letter (M/U/A/D/R/C) on the right` instead of the two-column porcelain code on the left; sections are collapsible with count pills; and a new **Graph** section lists recent commits on a dot-and-rail (`GitHistoryService.repoHistory`, new — the service only did per-file `git log --follow` before). **Pane resizing** (user: "resizing … breaks the designs"): `SplitViewAutosave` now also sets `dividerStyle = .thin` on every NSSplitView it tags, and `WindowAccessor` sets `NSWindow.backgroundColor` to the theme fill so live-resize gaps stop flashing the system window color. **Fourth pass (from screenshots of the running app — now verified live):** the split **divider** was still a thick band because SwiftUI's split view re-applies `dividerStyle` on layout, so the instance is now re-classed at runtime (`ThemedSplitDivider`: ObjC-runtime subclass of whatever private class SwiftUI used, overriding `dividerThickness` → 1 and `drawDivider(in:)` → theme hairline). **Tooltips** on the rail still didn't fire via `.help()` even on the bare icon, so the rail buttons now carry an AppKit `TooltipHitLayer` (NSView with `toolTip` + tracking area + mouseDown) — tooltip, hover and click all native. **Top pane transition**: the editor cross-fades on file switch (`.id(selectedFilePath)` + opacity). **Tree density** (user: "Antigravity fits all files, MARVIN doesn't"): `defaultMinListRowHeight` 22 + fixed 22pt rows — `.sidebar` was padding every row to ~26pt. **SCM polish** vs the reference: compact growing single-line composer (`TextField(axis: .vertical)`), hover actions in VS Code order (open diff · discard · stage), graph rows show author with the SHA on hover, brighter rail. **Fifth pass (colour):** user: "colours on antigravity are a bit faded … in marvin they seem very bright" — git decorations moved off the system `.orange`/`.green`/`.red` to VS Code's muted palette (`#E2C08D` / `#73C991` / `#C74E39`), the boxed status badge became a bare letter (files) or a 6pt dot (directory roll-up), folders are outlined grey (`folder`, `textMuted`) instead of filled saturated blue, and file-type tints run at 85 %. **Icons (user: "I want the same icons Antigravity uses"):** those are VS Code's **Seti** icon theme — an icon font with per-language glyphs, not SF Symbols. Matching it properly means bundling the Seti SVGs (MIT) and mapping ~100 extensions — queued as the next contained task, not squeezed into this pass. **Sixth pass (crash + divider colour, 2026-08-29):** the fourth pass's runtime re-classing of SwiftUI's split view (`ThemedSplitDivider`) **crashed the app at launch** — `NSInvalidArgumentException: NSLayoutConstraint for <_NSSplitViewItemViewWrapper>: Constraint items must each be a view or layout guide` out of `-[NSSplitView _updateStackConstraints]`, three times in five minutes; the ADR-0062 logger then segfaulted in `_typeName` describing the re-classed view, which has no Swift metadata. Re-classing is gone. Divider colour now comes from a **drawing-only swizzle of `-[NSSplitView drawDivider:]` on the base class** (`SplitDividerTheme.swift`) — no new class, and `drawDivider` runs in the display pass, so it can't feed the constraint loop the way `dividerThickness` (layout input, deliberately untouched) would. SwiftUI's `Divider()` — `NSColor.separatorColor`, visibly lighter than the hand-drawn hairlines — is wrapped as `MarvinDivider` and swapped at 93 call sites; the ~22 `Divider()`s inside `Menu` / `.contextMenu` / `CommandGroup` builders stay native, since those render AppKit menu separators, not views. `objcClassName` in `CrashDiagnostics.swift` moved to `class_getName` so the crash path can never fault on metadata again. Verified live: clean build, app runs, zero fatal exceptions and one benign startup storm (was: crash on launch). **Seventh pass (icons identified, 2026-08-29):** the deferred "Seti icon port" was chasing the wrong theme. Antigravity is a VS Code fork but does **not** default to Seti — it bundles and defaults to **Symbols** (Miguel Solorio, MIT), which is why the hand-drawn Seti approximations never matched: Seti has *no folder icons at all* (`vs-seti-icon-theme.json` has no `folder` key), while Symbols has 72 keyed by folder NAME — `apps`→red, `db`→pink, `docs`→blue, `scripts`→red-code. That is the "their directories have also something else" from the side-by-side. Confirmed by reading the installed bundle, not inferred: `Antigravity IDE.app/…/extensions/theme-symbols`, `hidesExplorerArrows: false` (chevrons, as in the screenshot), no user `settings.json` so the bundled default wins. Ported: 204 file + 78 folder SVGs vendored to `Resources/Symbols/` (LICENSE alongside), 1237 lookups generated into `SymbolsIconMap.swift` by `scripts/generate-symbols-icon-map.py` (380 extensions + 649 filenames + 102 language ids + 106 folder names, vs the 60 hand-drawn Seti SVGs — which is why `.gitlab-ci.yml` used to render blank). Resolution follows the theme spec: exact filename → longest extension → language id → default. `SetiIcon.swift` and `Resources/Seti/` deleted. Git decoration no longer tints the folder ICON — the reference colours folders by glyph, and keeps the decoration on the name and the trailing dot. **Tooltip delay** (user: "appear slowly, like 2 seconds" → after a first attempt, "still taking 1-2 seconds and after that it works better, like almost instant"): registering `NSInitialToolTipDelay: 350` did NOT change the first-hover delay and was removed. MARVIN draws its own tooltip now (`HoverTooltip.swift`) — one shared borderless non-activating `NSPanel`, 300ms for the first of a session and instant within 1.2s of the last dismissal (the session feel the user said already worked), clamped to the hovered view's screen. `NSView.toolTip` is no longer used on the rail at all, which also retires the "sometimes I see them, sometimes I don't" bug: assigning `toolTip` reset AppKit's timer, and SwiftUI reassigned it on every hover state change. **Density** (user: "way smaller than Antigravity"): tree rows 22→24pt, text 13→14pt, glyphs 16→19pt (Symbols' SVGs carry ~3px of built-in padding in a 24 viewBox, so they need a bigger box to land at the same optical weight). Named constants on `FileTreeRow` since they move together. Note `node_modules` / `graphify-out` stay hidden from the tree on purpose (2026-08-15: 12,195 cache files ate 61% of the 20k entry cap and truncated the tree) — that difference from the reference is deliberate. **Eighth pass (left-pane resize, 2026-08-29):** user: "when I resize the panes … some icons disappear, some seem to go out of bounds" + "that pane … is sluggish, the right pane is fluid". Two distinct causes. **Layout:** all five panes stay mounted in a ZStack for state preservation, so that ZStack's minimum width is the WIDEST of the five intrinsic minimums; drag the split narrower than that and the enclosing HStack overflows, pushing the 44pt activity rail off the left edge — the rail was still drawing, just outside the pane (confirmed by sampling the user's screenshot: only a ~16pt sliver of each rail glyph survived). Fixed with `minWidth: 0` + `.clipped()` on the content and `.fixedSize(horizontal:)` on the rail, plus `.clipped()` per tree row so a deeply-indented row in a narrow pane clips instead of overflowing. **Cost:** an `NSImage` backed by an SVG re-rasterises the vector on every draw at an uncached size, and a `LazyVStack` redraws every row on every frame of a live drag — ~40 vector rasterisations per frame. `SymbolsIcon` now rasterises once per (icon, size) into an `NSBitmapImageRep` at the display's backing scale and the row drops `.resizable()`, turning each row's icon into a blit. `SplitViewAutosave` also stopped queueing a main-queue superview walk on EVERY SwiftUI update (one per frame during a drag) — a Coordinator flag retires the walk once it finds its split view. **Not changed: git decoration colours.** The user reported Antigravity showing green + orange where MARVIN shows only orange, but sampling both attached screenshots pixel-by-pixel found identical colour distributions and NO green in either — same band positions, same per-band pixel counts, so both crops are the same tree. The real behavioural difference, if it shows up again: every top-level folder in that repo has BOTH modified and untracked descendants (18 `M`, 16 `??`), and MARVIN's roll-up shows the highest-SEVERITY child (modified/orange) while VS Code's decoration service surfaces whichever decorated child it finds first, which can land on green. Waiting on a screenshot that actually shows the green before changing the rule. **Ninth pass (dividers for real, sidebar collapse, live-turn state, 2026-08-29):** **Divider colour, attempt 3 — and the first one grounded in evidence.** Attempt 1 re-classed the live split view (crashed at launch); attempt 2 swizzled `-[NSSplitView drawDivider:]` (safe but inert — the seams stayed black for a third report). A one-shot probe settled it: `drawDivider(in:)` was called **zero** times, and the hierarchy dump showed each divider is an `NSSplitDividerView` subview, 5pt wide with `thickness` 1.0 painted. Runtime introspection of that private class shows it is layer-backed (`wantsUpdateLayer` / `updateLayer` / `_backgroundLayer`) and owns a **`backgroundColor` property** — so there is nothing to redraw and nothing to intercept, only a colour to set. `SplitDividerTheme` now exchanges `NSSplitDividerView`'s own `layout` (guarded by a `class_copyMethodList` check that the class implements it ITSELF — exchanging an inherited `NSView.layout` would repoint layout for every view in the app) and writes `backgroundColor` when it differs. `layout` and not a one-time pass because `_updateDividerViews` destroys and rebuilds the divider views on every pane toggle. **Sidebar collapse** (user: "in antigravity the pane gets hidden, in marvin it remains at an exact size"): `LeftPane`'s `minWidth` dropped 200 → 45 (the rail) and a `GeometryReader` hides the content below ~110pt of content width — hidden, not removed, so all five panes keep their `@State` across a collapse. Clicking a rail icon while collapsed re-opens the pane (`SplitPaneResizer.expandIfCollapsed` walks up to the `NSSplitView` from the rail's own hit view and calls `setPosition(_:ofDividerAt:)`); previously the click switched the tab behind a zero-width pane and looked dead. **Session switch, part 2** (user: "switching sessions still cancels the agent's work"): the b05860c server-side fix HOLDS — verified by starting a real turn, aborting its SSE mid-flight the way a switch does, and watching the transcript grow 3.7 KB and reach `turn.completed` with no client attached. The remaining defect was presentational and just as damaging: `detachLocalStream` clears `isSending` and idles the brain when you leave, and NOTHING restored it on the way back, so a still-running turn rendered as a finished one. `attachLive` now restores the live-turn state on its first event — reaching that line IS the liveness signal, since `/api/chat/resume` yields nothing when no turn is live. Deferred: tool-call card tints, Backlog/Diagnostics panes, a real DAG layout for the Graph section (it's a linear rail), overlay-style scrollbars (the file tree's legacy scroller track is still visible when "show scroll bars: always" is set system-wide).


- **Switching sessions silently killed the turn you just left (`ChatPreviewView.swift`)** — `hydrate()` called the full `cancel()` on every session switch, which POSTs `/api/chat/cancel` for the session being left and force-aborts its live turn server-side (`turn-registry.cancelLiveTurn`). That directly contradicted `runDetachedTurn`'s own design ("runs the SDK to completion regardless of HTTP-request lifecycle") and the ADR-0043 announce/`attachLive` machinery already built to let a background-started turn survive being unwatched and resume when you switch back — a turn *you* started got none of that, it just died. Fixed by splitting `cancel()`'s local-only teardown into `detachLocalStream()` (stop consuming the stream, don't touch the server) and reserving the `/api/chat/cancel` POST for the explicit Stop button; `hydrate()` now calls the local-only path. Verified via `swift build`. No regression test added — `ChatPreviewModel` has zero existing test coverage and isn't currently DI-friendly (`ChatService.shared` is a bare singleton); adding that harness is out of scope for this fix.


- **SDLC leading/lagging metrics ([`scripts/sdlc-metrics.py`](../scripts/sdlc-metrics.py))** — prompted by Anthropic's [AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook). Read-only, git/gh/ADR-derived proxies: deployment frequency + lead time for changes from release tags, change failure rate + MTTR from ADRs that needed an addendum/correction (this repo's own rework signal), CI success rate from `gh run list`. Review cycle time deliberately not computed — MARVIN ships via FF push, not PR review. See [`docs/operations/sdlc-metrics.md`](./operations/sdlc-metrics.md). Baseline run (since 2026-06-01): 49 releases (~3.9/week), 279.9h median lead time, 12.3% ADR change-failure rate, 3.1-day median MTTR, 65% CI success rate. Not yet re-run on a second window to confirm trend — do that before drawing conclusions from the CI number.


- **Production monitoring loop — parked, not started.** The playbook's "Maintain" stage has monitoring agents autonomously detect control-band breaches and feed fixes back as `intent.md`. Deliberately deferred: an autonomous detect-and-fix agent is the shape Golden Rule 1 exists to prevent unless scoped tightly (read-only detect + backlog/roadmap write, human executes the fix — same posture as the session auditor, [ADR-0059](./decisions/0059-session-auditor-runtime-dispatched-read-only.md)). Needs its own ADR before any implementation.



- **"New session" killed the turn you left, and the screenshot proved the mechanism (`ChatPreviewView.clear()`)** — b05860c fixed `hydrate()` calling the full `cancel()` on a session switch, but left the identical defect in `clear()`, which is what the "New" button, ⌘⇧N, the tab strip's `+`, and closing the last tab all call. `cancel()` POSTs `/api/chat/cancel` → `turn-registry.cancelLiveTurn` → `abortController.abort()`, so starting a new chat aborted the agent still working in the old one. The user's screenshot named the failure exactly: `Tool permission request failed: Error: Stream closed` on an in-flight `Bash` — the abort tore down the SDK query while a `can_use_tool` control request was pending, so the tool call died with a transport error rather than anything about the tool. (The string is raised by the `claude` CLI binary, not by our code or the SDK's JS — grep found it in neither.) Note this is a DIFFERENT mechanism from the server-side one already verified healthy: a dropped SSE stream does not stop a turn (tested — transcript grew 3.7 KB after the abort and reached `turn.completed`); an explicit `/api/chat/cancel` does. `clear()` now uses `detachLocalStream()` and idles the brain locally; `cancel()` has exactly one caller left, the Stop button. Verified by `swift build`; **deliberately not installed** — the user had MARVIN mid-turn and asked for the fix without a new version.



- **Left-pane resize storm — mechanism found, not guessed (2026-08-29)** — the user reported the file-browser split "sluggish, not fluid" a second time after the icon-rasterisation and `SplitViewAutosave` fixes. The ADR-0062 storm monitor had the answer in the log: **5 storms since launch, all on the left pane's `NSHostingView`**, 150 invalidations per 0.5 s, stack `SplitViewContentProvider.item(for:) → _recursiveSetDefaultKeyViewLoop → FocusNavigator.allItems → NSHostingView.updateSize → setNeedsUpdateConstraints`. SwiftUI's split view rebuilds the focus key-view loop on every resize step by walking EVERY focusable item in the pane — and `LeftPane` kept all five tabs mounted at `opacity(0)`, so the walk covered the file tree, search, source control, skills and plugins on each frame, which resized the hosting view, which rebuilt the loop again. The right split has a fraction of the focusables and never stormed. Fix: inactive panes stay mounted (their `@State` survives tab switches, the reason opacity was chosen) but are now `0×0`, `disabled`, non-focusable and accessibility-hidden — no layout, no focus items. Verification is the storm counter across a drag on the next launch. Also: **rail aligned to the pane header** — `MarvinTheme.paneHeaderHeight` (38pt) is now shared by the file-tree title row and the rail's top inset, so the first icon centres on the "project name" strip as in VS Code / Antigravity (was an 8pt inset against a taller header). And **image attachment chips show a thumbnail** (one cached, downscaled decode per path — a 5 MB screenshot must not be re-decoded per keystroke) and **click opens Quick Look at full size** via the existing `QuickLookCoordinator`.



- **Graphify review + new bridge tools (2026-08-29)** — graphify is current (0.9.51 = PyPI latest; `uv tool upgrade` had nothing to do) and the skill content is byte-identical between 0.9.48 and 0.9.51, so there were no new skill features to adopt. Reviewed graphify.com (the vendor — `.net` is an unaffiliated directory selling its own "Graphify AI" workspace; the vendor says "we host nothing"), the v8 README, the MCP tools reference, and the enterprise/verification pages, then weighed each capability against MARVIN. **Built:** (1) `graph_change_impact` — diff-level blast radius. The vendor's flagship review feature (`graphify prs`, `get_pr_impact`, `triage_prs`) shells out to `gh` on every call and is GitHub-only; the project MARVIN works on is on GitLab. Every piece it needs already existed here — `git diff` for files, `graph.json` `source_file` for symbols + communities, the ADR-0066 directed call cache for who reaches in from OUTSIDE the branch — so it is forge-agnostic by construction (`change-impact.ts`, 4 fixture tests, wired into the `pr-review` skill and the Phase 3 MUST list). MR-vs-MR overlap (`--conflicts`) deliberately not built: needs the forge API and one branch at a time is the observed workflow. (2) `graph_community` — the official server's `get_community`; `graph_summary` named clusters it couldn't open. (3) `graph_query` `context` filter passthrough (`--context`, repeatable). **Rejected, with reasons:** swapping the bridge for the official MCP server — ours has `scope:"knowledge"`, the `save_result → reflect` work-memory loop, and a *directed* `graph_affected` (theirs is undirected `get_neighbors`); shared HTTP serve + git hooks — single user, and MARVIN already refreshes per turn (ADR-0041); `global add` — cross-project contamination (Golden Rule 4); formal verification — enterprise-only, self-hosted GitHub App, not in the OSS CLI; "SQL over the graph" — does not exist (BFS/DFS `query` only; Neo4j/FalkorDB Cypher *export* needs a running DB). **Spike, not adopted:** `extract --postgres DSN` — maps tables/views/functions + FK edges from a live DB; directly relevant to the ownership work, but the `[postgres]` extra is not installed, it runs only on full `extract` (not the per-turn `update`), and whether its nodes survive an `update` is unverified. Try on the dev DB first. Note: agri's graph already carries 649 nodes from Flyway `.sql` migrations via the built-in SQL grammar. **Found and fixed while verifying live:** `graph_affected` (ADR-0066) had been printing raw cache ids instead of names on agri since it landed — the AST cache keys callers as `<file-stem>_<class>_<member>` while graph.json keys the same node as `<full-path-slug>_<class>_<member>`, and exact lookup matched **8 of 17,142** caller ids (0.0 %). `nodeLabelResolver` in `read-graph.ts` now falls back to a suffix match among nodes sharing the member name and refuses a tie; both `graph_affected` and `graph_change_impact` use it. Live on agri's real branch: 40 files → 319 symbols → 83 external callers in 3.7 s over 433K call edges, names resolved.



- **Context-cost reduction — governor, ADR index, job excerpts, dynamic effort (2026-08-29)** — measured on a real 158K-token session (14 compactions): 58K was fixed cost before any message and the rest was mostly the session re-digesting itself. Four changes, each pinned to a measured number. **(1) Output governor** (`output-governor.ts`, new): a `PostToolUse` hook using the SDK's `updatedToolOutput` — the same plumbing the design hooks use on `PreToolUse` — caps any Bash result over 6K chars to head (2.5K) + tail (2.5K) + an elision marker naming the exact cut, with the full text written to `~/.marvin/tool-output/<session>/<toolUseId>.txt` for the model to Read/grep on demand. The CLI already does this itself, at ~655 KB; a 15.7K-char Spring log (3.9K tokens) and a 4.8K-char surefire dump had sailed through. Bash only, deliberately — `Read` has `offset`/`limit` and governing a file the model chose to read second-guesses a deliberate act. `MARVIN_OUTPUT_GOVERNOR=off` disables. **(2) ADR index → `<number> <title>`** (`project-context/src/index.ts`): the path was the title again as a slug, 54 chars/line against a 76-char title; on the 365-ADR project the block cost 12.6K tokens on the first turn of EVERY session where 7.7K carries the same information. Lossless — the file is `<dir>/<number>-*.md` and the graph resolves the number. A recency filter was considered and rejected: 303 of 365 ADRs were touched in the last 90 days, so it filters nothing. **(3) Background-job excerpt** (`background-jobs.ts`): 8 KB rolling tail → 1 KB head + 2 KB tail with an `…[N bytes elided]…` seam. The tail of a `make smoke` is Hikari shutdown noise after `System.exit(0)`; the head is where a build announces its failure. ~2.2K → ~0.8K tokens per job wakeup. **(4) Dynamic effort** (`effort.ts`, new — the ladder moved out of `sdk-runner` because the scheduler and job runner import it and `sdk-runner` imports them): the user's picker is now a CEILING. `schedule_wakeup` takes an optional `effort` so the model can arm a check-and-report turn at `low`; a background job that SUCCEEDS wakes the session one rung down (`stepDownEffort`), a job that FAILS keeps the ceiling; `clampEffort` at fire time is the guarantee that "less" is the only direction. Turns at `max` were carrying a full thinking budget plus a ~1.6K-char signature per step to read a job's output and say "green, continuing". Not touched, with reasons: compaction summaries (SDK-owned, 6–7.4K each — they shrink only by filling the window slower, which 1–3 do), and the two largest prompt sections (Graphify protocol 4.5K, 8 phases 4.5K) — firm surfaces, trimming them blind is how rules stop firing. `tsc` clean ×3; 111 tests green incl. 14 new. **Graphify** bumped 0.9.48 → 0.9.51 (skill re-installed, backed up first): release notes 0.9.48–0.9.51 are fixes only — nothing MARVIN's bridge should adopt. Existing-but-unused capabilities noted for later: `extract --postgres DSN` (live schema → graph; relevant to agri's ownership work), `check-update` (cron-safe re-extraction flag), `reflect --half-life-days`, `global add`.



- **Backlog near-duplicate gate scored only the first 60 characters of a title (`backlog.ts`)** — `significantTokens` tokenised via `slugify`, which exists to build FILENAMES and truncates at 60 chars. Every title longer than that was compared on its prefix alone. Caught on the 2026-08-29 ownership-repair incident, where MARVIN filed 10 items and the ADR-0070 gate refused 2 of 3 near-duplicates but missed a third: "Audit SECURITY DEFINER functions in public now owned by BYPASSRLS agricore_migrate post-ADR-0363 transfer" vs "SECURITY DEFINER function ownership escalated agricore_app→agricore_migrate on V202608281000 routine transfer" — the same finding, but every token proving it (`agricore_migrate`, `V202608281000`, `ADR-0363`, `transfer`) sits past character 60. Measured, not inferred: 0.43 truncated → 0.55 on full titles, against a 0.75 threshold. Fixed by tokenising the whole title, plus an `IDENTIFIER_OVERLAP_BONUS` (0.25) for pairs sharing **two or more** domain identifiers — SCREAMING acronyms, `V…`/`ADR-…` stamps, snake_case names. Two, not one, because `agricore_app` appears in a third of that project's titles. The missed pair now scores 0.80; the two genuinely distinct pairs from the same session sit at 0.09 and 0.15 and share at most one identifier, so neither moves. 3 regression tests on the real corpus; 67 backlog tests green.



- **Provisional review had a one-click bypass (`BacklogPanel.swift`)** — ADR-0047 leaves capture un-gated on purpose and puts the bloat control at the keep/dismiss review, then the panel offered "Keep all" / "Dismiss all" as bare buttons. On 2026-08-29 eight auto-captures were promoted to `open` in a single click two minutes after capture (all eight files share an `updated` timestamp), with no per-item judgement — the control reduced to a rubber stamp. Both bulk actions now confirm, naming the count and what the action means; "Dismiss all" is marked destructive. Provisional rows also show the item's `kind` badge, since "bug or chore?" is exactly the question that decides keep vs dismiss and the review row was the one place it wasn't shown. Capture itself is unchanged — it worked: 7 legitimate findings, each citing a file, migration version or prod observation.



- **Simplicity + surgical-edit firm surface in `personality.ts`** — reviewed `multica-ai/andrej-karpathy-skills` (MIT, one skill, four principles) and adopted two of the four as prompt-level rules rather than installing the plugin: its trigger is "when writing, reviewing, or refactoring code", i.e. every turn, so as a skill it is either always-on duplication or never fires. **Taken:** *Simplicity First* — the only prior coverage was one soft line (`Don't over-engineer`), the exact shape the 2026-05-22 skill audit found fires ~0×; it is now an enumerated MUST-NOT list (features beyond the ask, single-call-site abstractions, unrequested configurability, error handling for impossible states, new file when one exists) plus a senior-engineer rewrite test and an anti-trigger so it can't be used to under-deliver on a DoD bullet. **Taken:** the *Surgical Changes* clauses MARVIN lacked — no drive-by edits to adjacent code/comments/formatting, match the file's existing style, delete only the orphans your own change created and merely MENTION pre-existing dead code. **Rejected:** *Think Before Coding* ("if something is unclear, stop and ask") — it would undo ADR-0067, whose measurement was 33.1 h of a 49 h session spent waiting on the user with ~90 % avoidable; Karpathy's post describes models that barrel ahead, MARVIN's measured failure was the mirror image. **Rejected:** *Goal-Driven Execution* — already Phase 5a's Definition of Done, stated more strictly. 59 lines; `tsc --noEmit` clean; CLAUDE.md firm-surfaces table updated.



- **Plan file duplication + repairing inflated step state ([ADR-0068](decisions/0068-plan-dedupe-provenance-and-negative-claims.md) addendum 3a/3b)** — two halves of the same defect. **(a)** `PlanFile.render` injected a step's reconciled sub-tasks under its line AND echoed the model's own nested bullets for the same items, duplicating every sub-task in the saved file (9 redundant lines in one plan). The injected copy now wins — it carries live status — and suppression is limited to *indented* lines so a real top-level step can never be swallowed. **(b)** `redriveSteps` repairs plan state built by the old parser, applied at hydration: lossless, because stored steps are in document order, so a promoted bullet is demoted under the step it sat below with its status intact. Dry-run on the real state: `12 stored -> 6 top-level = REPAIR`; healthy plans `leave untouched`. 11 new Swift assertions.



- **Model and UI disagreed on what a plan "step" is ([ADR-0068](decisions/0068-plan-dedupe-provenance-and-negative-claims.md) addendum 3)** — MARVIN reported "Plan complete — all 6 top-level steps verified done" while the strip showed **"1/12 · Paused"** on the same plan. The model reads the plan FILE; the strip renders plan STATE; they disagreed on the step count. Cause: `PlanParser.stepRE` starts `^\s*`, so ANY indentation matched and every nested sub-bullet was promoted to a top-level step — **66 "steps" found in a file with 6**. Fixed by anchoring step *counting* to top-level markers only, in the single place steps are enumerated. `PlanFile.render`'s checkbox overlay is deliberately untouched (it should mark nested lines), and a fallback keeps fully-indented plans working, since parsing to zero steps is worse than over-counting. Noticed but not fixed: that same file had accumulated the same sub-task block 4-5x — the render appends unmatched steps, so files collect repeats independently of the state-side dedupe.



- **Layout-loop crash: culprit view identified, pass counter armed ([ADR-0062](decisions/0062-update-constraints-loop-identified-mitigated.md) addenda)** — the newly-armed `_crashOnException:` hook produced the **first capture in 11 days** (2026-08-18 20:43). Of 401 views in the window, exactly **one** was still dirty: `AppKitWindowHostingView<ModifiedContent<AnyView, RootModifier>>` (constraints=40, needsUpdate=true) — the SwiftUI **root** hosting view, wrapped in `AnyView`, with 4065pt of content in a 1320pt window and 37 `NSHostingView<AnyView>` list cells beneath it. Still NOT fixed, deliberately: the tree names which view won't settle, not who keeps dirtying it, and guessing from view-type names is how this ADR already produced two disproved fixes. So a `ConstraintStorm` monitor now swizzles `setNeedsUpdateConstraints:`, counts invalidations in a 0.5s window, and at 150 (below the ~401 needed to trip AppKit's breaker, so it fires BEFORE the crash) logs the view, its ancestry and the **call stack of whoever asked** — turning "which view is dirty" into "which of our code dirtied it". `ChatPreviewView.trayRows` (builds `[AnyView]`) is the leading suspect but is inference, not evidence.



- **Layout-loop crash: instrumentation was blind, now armed ([ADR-0062](decisions/0062-update-constraints-loop-identified-mitigated.md) addendum)** — two crashes on 2026-08-18 (02:04, 02:21), identical `EXC_BREAKPOINT` stacks, pure AppKit layout, only `main()` frames of ours. Same non-converging Update-Constraints loop, captured once on 2026-08-07 as `NSGenericException: … more Update Constraints in Window passes than there are views in the window <SwiftUI.AppKitWindow>`. **The ADR-0062 hook had never fired — 24 session starts, 0 captures** — because it swizzles the INSTANCE method `reportException:` while AppKit's layout path calls the CLASS method `+_crashOnException:`. The stamp claiming "exceptions are logged and survived" was false for exactly the crash it was built for. Now: `+_crashOnException:` swizzled too (selector verified to resolve), the **view tree dumped with the exception** so the next occurrence names the offending view rather than another stack-inferred guess, and the stamp corrected. Root cause still OPEN — this buys evidence, not a cure. Ruled out this time: plan rendering (plans live at crash held 4-5 steps, 0 sub-tasks) and RichText (already measures offscreen).



- **User messages were being silently dropped ([ADR-0069](decisions/0069-never-drop-a-user-message.md))** — MARVIN runs one turn per session, and machine-initiated turns (wakeups ADR-0031, background-job completions ADR-0038, auto-reconcile, transport auto-continue ADR-0067) hold that slot like any other. A user message arriving during one got `409 turn-in-progress` and was **discarded**. Observed 2026-08-17: a wakeup fired at 22:19:20, the user sent "Update graphify and check what else needs to be updated", a second wakeup fired at 22:20:13 — and the instruction never ran (confirmed: 150 `turn.user` records in that session, none of them that message). Two machine turns talked past the human for 76 seconds while a stale 409 banner offered a Retry button that cannot work. **"Just preempt" was unavailable** — the 409 was itself the fix for blind eviction "silently orphaning a possibly-heavy in-flight turn". So: the message is now **persisted to disk before any scheduling decision** (input loss impossible, including across a crash), and preemption is gated on **observed behaviour rather than turn kind** — `machine && !mutated`, with the mutation flag set in the permission gate the instant a write is *allowed*. That automatically protects auto-continue turns, which are machine-started but resume real implementation work. Plus: drained messages coalesce into one turn, staleness is surfaced (turns here run 5+ minutes), and machine turns are now **rate-limited** (ADR-0031 bounded depth and pending count but never rate — the two colliding wakeups were 53s apart). Deliberately left: the macOS client still shows raw 409 JSON + Retry and should retain composer text until the server acks.



- **Plan corruption + false-fabrication claims ([ADR-0068](decisions/0068-plan-dedupe-provenance-and-negative-claims.md))** — MARVIN reported that an injected plan checklist "isn't a tracked plan; it never was" and that several items had "zero evidence anywhere — treat as fabricated". Both false: the plan is `.marvin/plans/grouped-backlog-fix-pass.md`, the session's own `activePlanId`, and every "fabricated" item is in it (`make dev-reset` line 149 and a real Makefile target; Docker force-kill line 291; Playwright triage 15x). The user was one step from discarding genuine merged commits. But the suspicion was earned — the plan really is corrupt: **347 checkbox bullets, 24 duplicated texts, 14 IDs reused for different work, 7 bullets both checked and unchecked**. Cause: `mergeSubtasks` matches on equality-or-containment and APPENDS when both fail, so a reworded restatement becomes a second row, accumulating across sessions with no reset. Fixed three ways — `sameWork` (40-char shared-prefix match; validated on the real file, 347 to 277 bullets, and the four least-similar merges hand-checked as genuine restatements), `dedupeSubtasks` repairing existing plans on every reconcile (order-preserving, idempotent, last-status-wins so undone work is never marked done), and **provenance** in the injected block (`id` + `source:` path) so verification is one read instead of a 303-file scan. Plus a new firm surface: a failed search is a fact about the search, not the world. **Correction, same day:** "plans never reset between sessions" was wrong and unchecked — exactly one plan-state file holds this plan, in a **single 57-hour chat thread** (Aug 15 08:23 -> Aug 17 17:05). It accumulated *within* one session, so a session-boundary reset would have prevented none of it. The real cost was what the model saw every turn: 336 sub-tasks, 61% already completed, **36,694 chars / ~9,173 tokens injected per turn**. `PlanContextBlock` (moved to MARVINLogic so it is testable — it had none) now collapses a step's completed sub-tasks to `N of M complete` past a threshold of 3: **56% smaller, ~5,100 tokens saved every turn**, with original numbering preserved and the header stating that a summarised item IS done. Still open: the block renumbers sub-tasks positionally instead of carrying the model's own tags, and a 336-sub-task plan is arguably not one plan (a size guard is the remaining structural idea).



- **Verify ADR-0067 on the next long plan** — the scope-boundary gating change is prompt-level, so it can't be unit-tested. Re-run `scripts/session-time-breakdown.py --latest <projectId>` after the next multi-day plan and compare the four-way split against the 2026-08-17 baseline (17.8 h stopped-with-no-question / 6.7 h asked-in-scope-permission / 5.1 h dead-on-transport-error / 3.4 h legitimate). Success = the first two rows shrink and the "resume the ACTIVE plan" macro count reaches 0; the total span is NOT the metric. If the helpful spiral returns instead, ADR-0067 is the first thing to re-examine.


- **106 rate-limit events in one session (unexamined)** — surfaced by the same analysis. They inflate the 15.9 h of "working" time and nothing currently measures their cost or whether MARVIN backs off well. Measure before optimising.


- **Re-measure graph:file ratio (ADR-0060 empirical follow-up)** — the drift nudge cannot self-verify (no deterministic way to know a read *should* have been a graph query). Re-run the transcript analysis over the next few real sessions; if the ratio hasn't moved off 1:5–1:11, lower `GRAPH_DRIFT_NOVEL_FILE_THRESHOLD` rather than restore the hard block. **Partly answered 2026-08-15:** `graphify benchmark` puts the graph at **27.5×** fewer tokens per query than naive full-corpus reads on this repo — the *value* side is now measured (CLAUDE.md's long-quoted "~36×" never was). The *behavioural* side — whether MARVIN actually reaches for the graph first — still needs the transcript pass.


- **Rich chat rendering + clickable output (uncommitted, in local build)** — assistant text now renders as real markdown (headings, fenced code with tree-sitter highlighting, pipe tables via a custom `Layout`, lists, quotes) instead of literal syntax, and URLs + `path/File.swift:61` references are clickable: web links open the browser, file refs open in MARVIN's editor and scroll to the line. Link detection lives in `MARVINLogic/ChatMarkdown.swift` (`MarkdownLinks`) so it is unit-pinned; only paths that resolve under the project workDir become links, so there are no dead ones. Prose blocks render through `RichText` (an `NSTextView`) rather than SwiftUI `Text`: `.textSelection(.enabled)` and links are mutually exclusive in `Text` — the I-beam wins over the whole run, so links never advertised themselves — while `NSTextView` gives pointing-hand cursors, `clickedOnLink`, and selection together. **Hang regression, found and fixed (2026-08-01):** the first `RichText` answered `sizeThatFits` by resizing the live text container and calling `ensureLayout` — which invalidates the layout, so SwiftUI's repeated width probes re-typeset the whole string each time. Nested in stack layouts it went pathological: MARVIN froze for 551s on the main thread, sampled inside `NSLayoutManager` → ICU line-breaking (`.hang` report 22:27:53). Measurement now goes to a shared offscreen text stack memoised on (text, width); a stress render that never completed in 400s now takes 130 ms. `MARVIN_SNAPSHOT_REPEAT=N` keeps that measurable. The `MARVIN_SNAPSHOT_MD` harness also moved off `ImageRenderer` (which substitutes a placeholder for any `NSViewRepresentable`) to an offscreen `NSHostingView` + `cacheDisplay`, restoring pixel-accurate verification.

_When a work item lands, move its line out of this section into a dated `## Recent milestones` entry (with the cask + tag + ADR if any)._



- **Editor AI smart actions + IDE gap analysis** — right-click a selection in the file viewer for **Explain this code · Review & improve · Generate docstring · Add selection to chat**. Each anchors the prompt to `file:line` so the reply's citations are clickable, appends to the native context menu rather than replacing it (Cut/Copy/Paste survive), and falls back to the whole file when nothing is selected. `review` and `docstring` are read-only-first: a context-menu click carries no confirmation step, so they propose and wait. Companion research at [`docs/reference/ide-feature-gap-2026-08.md`](reference/ide-feature-gap-2026-08.md) — MARVIN already matches Cursor/VS Code on the *hard* parts (agent, multi-file review, codebase context, MCP); the gaps are concentrated in editor-level interaction. Next up there: AI commit message, fix-from-diagnostic, inline edit (⌘K). Deliberate non-goals recorded too — ghost-text Tab completion needs a second fast model provider off the Agent SDK hot path, which cuts against the local-first trust model.



- **Obsidian vault — the project directory IS the vault ([ADR-0065](decisions/0065-obsidian-vault-project-as-vault.md))** — measuring first changed the answer: one real project already held **819 markdown files MARVIN wrote** (79 memory facts, 437 backlog items, 303 plans), all with frontmatter Obsidian reads as properties. A vault is just a folder with `.obsidian/`, so content and container both existed. The actual gap was **links** — all 79 memory files had *zero* `[[wikilinks]]`, so the graph view would have shown 819 disconnected dots. Markdown links render in Obsidian but create no graph edges, which is why the index would have *looked* connected while the graph stayed empty. Both indexes now emit wikilinks; `obsidian_init` writes `.obsidian/` + a `MARVIN.md` front door and exports the code graph as notes. Opt-in and non-destructive: never created unasked, an existing vault's settings are merged not clobbered, a corrupt `app.json` is left alone, and MARVIN edits nothing outside `.marvin/`, `MARVIN.md` and `graphify-out/`. Phase 2 (MARVIN reading your own notes as context) deliberately unbuilt — it hits the ADR-0041 context budget and needs a consent model.

### Honeycomb MCP integration for observability — SUPERSEDED (ADR-0054 §3)

~~Would register as `marvin-honeycomb` and expose trace querying as tools the executor could invoke while debugging production issues.~~ Superseded by the plugin platform: the honeycomb **plugin** ships the skills + read-only agents (ADR-0054), its MCP server arrives confirm-gated via ADR-0053, and team-specific config stays in the user's `~/.claude` / `<workDir>/.marvin` — the [isolation contract](./concepts/isolation-contract.md) holds with no MARVIN-side Honeycomb code at all. Enable the `honeycomb` plugin per project instead.

### Test coverage beyond the write-channel security layer

The Vitest harness covers `fs-sandbox` / `fs-write-policy` / `fs-constants` / `fs-write-confirm-registry` and the new Swift logic targets (`MARVINLogic`, `MARVINTests`). The Agent SDK interaction loop, the React/SwiftUI shells, and individual API routes remain uncovered — still opportunistic. See [Testing](./development/testing.md).

### Session audit: progress streaming + automatic triggers (ADR-0059 follow-ups)

Two known rough edges, both deliberate v1 cuts. **Progress streaming:** the audit runs as a single opaque `await` — the button spins for minutes with no feedback (a real ~3-minute run on agri-saas looked like a hang). The auditor session already streams events; `runSessionAudit` just discards everything but the final text. Fix is to emit tool-call/turn events to the UI plus an elapsed timer, a cancel button, and a guard against launching a second audit while one is in flight. **Automatic triggers:** plan-completion and scheduled audits behind default-OFF settings, held until manual use proves the audit is worth firing unattended.

### File tree: migrate OutlineGroup → NSOutlineView (ADR-0056 durable fix)

SwiftUI's `OutlineGroup` has needed **four** crash patches on the file tree (ADR-0056) — it's structurally fragile for a large, per-turn-replaced, agent-mutated tree, and loses expansion state on every structural change. The durable fix is a custom `NSViewRepresentable` around `NSOutlineView` owning its own diffing/expansion/selection (anticipated by [ADR-0018 §5](./decisions/0018-native-file-tree.md)). **Trigger:** if the crash recurs after ADR-0056's whole-tree-id fix, do this — no fifth OutlineGroup band-aid. **Blocker:** ~800-line AppKit rewrite that needs interactive visual verification, so it's a deliberate standalone piece, not a same-change follow-on to the crash fix.

### Real Developer ID + notarization

Today's `bin/marvin install-macos-app` produces an ad-hoc-signed `.app`; first launch needs right-click → Open. Real Developer ID + notarization removes the Gatekeeper warning and unlocks a pre-built signed `.app` distributed via GitHub Releases. **Blocker:** requires an Apple Developer account (~$99/yr) and CI plumbing for notarization.

## Deferred (blockers, not capacity)


## Not planned

Things MARVIN deliberately won't do. See [Vision](./business/vision.md) for the reasoning.

- Multi-agent orchestration ([ADR-0001](./decisions/0001-single-assistant.md)).
- Cross-platform desktop (Windows / Linux).
- Hosted SaaS with shared state.
- Cross-project memory.
- Broad "auto-mode heuristics" that switch models based on guessed complexity ([ADR-0002](./decisions/0002-default-to-opus-4-7.md)).

## Related

- [Changelog](./history/CHANGELOG.md) — chronological record of what shipped, when, and why.
- [Vision](./business/vision.md) — what MARVIN is trying to be.
- [ADRs](./decisions/) — material decisions.
