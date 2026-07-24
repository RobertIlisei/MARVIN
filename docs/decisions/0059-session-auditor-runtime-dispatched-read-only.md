# ADR-0059 — Session auditor: runtime-dispatched, read-only, reports to the user

**Status:** Accepted — 2026-07-24
**Touches:** a new `session-auditor.ts` in `@marvin/runtime`
(audit-packet assembly + the auditor session dispatch), a `POST/GET /api/audit`
route, `ChatPreviewView.swift` (scope-met "Audit session" chip + findings
sheet), `MARVINApp.swift` + `Bridge.swift` (the always-available "Audit
Session…" menu item), `personality.ts` (the auditor exists, MARVIN never
invokes it), `CLAUDE.md` (Golden Rule 1 carve-out list + the rejected
supervisor). Builds on the Ask-mode read-only
invariant ([ADR-0036](./0036-autonomy-modes.md)), change checkpoints
([ADR-0034](./0034-change-review-checkpoints.md)), the plan spine
([ADR-0052](./0052-plan-file-ownership.md)), and the mechanical-guard arc
([ADR-0055](./0055-checkback-promise-auto-arm-guard.md),
[ADR-0057](./0057-workflow-completion-guard.md)). Required by Golden Rule 1's
"any new agent requires a new ADR".

## Context

The question that produced this ADR was "should MARVIN get a **supervisor**
agent overseeing the executor and advisor?" The answer was no — that is the
exact topology ADR-0001 was written to escape (the prior project's supervisor →
role-agents shape, with its handoff-tax quality collapse), and a supervisor
implemented as a `Task` subagent would be theater anyway: spawned by, briefed
by, and living inside the turn of the thing it supervises.

But the analysis surfaced a real gap. MARVIN's supervision today is
**mechanical** — the permission gate screens every call, ADR-0055 verifies
check-back promises, ADR-0057 verifies completion claims, the auto-audit JSONL
records everything. Deterministic code, immune to persuasion. What deterministic
code cannot do is **judgement-level, long-horizon review**:

- drift — six turns that each individually pass the gate but collectively
  wander from the plan's intent;
- reinterpretation — a DoD whose boxes were ticked while the bullets' meaning
  quietly shifted;
- repetition — the same bug "fixed" twice, the same file churned repeatedly;
- claim-vs-evidence gaps too fuzzy for a regex — "verified end-to-end" backed
  by a transcript showing only a typecheck.

Those need a model reading the session with fresh eyes. The design problem is
admitting that model **without** creating the model→model command edge that
Golden Rule 1 forbids.

## Decision

Add a **session auditor**: a runtime-dispatched, read-only, out-of-band LLM
pass over a session's artifacts that produces a discrepancy report **for the
user**. The direction of authority is the entire design:

> Mechanical guards supervise the executor. The auditor informs the user. The
> user supervises everything. No model ever commands another model.

### 1. Dispatch — by the runtime, never by the executor

The auditor is NOT a `Task` subagent and is NOT registered on the executor's
agents map. It runs as its **own SDK session** (`query()` with a dedicated
auditor system prompt), started by the runtime from server-side state. The
executor cannot start it, brief it, or see its output unless the user pastes
the report in. This preserves the out-of-band property that makes supervision
meaningful — the same reason ADR-0055/0057 live in the runtime, applied to the
judgement layer.

Triggers (deterministic list, firm-surface style):

1. **User-initiated** — `POST /api/audit` from the UI ("Audit this session").
   Always available. The v1 default is that this is the ONLY enabled trigger.
   Two affordances, one route: an **"Audit session" chip on the scope-met chip
   strip** (the primary surface — the natural audit moment is right after a
   completion claim, composing with ADR-0057: the guard checks the boxes, the
   chip offers the judgement pass on the same claim) and a quiet
   always-available menu/toolbar item for mid-session "this feels like drift"
   audits. Explicitly NOT an Ask-mode function: Ask mode is the executor with
   writes disabled — same session, same context — and an executor auditing its
   own narrative from inside that narrative is the self-briefing failure this
   ADR exists to avoid. The auditor shares Ask mode's read-only gate
   *mechanism* (§2), never its *surface*; Ask mode's purpose is untouched.
