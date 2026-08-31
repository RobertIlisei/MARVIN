# ADR-0100 — An advisor caveat is a condition on the current scope, not deferred work

- **Status:** Accepted — implemented 2026-08-31
- **Date:** 2026-08-31
- **Related:** [ADR-0044](./0044-project-backlog.md) (what the backlog is for), [ADR-0095](./0095-advisor-verdict-is-read-and-caveats-persist.md) (the behaviour this changes), [ADR-0047](./0047-capture-at-discovery-consent-at-review.md) (capture-at-discovery), [ADR-0007](./0007-advisor-as-subagent-pattern.md) / [ADR-0094](./0094-advisor-dispatch-uses-the-registered-agent.md) (the advisor itself)

## Context

ADR-0095 made advisor caveats durable by parking each one to
`.marvin/backlog/` as a provisional item. That solved the problem it set out
to solve — compaction could no longer lose them, and "the advisor said X, we
shipped without X" became visible.

It also put them in the wrong place, and the user named it:

> *"I feel like the backlog should be for backlogged items as first proposed,
> in-flight items that we discover. Advisor caveats seem like another kind of
> necessity."*

That is a content-class objection, and this repo already takes content class
seriously enough to enforce it at a write boundary. ADR-0044 built the backlog
for **actionable deferred work** and made `backlog_add` *reject* anything that
is really a durable fact (→ `remember`), a status (→ git), or a decision
(→ ADR). ADR-0042 is the record of what happens when a store accepts the wrong
content class: a project's `memory.md` reached 419 KB and ~99 % redundancy.

