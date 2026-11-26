# ADR-0044 — Project backlog: a durable parking lot for deferred work

**Status:** Accepted — 2026-06-19
**Touches:** new `backlog.ts` + `backlog-mcp.ts` (runtime), `sdk-runner.ts`
(register the `marvin-backlog` MCP server), `project-context/src/index.ts`
(first-message injection), `personality.ts` (firm-surface row + scope-met
handoff), new `GET/POST/PATCH /api/backlog` routes, macOS `BacklogService` +
`BacklogPanel` + a tray count chip, `.gitignore`/docs note. Sits beside — and
deliberately distinct from — durable-facts memory ([ADR-0042](./0042-memory-as-durable-facts.md)),
plans ([ADR-0036](./0036-autonomy-modes.md)), and the Definition-of-Done /
"noticed in flight" handoff (Golden Rule 8).

## Context

MARVIN's own working loop keeps generating good deferred-work items it then
*loses*. The Golden-Rule-8 handoff makes MARVIN list **"noticed in flight, not
in scope"** follow-ups and ask the user — but those items live **only in chat
scrollback**. MARVIN holds no state between sessions (Golden Rule 4), so the
moment the session ends the insight is gone unless the user personally
remembers it. A real example that prompted this ADR:

> *"the conformance test's one-directional check (handler-without-spec passes
> silently) is the structural reason these drifted. Tightening it would prevent
> recurrence — but that's beyond this fix. Want me to take it on, or commit
> what's here first?"*

That is a high-value, well-scoped follow-up. Today it evaporates.

**No existing surface holds it, each for a principled reason:**

- **`memory.md` / `remember`** (ADR-0042) is durable *facts*; the tool
  **rejects task/activity/status payloads by regex** (`memory-mcp.ts`). A
  follow-up is an *intention*, not a fact — rejected by design.
- **`plans/`** (ADR-0036) is the *current* task's checklist — transient,
  cleared on session-fresh.
- **`session-notes.md`** is an unstructured activity log with no
  status/lifecycle, and gets clobbered.
- **`docs/roadmap.md`** is MARVIN's **own** repo's roadmap; the item belongs
  to the *user's* project (Golden Rules 4 & 6).
- **TodoWrite/todos** are in-session, memory-only, zeroed on reset.

So there is a well-defined empty slot: **durable, cross-session,
project-scoped, *actionable* deferred-work items with status** — distinct from
facts, current plans, activity, and MARVIN's roadmap.

**The load-bearing constraint.** Golden Rule 1 forbids
"Kanban-as-source-of-truth" and multi-agent dispatch; ADR-0042 is the scar from
a memory log that bloated to 419 KB / ~99 % redundant. So this feature must be
a **parking lot a human and the single assistant consult — never a board that
agents autonomously pull work from**, and its growth must be bounded at the
write boundary (prose guidance demonstrably failed for memory).

## Decision

Add a **project backlog**: a small, durable, per-project store of *actionable*
deferred items, written through an enforcing MCP tool, surfaced to MARVIN on
session start and to the user in a UI panel — captured **only with user
consent** and **never auto-executed**.

### 1. Store — file-per-item + index (mirrors the memory layer)

Per active project, under the **user's** workspace:

- `<workDir>/.marvin/backlog/<slug>.md` — one item per file:
  ```markdown
  ---
  id: <slug>
  title: <one line, imperative>
  status: open            # open | doing | done | dismissed
  severity: med           # low | med | high
  source: { sessionId, turnId, at }   # where it was noticed
  created: <ISO>
  updated: <ISO>
  ---
  Why it matters + the concrete change + an acceptance hint.
  Link related context with [[memory-slug]] / ADR refs.
  ```
- `<workDir>/.marvin/backlog.md` — a one-line-per-item **index** of `open` +
  `doing` items (done/dismissed drop from the index but their files remain as
  history). Same shape as memory's `MEMORY.md`.

It's the user's artifact — they choose to commit or `.gitignore` it (like
`plans/` and `memory.md`). MARVIN ships no backlog content (Golden Rule 6).

### 2. Write path — the `marvin-backlog` MCP tool (the anti-bloat boundary)

An in-process MCP server (`backlog-mcp.ts`), registered in `sdk-runner.ts`
beside `marvin-memory`:

