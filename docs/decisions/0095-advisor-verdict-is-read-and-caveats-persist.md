# ADR-0095 — The advisor's verdict is read, its caveats outlive the context window

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0094](./0094-advisor-dispatch-uses-the-registered-agent.md) (fixed which agent is dispatched; this fixes what happens to its answer), [ADR-0033](./0033-advisor-registered-agent-per-role-effort.md), [ADR-0047](./0047-backlog-capture-at-discovery.md) (the un-gated capture-at-discovery pattern this reuses), [ADR-0044](./0044-project-backlog.md), [ADR-0007](./0007-advisor-as-subagent-pattern.md)

## Context

The advisor gate has only ever observed the **dispatch**. `recordToolCall`
sees the `Agent` call in `PreToolUse`, increments `advisorCallCount`, and that
is the whole interaction. The advisor's reply returns as an ordinary
`tool_result`: the executor reads it, and it exists nowhere else. Nothing
parses it, stores it, or surfaces it. A `reject` discharges the gate exactly
as a `go` does.

Observed live on 2026-08-30 (session `711b8605`, a prod `platform_audit`
migration on the agri-saas project). The advisor returned **go-with-caveats**
with four numbered caveats, one of them the compliance-relevant finding that
the ~23-hour gap in the audit hash chain — not the visible 500 — was the
serious part of the incident. All four were addressed. They were addressed
because the model still had them in context and chose well; the session hit
`compacting` **seven seconds** after it opened the ADR to act on the fourth.
Nothing in the system was holding that advice.

The exposure is not "MARVIN ignores the advisor". It is that the advice is as
durable as a context window, and context windows end without warning.

### What the platform actually offers

The public hooks documentation is discouraging and, for this SDK version,
incomplete:

> `PostToolUse` | Can block? **No** | "Shows stderr to Claude; the tool already ran"

> `SubagentStop` | Can block? **Yes** | "Prevents the subagent from stopping"

`SubagentStop` is the wrong lever regardless: it carries only
`last_assistant_message`, its blocking power stops a subagent from *finishing*
(the opposite of what is wanted), and it cannot inject into the main
conversation.

The hooks page never documents `updatedToolOutput`. The SDK 0.3.245 type
declaration does:

```ts
export declare type PostToolUseHookSpecificOutput = {
    hookEventName: 'PostToolUse';
    additionalContext?: string;
    /** Replaces the tool output before it is sent to the model */
    updatedToolOutput?: unknown;
    /** Replaces the output for MCP tools only. Prefer updatedToolOutput, which works for all tools */
    updatedMCPToolOutput?: unknown;
};
```

So a `PostToolUse` hook can read a tool's result and shape what the model sees
from it. This is not speculative: MARVIN's **output governor**
(`output-governor.ts`, 2026-08-29) already ships on exactly this field, and a
`PostToolUse` hook is already wired at `sdk-runner.ts`. This is ADR-0073 and
ADR-0079's lesson a third time — verify against the artifact, not the prose
about the artifact.

## Decision

A `PostToolUse` hook on the subagent dispatch tool, keyed on the same advisor
detection ADR-0094 established. Deterministic string work — no LLM, no extra
turn.

1. **Read the verdict.** Parse the `## Verdict` section to
   `go | go-with-caveats | reject | unparsed` and record it on
   `DesignTurnContext` as `advisorVerdict`.
2. **Persist the caveats.** Each numbered caveat is parked to
   `.marvin/backlog/` via `addBacklogItem(..., { provisional: true })` —
   ADR-0047's capture-at-discovery: un-gated at write, consent deferred to the
   keep/dismiss review at the scope-met handoff. Compaction can no longer lose
   them, and "the advisor said X, we shipped without X" becomes a visible open
   item. Near-duplicate detection (ADR-0070) already prevents a re-consult from
   re-parking the same advice.
3. **Say so in the result.** One line appended via `additionalContext` — NOT
   `updatedToolOutput`. The advisor's own words are the point here; the
   governor replaces content because the content is the problem, which is the
   opposite case.
4. **`reject` denies once.** A rejected verdict blocks the next mutation of a
   trigger path once, quoting the verdict back, and a second attempt proceeds.

### Why fired-once for `reject`