A caveat is none of the four. It is a **condition attached to a `go` that has
already been given**, on work happening *now*. The industry framing is exact
([the gate pattern](https://www.mindstudio.ai/blog/gate-pattern-ai-agents-prepare-not-submit)):

> The key distinction is between flagging and blocking: a reviewer who records
> a concern **while deployment proceeds** is performing *review*; a reviewer
> whose objection **halts the release until resolved** is performing
> *approval*.

Parking a caveat converts a precondition into a someday. The advisor said "go,
**provided** you X"; the backlog records "consider X, at some point". The
conditionality — the only part that made it a `go-with-caveats` rather than a
`go` — is dropped on the floor. Worse, it is dropped *silently*: the turn
proceeds, the item sits at `provisional`, and nothing connects the two.

There is a second, quieter cost. The backlog is surfaced to the next session
and reviewed at the scope-met handoff. Caveats therefore arrive as generic
future work, mixed in with genuine deferrals, stripped of the fact that they
were conditions on something already shipped.

## Decision

**A caveat is a condition while the scope is open, and becomes a backlog item
only if the scope closes without it being met.**

One rule, two homes, and a defined moment of transfer.

### 1. Conditions live on the turn, not the project

Parsed caveats attach to `DesignTurnContext` — which already carries
`advisorVerdict` from ADR-0095 — as an ordered list of
`{ id, text, verdict, topic, status: open | met | waived }`. Turn-scoped
state, for a turn-scoped obligation. Nothing is written to `.marvin/` at
parse time.

### 2. They are surfaced as conditions, in the executor's own words

The `PostToolUse` hook keeps its `additionalContext` line, but it now states
the shape of the obligation rather than announcing a park:

> *The advisor returned `go-with-caveats` with 3 conditions. They bind this
> scope. You must state, at the scope-met handoff, which hold and which do
> not.*

This is deliberately not enforcement. ADR-0095 was right that a hook cannot
be a correctness oracle, and Golden Rule 1 is right that a model must not
police a model. But **surfacing is not verification**: you do not need an
oracle to *ask*, and to make the answer part of the handoff the user reads.

### 3. The scope-met handoff is the transfer point

Implemented by extending the **ADR-0057 workflow guard** rather than building a
new mechanism. That guard already fires a corrective turn when a close claims
scope-met with plan items open or an ADR's Scope of Done unticked; an
unanswered advisor condition is the same shape of gap. `WorkflowGap` gains
`openConditions`, and the reconcile prompt asks for `met` / `not met` /
`waived, because …` per condition and instructs the executor to park **only**
the unmet and waived ones with `backlog_add`.

Putting the judgement in the corrective turn rather than in the hook is the
point: the executor knows what it actually did, and a hook does not. This is
the same division ADR-0095 drew when it refused to check whether a caveat was
implemented.

At the handoff, each open condition is rendered with the scope-met block and
the executor states `met` / `not met` / `waived, because …`. Then:

- **`met`** — recorded in the session note, nothing parked. The condition did
  its job; a backlog item would be noise.
- **`not met`** — parked to `.marvin/backlog/` *now*, which is the first
  moment it is honestly deferred work, carrying its provenance (advisor,
  topic, verdict, the scope it was attached to).
- **`waived`** — parked with the stated reason, because a waived condition is
  a decision the user should be able to find later.

This preserves everything ADR-0095 bought — durability, compaction-survival,
visibility of "advised X, shipped without X" — while the backlog only ever
receives items that genuinely are deferred work. ADR-0044's content class
holds without an exception carved into it.

### 4. `reject` is unchanged

ADR-0095's fire-once deny on a `reject` verdict stays exactly as it is. The
reasoning there — that a hard block hands a subagent a veto over the user's
tree, and a `reject` is sometimes just miscalibrated context — is untouched by
anything here.

## Consequences

**Positive.** The backlog stops accumulating items that were never deferred
work, so its review stays a review of real follow-ups. A caveat binds while it
can still change the outcome, which is the only window in which it is useful.
"Advised X, shipped without X" becomes a *stated* waiver with a reason rather
than an orphaned provisional item nobody connected to anything.

**Negative — smaller than this ADR first assumed.** The draft worried that
turn-scoped conditions would be lost if a turn died before its handoff, and
proposed firing the transfer on the abnormal-termination path to compensate.
Reading the implementation showed that mitigation was unnecessary: ADR-0095
already writes **every caveat to `.marvin/advisor-caveats.md` the instant it
parses one**, before anything can refuse. That durable record is untouched
here. What a dying turn loses is only the *backlog transfer* — the caveats
themselves are on disk either way. The abnormal-termination hook was dropped
as a complication buying nothing.

**Negative.** One more thing the scope-met block must render, on a surface
that is already dense.

**Rejected — a new `.marvin/conditions/` store.** A third durable content
class with its own MCP tool, index and review flow, for state whose natural
lifetime is one scope. The backlog already exists for what outlives the scope;
turn state already exists for what does not. A store between them would be
carrying weight for the minority of caveats that survive.

**Rejected — schema-validating the advisor's reply.** The obvious fix for
`verdict: "unparsed"` is [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs) —
define a JSON Schema, let the SDK validate and re-prompt. It does not apply
here: `outputFormat` is a `query()`-level option, and `AgentDefinition` has no
output-schema field, so a *subagent's* result cannot be schema-validated
today. The markdown verdict block is not a shortcut around a better tool; it
is the only tool. Revisit if `AgentDefinition` gains the field.

## Scope of Done

- [x] Caveats attach to `DesignTurnContext.advisorConditions`, not to
      `.marvin/backlog/`. `parkCaveats` deleted as orphaned.
- [x] The durable `.marvin/advisor-caveats.md` write is unchanged and still
      immediate — pinned by a test asserting the record survives while the
      backlog stays empty.
- [x] The `PostToolUse` line states the caveats are conditions on this scope
      and names the three legal answers.
- [x] `hasWorkflowGap` treats an unanswered condition as a gap; the field is
      optional so pre-ADR-0100 callers do not fire a corrective turn on every
      clean close.
- [x] The reconcile prompt asks `met` / `not met` / `waived` per condition and
      instructs parking of **only** the unmet and waived ones, stating
      explicitly that a met condition needs no backlog item.
- [x] Two consults in one turn append rather than replace — a lost obligation
      with no error is the failure mode this whole ADR is about.
- [x] A failed record write is reported as "caveats exist ONLY in this context
      window", since the record is now the only parse-time write and therefore
      the floor.
- [x] ADR-0095 amended to point here.
- [x] 1043 sidecar tests green (6 new).

**Not done, deliberately:** no check that a stated `met` is true. ADR-0095's
reasoning holds — that is a correctness oracle a hook cannot be, and building
one drifts toward the supervisor shape Golden Rule 1 forbids. The design makes
the question unavoidable; the answer stays the executor's, and the user reads
it.