- **`backlog_add({ title, body, severity? })`** — creates the file + rebuilds
  the index. **Enforces content-class** (the ADR-0042 lesson): accepts only an
  *actionable, scoped* follow-up; **rejects** anything that smells like a
  durable fact (→ `remember`), verification/commit status (→ git), or a
  decision (→ ADR), with guidance. Dedups by slug/title; caps title + body
  length and total open-item count (a rail, not a workload).
- **`backlog_list({ status? })`** — read the backlog.
- **`backlog_resolve({ id, resolution: done | dismissed, note? })`** — legal
  status transition only; a resolved item fires no further surfacing.

### 3. Capture — consent-gated, at the scope-met handoff

Wire into the **existing** "noticed in flight, not in scope" moment in
`personality.ts`: when MARVIN lists out-of-scope follow-ups, it **proposes**
parking them and the user confirms. **No silent auto-capture** — that is the
bloat/Kanban trap. The user can also add an item by hand in the UI (§6).

### 4. Surface — capped first-message injection

`buildProjectContext` gains a **Project backlog** section (a new
`ProjectContextSection`, counted in the `/context` breakdown) listing **open**
items, **capped** (token-budgeted tail, like the memory injection in
`index.ts`). Framed explicitly as *"parked follow-ups you may propose resuming
— NOT an auto-queue."* This is what lets next session re-discover its own
parked work instead of losing it.

### 5. Anti-Kanban invariant (Golden Rule 1)

The backlog is a **memo to future-self surfaced at the right moment.** It:
- is read by the **single assistant + the user** — **no subagent pulls from
  it**, no fan-out, no dispatch;
- **never triggers work autonomously** — promotion to a plan/turn is always a
  user action;
- **never overrides plan-first** or the user's decision to act.
A new firm-surface row in `personality.ts` states this as MUST / MUST-NOT, the
same shape as the other surfaces in the CLAUDE.md table.

### 6. UI — a backlog panel + promotion (incl. optional GitHub export)

- New `GET /api/backlog?projectId=&status=` (list), `POST /api/backlog` (manual
  add), `PATCH /api/backlog/:id` (resolve / dismiss / edit / promote).
- macOS `BacklogService` + `BacklogPanel`: open items with severity, a link
  back to the source turn, and per-item actions — **Done**, **Dismiss**,
  **Promote to plan** (seeds a new turn: *"Implement: <title>"*), and an
  **optional Promote to GitHub issue** (`POST /api/backlog/:id/promote-issue`
  via `gh`, for projects with a remote — an *export target*, never the store).
- A tray count chip (like the plan/todo strips) shows the open-item count and
  opens the panel.

## Consequences

- The "noticed in flight" insight stops evaporating: it survives the session as
  a small, structured, user-owned artifact, and resurfaces next session.
- The backlog axis joins memory (facts) / plans (current) / roadmap (MARVIN's
  own) without overlapping them — each has one firm-surface row with a crisp
  boundary.
- One more per-project state dir under `.marvin/`; bounded by write-boundary
  caps + stale-reaping, capped on injection so it can't blow the context budget
  (the ADR-0041 lesson).
- Net-new UI + API surface (the cost of making it *visible*, which is the point
  — an invisible backlog is just another forgotten file).

## Rejected alternatives

- **Do nothing (status quo).** The exact failure this ADR exists to fix —
  items lost on session end.
- **Single `backlog.md` file.** Unstructured, no status machine, no dedup —
  the precise shape that bloated `memory.md` before ADR-0042.
- **Reuse the memory layer.** `remember` rejects task payloads by design; facts
  and intentions are different content classes that must not share a store.
- **GitHub issues as the store.** Requires a remote (not all projects),
  crosses the trust boundary, heavyweight/noisy, not local-first — kept as an
  optional *export*, not the source of truth.
- **Auto-capture every noticed item.** The Kanban/bloat trap; capture stays
  consent-gated.

## Scope of Done

- [x] `backlog.ts` store: file-per-item + index, status transitions; 13 unit
      tests (add/list/resolve, dedup, re-open, index rebuild, caps).