2. **Plan-completion** (opt-in setting, default OFF) — when the active plan's
   steps all reach `completed`, fire one audit of the plan's span.
3. **Scheduled** (opt-in, default OFF) — a standing wakeup-style periodic
   audit for long-running sessions.

MUST NOT trigger: per-turn (cost, and it would recreate the resident-overseer
anti-pattern), or by executor request (no `request_audit` MCP tool — the
executor asking for its own audit reintroduces self-briefing).

### 2. Containment — read-only at the SDK layer

The auditor session is read-only by **SDK contract**: `AUDITOR_DISALLOWED_TOOLS`
refuses Edit / Write / NotebookEdit / Bash / WebFetch / WebSearch / Task /
TodoWrite before a call ever reaches the model. It keeps Read/Grep/Glob so it
can verify claims against the actual workspace ("the transcript says this file
was fixed; is the fix in the file?"). `Task` is refused specifically so the
auditor cannot spawn agents — that would recreate the model→model edge this ADR
forbids.

*(Implementation note: the original draft proposed reusing Ask mode's
`canUseTool` read-only collapse (ADR-0036). Because the auditor runs as its own
standalone `query()` session rather than through `runAgent`, SDK-level
`disallowedTools` is both simpler and strictly stronger — refusal happens
before the model sees the tool, with no gate wiring to keep in sync. Same
invariant, better mechanism. The deny-list is exported and test-pinned rather
than assumed.)*

### 3. Input — a runtime-assembled audit packet

The runtime curates what the auditor sees (bounded, server-side, no rummaging):

- the session transcript tail (byte-capped; cap in the implementation),
- the plan spine (`<sessionId>.plans.json`) — steps + statuses,
- the auto-audit JSONL tail — what tools ACTUALLY ran,
- the change-checkpoint summary (ADR-0034) — what ACTUALLY changed on disk,
- ADR/doc files touched this session (paths, for the auditor to Read),
- the session's DoD statements and scope-met claims, extracted.

The packet juxtaposes **claims** (transcript) with **evidence** (audit log,
checkpoints, files) — that juxtaposition is the audit.

### 4. Output — a findings report, to the user only

A structured markdown report persisted to `.marvin/audits/<sessionId>-<ts>.md`
(the project's own `.marvin/`, consistent with session-notes: the user's
artifact, not MARVIN's hidden state). Each finding:

```
- class:    claim-gap | drift | repetition | reinterpretation | unreconciled
  severity: info | warn | high
  claim:    what the session said (turn-cited)
  evidence: what the artifacts show (file/log-cited)
  suggest:  the one next step a user could take
```

Surfaced as a tray chip / notification ("Session audit: N findings"). The
report is **never injected into the executor's context automatically** — the
user reads it and decides what, if anything, to raise with MARVIN.

### 5. What the auditor is NOT (hard MUST-NOTs)

- **Not a gate.** It cannot block a turn, a commit, a scope-met, or a release.
  Zero enforcement authority — that stays with the deterministic guards.
- **Not a dispatcher.** It never starts, messages, or instructs the executor
  or any other agent. The model→model command edge is never created.
- **Not a writer.** Read-only gate; its only artifact is the report file,
  written by the RUNTIME, not by the auditor's own tools.
- **Not resident.** One bounded session per trigger, `maxTurns`-capped; it
  does not linger, poll, or self-reschedule.

### 6. Cost posture

Default model: **Sonnet tier** (`latestForTier("sonnet")`) — judgement work
above Haiku's weight class, below frontier pricing; configurable like
`advisorModel`. One audit = one bounded session over a capped packet. With the
v1 default (manual trigger only), the standing cost is zero.

## Addendum (2026-07-24) — the code graph as structural evidence

**Gap found.** The original §2 draft said the auditor would get "the
`marvin-graph` read tools", but the shipped session wired no `mcpServers` at
all — the capability silently vanished when §2 was rewritten. (Precisely the
claim-vs-evidence drift this ADR's own tool is meant to catch.) Closed here.

**Why it's worth having.** Text-level auditing can check whether a claim is
*supported*; the graph can check whether a change is *structurally complete* —
the question neither the transcript nor the diff can answer alone:

> the plan said "rename `X`" → `graph_neighbors(X)` lists 12 callers → the
> change set touched 3 files. The other 9 are a **blast-radius** finding.

That adds a sixth finding class, `blast-radius`, and makes the graph a third
evidence axis alongside the tool log and the change set.

**The load-bearing guard: freshness.** The code graph is AST-refreshed per turn
only while the IDE has the project open (ADR-0041). A graph built BEFORE this
session's edits describes the OLD code — auditing "did you update every caller?"
against it yields confident phantom findings, the worst possible output from a
review tool. So the packet now carries an explicit `GraphFreshness`
(`computeGraphFreshness`, comparing `graphify-out/graph.json` mtime against the
newest `lastTouchedAt` in the change set), and §F of the prompt gates the
auditor accordingly:

- **fresh** (graph ≥ newest change) — structural findings in scope;
- **stale** — orientation only; raising a structural finding is forbidden,
  because the auditor cannot distinguish "the change is missing" from "the
  graph predates the change". It must recommend a refresh instead;
- **missing** — no graph queries at all.

**Coverage caveat, even when fresh.** AST extraction misses dynamic dispatch,
string-keyed lookups, reflection, and config-driven wiring. So the evidence is
deliberately treated as **asymmetric**: "the graph lists callers that were not
updated" is STRONG (may be `warn`/`high`); "the graph shows no callers, so this
is dead code" is WEAK (`info`, phrased as a question). Encoded in the auditor
prompt, test-pinned.

## Addendum 2 (2026-07-24) — findings are actionable, not a wall of text

First real audit (agri-saas, 2026-07-24) produced two genuinely useful findings
— a commit that landed on an unrelated feature branch, and a scope-met claim
contradicted by the very next ADR-0057 reconciliation check. But the report was
a **read-only popup**: the user could read it and nothing else. Useful findings
that can't be acted on decay into noise.

**Does acting on findings break §5?** No, and the distinction is the whole
design. The MUST-NOT is that the *auditor* cannot command the executor. The
*user* acting on a finding is the intended flow — §4 already says "the user
reads it and decides what, if anything, to raise with MARVIN." These buttons
just replace copy-paste. Authority still runs **user → executor**; the auditor
still never talks to MARVIN.

**Structure.** `parseFindings` turns the report's fixed shape (`### title` +
`- class/severity/claim/evidence/suggest`) into `AuditFinding[]`, returned
alongside the markdown. Parsing rather than asking the model for JSON keeps ONE
source of truth: the report the user reads is the report the buttons act on.
(Test-pinned against real audit output — wrapped multi-line fields with
backticks and colons are the normal case, and a naive `$`-terminated regex
truncates them under the `m` flag.)

**Three actions per finding**, each reusing machinery that already exists:

- **Park to backlog** → `POST /api/backlog` (ADR-0044). A finding IS
  "actionable deferred work" — the backlog's exact content class — so it then
  flows through the whole existing pipeline (panel, sort/group/filter,
  promote-to-plan, resolve-with-note) with no new persistence. Auditor severity
  maps `high→high`, `warn→med`, `info→low`.
- **Work on it** → mirrors `promoteBacklog`: switches to **Plan** mode and asks
  MARVIN to investigate read-only and present a plan for approval — never
  "start editing". The instruction explicitly invites MARVIN to *refute* the
  finding with evidence rather than plan work, since findings are prompts to
  look, not verdicts. Queues when a turn is in flight (the silent-drop bug
  `promoteBacklog` already fixed).
- **Dismiss** → local to the sitting; the report file on disk stays the durable
  record.

Not everything belongs in the backlog (an `info` observation is often just
noise), so nothing is auto-parked — the user triages per finding.

## Alternatives considered

- **Standing supervisor over executor+advisor** — rejected; ADR-0001's camp 2,
  re-litigated and re-rejected in the conversation that produced this ADR
  (authority inversion, context fragmentation, arbitration regress, cost).
- **Auditor as a registered Task subagent** — rejected; the executor would
  spawn and brief its own overseer. Runtime dispatch is the point.
- **Toolless one-shot (packet in, report out)** — simpler, but unable to check
  claims against the live workspace; the claim-vs-evidence check is the
  auditor's core value. Read tools under the existing read-only gate cost no
  new containment.
- **Extending the mechanical guards further instead** — not an alternative but
  the default path; the auditor exists only for what code can't detect. Any
  finding class that turns out to be mechanically detectable should graduate
  INTO a guard (the 0055/0057 pattern) and out of the auditor's job.

## Consequences

- **Positive.** Judgement-level oversight with zero new trust surface: no new
  containment code, no model→model edge, no standing cost at v1 defaults. The
  user's overwatch role is sharpened, not diluted.
- **Negative.** Audit quality depends on packet quality; a finding is only a
  prompt to look, not a verdict — false positives cost user attention. Reports
  add a small new artifact class to `.marvin/`.
- **Boundary.** If a future request asks the auditor to *act* on its findings
  (auto-fix, auto-block), that is a topology change requiring a new ADR — this
  ADR's MUST-NOTs are load-bearing, not defaults.

## Scope of Done

- [x] `POST /api/audit` runs a read-only auditor session over the assembled
      packet and persists a findings report to `.marvin/audits/`; the executor
      has no path to trigger it (no MCP tool, no agents-map entry).
- [x] The auditor session is read-only — every mutator + web + `Task` is
      refused at the SDK layer via `AUDITOR_DISALLOWED_TOOLS`, and the read
      tools it needs are retained (both directions test-pinned). Implemented
      as SDK `disallowedTools` rather than the drafted `canUseTool` collapse —
      see §2's implementation note.
- [x] Packet assembly juxtaposes transcript claims with auto-audit +
      change-checkpoint evidence, byte-capped (caps test-pinned).
- [x] Report surfaces to the user (chip/notification) and is NOT auto-injected
      into the executor's context.
- [x] Trigger affordances: an "Audit session" chip on the scope-met chip strip
      + an always-available menu/toolbar item — both hitting `POST /api/audit`;
      no audit affordance inside Ask mode.
- [x] **Addendum:** the auditor has the read-only `marvin-graph` tools; the
      packet carries `GraphFreshness`; the prompt licenses structural
      (`blast-radius`) findings only when the graph is fresh, forbids them when
      stale/missing, and treats "no callers" as weak vs "un-updated callers" as
      strong — all test-pinned.
- [x] **Addendum 2:** findings parse into `AuditFinding[]` (test-pinned against
      real audit output) and render as per-finding cards with Park-to-backlog /
      Work-on-it / Dismiss; parking reuses `POST /api/backlog`, dispatch mirrors
      `promoteBacklog` (Plan mode, queue-if-busy). No auto-parking.
- [ ] **NOT DONE — deliberately deferred.** Plan-completion + scheduled
      triggers behind default-OFF settings. v1 ships the manual trigger only
      (§1's stated default), which is the whole of the v1 contract; the
      automatic triggers wait until manual use shows the audit is worth
      firing unattended. Tracked on the roadmap.
- [x] `personality.ts` notes the auditor's existence + that MARVIN never
      invokes it; `CLAUDE.md` Golden Rule 1 list updated; full suite +
      typecheck green; app rebuilt.