A hard block would hand a subagent a veto over the user's working tree, and a
`reject` is sometimes just miscalibrated context — an unacceptable failure mode
during a production incident at 3am. A purely advisory `reject` leaves the
gate's teeth entirely in the dispatch, which is the status quo this ADR exists
to change. Firing once forces the verdict to be *seen* and leaves the decision
with the user; it is also the pattern the file already uses for the dispatch
gate (`advisorHookFiredForPaths`).

### Explicitly not decided here

**No check that a caveat was implemented.** That is a correctness oracle a hook
cannot be, and it drifts toward the supervisor-agent shape Golden Rule 1
exists to prevent. Make the advice durable and visible; the judgement stays
with the user.

## Consequences

- Advisor caveats survive compaction, session end, and a distracted executor.
- The keep/dismiss review at scope-met gains a new source of items; a
  consult with four caveats adds four provisional entries, and dismissing them
  is one click each.
- Caveat splitting is regex over model prose and will sometimes mis-parse. It
  fails toward keeping too much: when parsing yields no caveats, the whole
  verdict section is parked verbatim as a single item rather than dropped.
- A `reject` costs one extra round trip on a path the user may well proceed
  with anyway. Accepted: that round trip is the point.

## Amendment 2026-08-30 — the three soft spots, made hard

The first implementation shipped with three compromises. Each was a place
where the mechanism relied on something it could not enforce; all three are
now closed.