- [x] `marvin-backlog` MCP tool registered in `sdk-runner`; content-class
      enforcement (`classifyBacklogText`) rejects fact/status/decision payloads
      with guidance; caps + dedup; classifier covered by unit tests.
- [x] Consent-gated capture wired into the scope-met / "noticed in flight"
      handoff in `personality.ts` (proposes, never auto-parks).
- [x] `buildProjectContext` injects open items (capped, `BACKLOG_TAIL_TOKENS`)
      on first message, framed as a parking lot; a `/context` breakdown
      category counts them.
- [x] Anti-Kanban invariant encoded as a `personality.ts` firm-surface row
      (MUST/MUST-NOT) + a CLAUDE.md table entry; no subagent-pull path exists.
- [x] `GET/POST/PATCH /api/backlog` + optional `/promote-issue` routes (CSRF +
      `validateProjectCwd`).
- [x] macOS `BacklogService` + `BacklogPanel` + tray count chip; Promote-to-plan
      seeds a turn via `sendControl` + flips the item to `doing`;
      Promote-to-issue behind a remote check.
- [x] sidecar tsc clean for all touched files; runtime tests green (the
      pre-existing `fs-sandbox.test.ts` failure is unrelated — confirmed on the
      stashed clean tree). macOS `swift build` — verified at implementation.
- [x] CLAUDE.md firm-surface table + Cross-session continuity section name the
      backlog and its boundary vs memory/plans/roadmap.

---

## Addendum (2026-08-06) — overlap is surfaced, never reconciled

**Context.** `addBacklogItem` dedups by exact title-slug. "Fix the file-tree
outline crash" and "Stop the outline crashing on refresh" slugify differently,
so both park and neither ever notices the other. §3-as-amended by
[ADR-0047](./0047-backlog-capture-at-discovery.md) made capture un-gated at
discovery, which makes near-duplicates accumulate by construction — the open
rail was raised 50 → 200 (2026-07-08) after a real project hit 50 through
ordinary use.

The proposal considered was: on resolve, re-check the remaining items and
**update them accordingly**.

**Decision.** Detect overlap at both write boundaries; report it; change
nothing else.

- `backlogSimilarity(a, b)` and `relatedBacklogItems(target, others)` are pure
  and exported, like `classifyBacklogText` — the calibration is unit-testable
  at the boundary rather than asserted in prose.
- `addBacklogItem` returns `related` (live items resembling the one just
  parked); `resolveBacklogItem` returns `related` (live items resembling the
  one just resolved). Both **always** write their own item first.
- `backlog_add` / `backlog_resolve` render the candidates as a question for the
  user. `personality.ts` carries a MUST-relay / MUST-NOT-act pair.

**Why not auto-update siblings.** Three reasons, in order of weight:

1. **It inverts ADR-0047's consent model.** Capture is un-gated *because*
   consent lands later, at the keep/dismiss handoff. An item that reached
   `open` has already passed that gate; auto-resolving it when a *neighbour*
   resolves mutates consented state with no new consent point.
2. **Wrong judgements destroy the thing the backlog protects.** The backlog
   exists so discoveries don't evaporate. A bad cascade makes one evaporate
   *and* leaves a record saying it was completed — strictly worse than never
   capturing it. Detection can be wrong cheaply; mutation cannot.
3. **It is Kanban by the back door (Golden Rule 1).** Once resolving A rewrites
   B, the backlog maintains its own state machine. §5's invariant is that the
   store is inert: read by MARVIN and the user, never self-driving.

Judging "is B obsolete now that A landed" is also *semantic* — deterministic
code can't do it, so the auto-update variant means an LLM pass over the open
set on every resolve. Detection is a set intersection.

**Calibration.** Containment over the shorter title's meaningful tokens (not
Jaccard — backlog titles are short and one is often a more specific restatement
of the other, which Jaccard penalises), plus a bonus when both items name the
same file. Tuned so a shared file path alone is *not* enough: same file,
different work is the common case. `RELATED_MIN_SCORE` / `RELATED_MAX` are
exported so the thresholds are a one-line change.

**Both write paths are covered.** `POST /api/backlog` returns `related` too, and
the macOS panel renders it as a dismissible orange notice under the header — an
advisory ("Added. This looks like the same work as …"), deliberately not styled
as the red error banner, because the add succeeded. The Swift decode treats the
field as optional so an older bundled sidecar degrades to no hint rather than a
failed add.

