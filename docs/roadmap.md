# Roadmap

What's in flight, what's deferred, and what MARVIN deliberately won't do. The chronological record of what shipped, when, and why lives in [`docs/history/CHANGELOG.md`](./history/CHANGELOG.md). Material decisions live in [`docs/decisions/`](./decisions/).

## In flight

_Active work. Add a one-line entry when a piece of work starts; move it out (to CHANGELOG, with the date) when it lands._

- **Skills and plugins can be updated, not just installed ([ADR-0071](decisions/0071-install-provenance-and-update-path.md))** — MARVIN could install a skill (ADR-0039) or a full plugin (ADR-0053) but never pull a newer version of either. The panes' `refresh()` re-read the **local** index; `install-skills.sh` explicitly *skips* anything already present; re-installing from the same URL worked but only if you remembered and re-typed it. The blocker wasn't a missing button — it was missing provenance: `registerInstalledPlugin` recorded `scope/installPath/version/installedAt/lastUpdated` and **no clone URL**, and skills recorded nothing at all, so an updater had no source to re-clone. Now every install writes where it came from — `.marvin-source.json` inside the skill folder, and a MARVIN-owned sidecar registry for plugins (deliberately NOT a new key in the co-owned `installed_plugins.json`, which the Claude Code `/plugin` UI also writes). "Is upstream newer?" is a content hash, not a version string: skills have no version field, and plugins routinely ship changes without bumping theirs. Identity is name **AND** repo-relative path, because by name alone a rename and a deletion are indistinguishable — a test caught the first implementation installing a *different* skill over the user's when upstream deleted theirs. Two CSRF-guarded routes (`/api/skills/update`, `/api/plugins/update`) with `checkOnly`, single, and bulk modes; both panes get Check-for-updates + per-row Update; sourceless skills get a one-time "Set source" (the backfill path, since there's nothing to migrate *from*). Also closes two gaps that fell out of the same hole: superseded plugin cache versions are now pruned behind a paranoid path guard, and `lastUpdated` is finally read. 24 new tests.

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

## Current version

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

## Recent milestones

The high-water marks. Diagnostic detail per release in the [changelog](./history/CHANGELOG.md).

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

## Deferred (blockers, not capacity)

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