**1. Parsing prose → the advisor emits structure.** Caveat splitting was a
regex over model prose, so the shape of a caveat list — inline `(1) … (2) …`
versus a markdown list — was the advisor's stylistic choice and the parser's
guess. `AgentDefinition` has no `outputSchema` in SDK 0.3.245 (checked), but
the advisor's *system prompt* is ours, so the contract moved to the source:
the registered agent now ends every reply with a ` ```marvin-verdict ` block
carrying `verdict:` and a `caveats:` list, and `parseAdvisorReply` reads that
first. The prose parser stays as the fallback and is a **live** path, not a legacy
one: the advisor model is the user's pick from the Settings model picker
(Opus is only the default when nothing is chosen), so a Haiku-tier advisor
that half-follows the block format is a normal case, not an edge one.
`ParsedAdvisorReply.structured` records which path ran and the telemetry line
carries the advisor model beside it, so the structured-rate is readable **per
model** — otherwise "the advisor prompt has drifted" and "the user picked a
small model" are the same number. A malformed block falls back to prose
instead of reporting `unparsed`.

**2. A swallowed backlog failure → every refusal is surfaced, and disk is the
floor.** The `catch` discarded the error, leaving `parked: 0` in telemetry with
no cause. Worse, `addBacklogItem` returns `{ok: false}` for the 200-item cap
and for validation — *not* exceptions, so those never reached the catch at all
and vanished silently. Now: the reason is captured and logged per item, an
oversized body is truncated with a marker rather than refused (the
whole-verdict fallback is exactly the shape that exceeds the 2000-char body
cap, so the safety net was the most likely thing to fail), and anything the
backlog still refuses is appended to `.marvin/advisor-caveats.md` — a plain
file with no caps, no validation and no index to rebuild, so it cannot fail
for the reasons the backlog can. The `additionalContext` line names the reason
and the fallback path.

**3. Prose telling MARVIN the rules changed → a hook.** "Do not re-run the
advisor for a friendlier verdict" was guidance in `personality.ts`, and this
repo has already measured what that is worth: the 2026-05-22 audit found five
of six soft-nudge skill triggers firing ~0× across thousands of qualifying
contexts. A second advisor dispatch, once a verdict is recorded, is now denied
— once, with the first verdict quoted back. It fires only on an advisor
dispatch (a scout is untouched) and only when a verdict actually landed, so a
consult on a genuinely different question proceeds on retry.

## Scope of Done

- [x] Verdict parsed to `go | go-with-caveats | reject | unparsed`, recorded
      on the turn context
- [x] Caveats parked as `provisional` backlog items; empty parse falls back to
      the verbatim verdict section
- [x] `additionalContext` states the verdict and what was captured
- [x] `reject` denies the next trigger-path mutation exactly once
- [x] Parser is pure and test-pinned against real advisor output
- [x] Advisor emits a `marvin-verdict` block; parser prefers it, falls back to
      prose, and records which path ran
- [x] Every backlog refusal is surfaced with its reason; oversized bodies are
      truncated, not refused; `.marvin/advisor-caveats.md` is the floor
- [x] Re-consulting the advisor after a verdict is denied by a hook, not prose
- [ ] Not in scope: verifying caveats were implemented, blocking on `reject`
      permanently, surfacing the verdict in the macOS UI

## Amendment — 2026-08-30: one record, one item, promote at the review

**What was wrong: the granularity, and only the granularity.**

Decision 2 parked one provisional backlog item *per caveat*. Measured on a
real session the same day the ADR shipped:

| | |
|---|---|
| Items parked in ~60 seconds | **12** |
| Dismissed at the scope-met review | **10** |
| Kept | **2** |

The 10 were not bad advice. They were advice the executor had **already acted
on in that same turn** — decision 3's `additionalContext` does reach it, and it
works. They arrived pre-satisfied and still had to be closed one at a time. The
cost is not the writes; it is that the 2 genuine deploy-prerequisite items sat
among 10 dismissible ones, which is how a real item gets missed.

The user put it directly: *"if we park all items returned by advisor, then we
can add 10-15 or a large number of items in the backlog… then we need to handle
them one by one."*

**What the guidance actually says.** Anthropic's
[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
is explicit that **"compaction isn't sufficient"** and that state should be
externalised so a fresh context window can pick it up. That is the premise this
ADR was right about. But the artefact it describes is a **file** — a progress
log, a spec — not a queue of tickets. We implemented "externalise durable
state" as "create backlog items", and that is the mismatch.

**Amended decision.**

2a. **Every caveat is written to `.marvin/advisor-caveats.md` immediately**, before
    anything can refuse it. Durable, survives compaction, no cap, zero review
    burden. This file was already the fallback; it is now the primary record.
2b. **ONE provisional backlog item per consult**, titled `Advisor: N caveats on
    <topic>`, whose body lists the caveat titles and points at the file — so the
    review is actionable without opening it, and "the advisor said X, we shipped
    without X" stays visible.
2c. **Promotion happens at the scope-met review**, where the user already has the
    context to say which caveats are still open. Only survivors become items.
    On the measured session this would have produced exactly the 2 that mattered.

Decisions 1, 3 and 4 are unchanged. **Runtime handling remains the primary
path** — the record is a safety net, and the appended line now says so in as
many words ("Act on them in THIS turn where they apply; the record is a safety
net, not a substitute"), because the original wording let the durable half read
like the mechanism.

**Still explicitly not decided:** any check that a caveat was *implemented*.
The original refusal stands and is load-bearing — that is a correctness oracle
a hook cannot be, and it drifts toward the supervisor shape Golden Rule 1
exists to prevent. Promotion is a judgement, and the judgement stays with the
user.

**Also rejected:** severity-filtering caveats at parse time. The hook is
deterministic string work with no LLM; it cannot tell which caveat matters, and
guessing would silently drop the important one — the exact failure this ADR was
written to prevent.

### Scope of Done (amendment)

- [x] Caveats recorded to `.marvin/advisor-caveats.md` on every consult
- [x] Exactly one provisional backlog item per consult, pointing at the record
- [x] Item body lists caveat titles and stays under the body cap by construction
- [x] Appended line states runtime handling is primary
- [x] Record-write failure is the loud case (caveats exist only in context)
- [x] 28 assertions green, including an oversized verdict surviving in full

## Amendment — 2026-08-31: caveats move off the backlog (ADR-0100)

Decision 2 above — park each caveat to `.marvin/backlog/` at parse time — is
superseded by [ADR-0100](./0100-advisor-caveats-are-conditions-not-backlog.md).

The durability goal was right and is kept. The destination was wrong: a caveat
is a **condition on a `go` already given**, not deferred work, and ADR-0044
built the backlog for deferred work specifically. Parking at parse time
converts a precondition into a someday, and drops the conditionality that made
the verdict `go-with-caveats` rather than `go`.

Under ADR-0100 caveats live on `DesignTurnContext` while the scope is open and
transfer to the backlog **at the scope-met handoff, only if unmet or waived** —
which is the first moment they honestly are deferred work.

Everything else in this ADR stands: the verdict parse, the `additionalContext`
line, the fire-once `reject` deny, and the reasoning for why a hook must not
try to be a correctness oracle.