## Scope of Done — addendum

- [x] `backlogSimilarity` + `relatedBacklogItems` pure + exported; stopwords,
      singular-fold, file-path extraction that ignores version strings and
      prose abbreviations.
- [x] `addBacklogItem` returns `related` (required); `resolveBacklogItem`
      returns `related` (optional on `ResolveResult`, populated only there).
- [x] Both MCP tools render candidates as a user-facing question.
- [x] `personality.ts` MUST-relay / MUST-NOT-act firm surface.
- [x] 12 unit tests: calibration (reworded duplicate, unrelated work, shared
      path insufficient, shared verbs insufficient, version strings ignored),
      selection (self/resolved excluded, provisional+doing included, cap), and
      the write-boundary invariant that resolving one sibling leaves the other
      byte-identical and still indexed. 30/30 in `backlog.test.ts`.
- [x] `tsc --noEmit` clean for `packages/runtime` + the sidecar app.
- [x] `POST /api/backlog` returns `related`; `BacklogService.add` decodes it
      (optional field — older bundles degrade to no hint); `BacklogPanel` shows
      a dismissible advisory distinct from the error banner.

## Amendment (2026-09-11) — items are claimed, and read only from the live store

[ADR-0113](./0113-the-backlog-is-the-shared-task-list.md) adds three fields to
an item — `claimedBy`, `claimedBranch`, `claimedAt` — written only while the
item is **doing**, and a `backlog_claim` tool beside add / list / resolve.
`setBacklogStatus` clears the claim on any move away from doing; `resolve`
releases it. The index line and `backlog_list` show `· tab: <branch>` on a
doing item, and `backlog_add`'s near-duplicate refusal (ADR-0070) names the
holder when the live item is doing. The `.marvin/backlog/` copy inside a
session worktree (ADR-0107) is a snapshot cut with the branch; the gate turns
back reads aimed at it. Nothing in this ADR's file format changes for items
that were never claimed.


## Amendment (2026-11-25) — the count is project state, pushed to every surface

The chat's "N backlog items parked" strip showed a number it read once, when a
session or its view was created, and only that session's own turn end ever
re-read it. Other tabs file, claim and resolve items all day (about 40 a day on
the largest project), the Project Backlog window writes too, and a hand edit or
a git checkout changes the files — none of it reached a strip that had already
looked ("this is not being automatically or dynamically updated, i need to open
a new session"). The same capture-at-creation shape held for the window's scope
counts (loaded once, never reloaded while open) and for the sessions' "holds"
lines.

- **The sidecar says when it changed.** `backlog-live.ts`: `writeItem` — the one
  function every write path ends in (tool add / resolve / claim / classify, the
  app's keep / dismiss / resolve, bulk review) — calls `noteBacklogWrite`, and
  one `fs.watch` on `.marvin/backlog` per project (refcounted by the announce
  streams, re-attached if the directory is replaced) feeds the same debouncer
  for writes made outside MARVIN. 300 ms quiet / 1.5 s max wait, so one tool
  write that the watcher also sees is one signal, and a bulk review of 200
  items is one signal. **What is guaranteed is not "one signal per burst"** —
  no debounce can promise that against events that arrive slowly (one
  `writeFile` raised two watcher events 51 ms apart on a loaded machine, and a
  test that asserted "exactly one" against the real clock failed 7 runs in
  30) — **but this:** a subscriber is told whenever the directory (the scan's
  signature of every counted file's name, mtime and size) differs from the last
  frame *it* received, never for a state it already has, and the last frame
  carries the final counts. The knowledge is per subscriber, not per project: a
  baseline shared between subscribers hid a change from one that had not seen
  it (a snapshot read a moment before a write). A new watch and a re-attached
  one each ask for one recount, because a watch does not see what happened
  before it went live. The signal is `backlog.changed` on `/api/chat/announce`:
  a revision and the counts by status (provisional / open / doing / done /
  dismissed) plus `blocked` — never a path or a title, that stream holds no
  token. A snapshot is sent at attach, so a reconnect after sleep or a sidecar
  restart resyncs. `GET /api/backlog/counts` is the re-read.
- **Counting is incremental.** `lstat` of each file, re-read only where mtime
  or size moved: on a 2,700-file directory ~71 ms cold, ~10 ms warm, against
  ~170 ms for the full parse the list route does. A path inside the user's
  repository is attacker-controlled: a symlinked directory or entry is never
  followed, the scan is bounded (20,000 names), only `.md` is counted.
- **One store in the app.** `BacklogLiveStore` holds `BacklogLiveState`
  (MARVINLogic); the strip, the window's scope counts and header, and the
  sessions' claim lines read it. The window reloads its list in place when the
  store's generation ticks. Safety nets, because a stream can be missed: a
  re-read when the app comes to the front and every five minutes.
  `BacklogCountSourceScan` fails the test suite if a file other than the store
  assigns a backlog count.

## Amendment (2026-11-27) — done is derived from git, the closed are archived, the schema is checked

*Measured on the owner's real project, 26–27.11.2026.* The store held 2,837 item
files: 293 open, 5 doing, 2,221 done, 318 dismissed. The backlog window parsed
and shipped all of them to show the 298 that matter (about 4.1 MB, 180–340 ms
warm on the machine this was built on; the owner reported it slow to open). On
26.11, 54 items were filed and about 50 stayed open although many were fixed the
same day: the fix landed on a release branch and reached the working branch by a
merge, and nobody went back to resolve the items; a sweep session then had to
read all 2,837 files to find the open ones. `priority` had been written as
`low/med/high`, `medium` and others; items carried no release, origin or "waits
on"; one item hit the 4,000-character note cap and could take no more. Research:
`marvin-supervisor/reports/backlog-practices-2026-11-27.md` (recommendations 1–4
and 8). Its rejected list stays rejected: no agent self-claiming, no autonomous
closing by an agent, no age-based auto-close.

**1. Done is derived from git (`backlog-derive.ts`; same shape as
`reconcileWorktrees`, ADR-0103).** A commit may end with the trailer
`Backlog: <slug>` (one line per item, several allowed; a comma list is read
too). An `open` or `doing` item whose slug is in such a trailer on a commit
reachable from the integration branch is `done`, with the commit sha as
evidence, and the resolution is *persisted* like any other (status done, file in
the archive, `resolvedBy: derived`, `evidence: <sha>`, a dated note when it
fits) so it is never recomputed. Decisions:

- *Integration branch* = the branch checked out in the project's main checkout:
  where `mergeWorktree` / `mergeAllWorktrees` fold work and what
  `detectMergeTarget` aims a merge request at — MARVIN has no other configured
  base. Reachability is the test, so a fix on a release branch counts the moment
  that branch merges in, with no special case (the 26.11 failure). A detached
  HEAD or a non-repository derives nothing and says so.
- *Cost.* One `git log --grep=^Backlog: --max-count=20000` with the trailer
  format, never one call per item; cached by the branch tip (unchanged tip: one
  `rev-parse`; moved tip: only `oldTip..newTip` when the old tip is an
  ancestor; calls inside 10 s share an answer). The pane's route starts it
  without waiting; `backlog_list` and the session-start context wait for it.
- *A slug that names no item* is reported (`unknown`), never created. *An item
  already done or dismissed* is not touched, and a provisional item waits for the
  person's keep or dismiss (ADR-0047) — a trailer is not that decision. *Only a
  commit made after the item was filed or last reopened counts* (`created`,
  `reopenedAt`), so re-filing a title fixed last month does not close itself.
- *A revert*: derived done stays done. A revert commit carries no trailer, so
  nothing re-derives; the work is a new item, or `backlog_resolve keep` reopens
  the old one by hand. *Squash and rebase* keep a message's trailer; a squash that
  drops the message drops the evidence and the item stays open — the safe
  direction.
- Tabs are told once: `personality.ts` step 8 (Ship) and the `backlog_add` /
  `backlog_resolve` tool descriptions say to end a fixing commit with the
  trailer. Golden Rule 1 is intact: the trailer is the author's claim,
  reachability is git's proof, the rest is derivation; no agent closes its own
  ticket by a tool call it chooses, and the marker lets the review tell derived
  from decided.

**2. An open index and an archive.** `.marvin/backlog/<slug>.md` holds only
open, doing and to-review items; done and dismissed files live in
`.marvin/backlog/archive/` with `archive/summary.json` (`{layout, done,
dismissed}`). The index `.marvin/backlog.md` lists the open items with compact
fields (priority, type, release, waits on) and names the archive count. A write
that changes status moves the file; `listBacklog` defaults to the open items;
`listResolved` pages the archive newest first; `getBacklogItem` finds one id in
either place; the live counter reads the open files plus the summary (a summary
that disagrees with the archive's file count is recounted, not trusted).
*Migration* (`ensureBacklogLayout`, runs once per project on first access,
resumable, idempotent): done/dismissed files are **moved byte for byte**; open
files are rewritten once with `priority:` while keeping `severity:` beside it
(the macOS pane, the vault's Dataview tables and an older MARVIN still read it);
`summary.json` is written last, so a run that stops halfway is finished by the
next. A `mkdir` lock (`.layout.lock`, taken over after 60 s) keeps two sessions
(ADR-0102) from doing the same work; the moves are idempotent as well. A
resolved file that turns up beside the index later (an older MARVIN, a checkout)
is moved on read. *Undo:* `mv .marvin/backlog/archive/*.md .marvin/backlog/`,
then delete `archive/` — the files are as they were, the open ones carry an
extra `priority:` line the old reader ignores.

**3. The pane.** `GET /api/backlog` returns the open items, the counts (done and
dismissed from the summary) and `resolved: {done, dismissed, total}`;
`GET /api/backlog?status=resolved|done|dismissed&limit=100&offset=N` returns one
page of the archive. The Resolved tab loads its first page when it is opened,
"Load more" the rest; search and filters look at what is loaded, and the footer
says so. On a synthetic 2,837-file store: before, 4.1 MB and 178–341 ms (3 runs);
after, 0.47 MB and 25 ms for the open items and counts, 158 KB and 20 ms for the
first 100 resolved; the one-time migration 0.64 s.

**4. Schema checked at write.** `priority` is `low | medium | high`
(`severity` stays accepted as a deprecated argument name, held to the same
values; on read `med`, `hi`, `normal`, … fold to the three, an unknown value reads
as `medium`; `backlog_add` / `backlog_update` and the manual route refuse
anything else, naming the three). The wire keeps `severity: low|med|high` for
the macOS pane until it reads `priority`. New optional fields: `type` (bug,
debt, idea, chore — the research's coarse split; `kind`, ADR-0064, stays and is
the finer one), `release`, `origin`, `waitsOn` (single lines, capped, refused
not truncated; an omitted field keeps what is stored). `waitsOn` overlaps
`blocked`/`blockedOn` (ADR-0064) in intent; both exist because the brief asked
for the new one and a merge of the two needs a decision about 2,800 files'
meaning. No `owner` / assignee field: assignment invites pulling (Golden Rule 1).

**5. The note cap refuses with advice.** The error names the item and says to
file the next point as a new item with `backlog_add … relatesTo: "<slug>"`;
`relatesTo` is accepted on add, must name an existing item (open or archived),
and is stored. The cap is not raised.

**Not in this amendment** (research recommendations 5–7, 9, 10): duplicate
candidates at filing, the machine-filed template, the per-session filing cap
with a digest, the metrics panel, and age flags in the review.

### Scope of Done — amendment (2026-11-27)

- [x] A commit with `Backlog: <slug>` reachable from the integration branch
      makes the item done with the sha as evidence — test with a real temp git
      repo, including a fix on a side branch that reaches it by a merge
      (`backlog-derive.test.ts`, 15 tests).
- [x] Closed items live in the archive; the index and the default list hold only
      open / doing / to-review; every reader passes its tests
      (`backlog-archive.test.ts`, 24 tests; the older suites unchanged but for
      the field rename).
- [x] The pane's data route returns counts plus open items without reading the
      archive; resolved items page on demand (`backlog-pane-route.test.ts`, 8
      tests; `BacklogPaging` in MARVINLogic, 3 Swift tests).
- [x] Priority normalised and validated; the new fields accepted; the cap refuses
      with advice; the tools say so (`backlog-mcp.test.ts`, 7 tests).
