# ADR-0094 — The advisor gate prescribes the registered `advisor` agent, not `general-purpose`

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0033](./0033-advisor-registered-agent-per-role-effort.md) (registered the agent this restores), [ADR-0007](./0007-advisor-as-subagent-pattern.md) (the original `general-purpose` + model-hint spawn), [ADR-0079](./0079-subagent-tool-rename-and-rails.md) (the last time a literal string in the gate went stale)

## Context

ADR-0033 registered `advisor` in the SDK `agents:` map precisely because the
subagent tool's input carries no `effort` field, so per-advisor reasoning
effort can only be set on an `AgentDefinition`. The definition
(`buildAdvisorAgent`, `sdk-runner.ts:530`) also pins `disallowedTools: [Edit,
Write, Bash, NotebookEdit, WebFetch]`, `mcpServers: ["marvin-graph"]`, an
the user's chosen advisor `model` (the Settings picker over `/api/models`;
the latest Opus tier only as the default when nothing is selected), and
`maxTurns: 20`. `personality.ts` tells MARVIN to
dispatch it with `subagent_type: "advisor"`.

The `advisor-on-ADR-trigger` deny message in `design-hooks.ts` never moved.
It still prescribes the pre-ADR-0033 shape verbatim:

```
subagent_type: "general-purpose"
model:          "opus"
```

The deny message is what MARVIN reads at the moment it is blocked, so it wins
over the prompt. Observed live on 2026-08-30 (session `711b8605`, a prod
`platform_audit` migration on the agri-saas project): the gate fired, and the
consult that followed ran as `general-purpose` — no `effort`, no read-only
`disallowedTools` backstop, no `marvin-graph`, no turn cap, and an abbreviated
inline copy of a prompt the registered definition already carries in full.
The gate was steering MARVIN away from the agent ADR-0033 built for exactly
this call.

A second, latent fault makes the naive fix wrong. `recordToolCall` counts a
consult only when the dispatch `description` starts with `"advisor:"`
(`design-hooks.ts:338`). Switching the prescribed dispatch to
`subagent_type: "advisor"` with a natural description would leave
`advisorCallCount` at 0 — the gate would not register its own remedy. This is
the ADR-0079 failure mode repeating: a guard keyed on a literal string that
the thing it guards no longer emits.

## Decision

1. **The deny message prescribes the registered agent.** It names
   `subagent_type: "advisor"` and drops the `model` hint and the inline prompt
   body — the registered definition owns both. The structure the advisor
   returns (Risks / Alternatives / Pushback / Verdict) stays in the message as
   a statement of what comes back, not as a prompt to paste.
2. **The counter recognises both routes.** `advisorCallCount` increments when
   the dispatch names `subagent_type: "advisor"` **or** when the description
   carries the `advisor:` prefix. The prefix route is kept because ADR-0007's
   `general-purpose` spawn remains policy-sanctioned for back-compat, and a
   consult run that way is still a consult.

Both halves ship together: either alone leaves the gate unable to see its own
remedy discharged.

## Consequences

- Advisor consults triggered by the gate now carry their configured reasoning
  effort, the read-only tool denylist, the graph MCP server, and the turn cap.
- The prompt and the gate agree on one dispatch shape, so there is no longer a
  question of which surface wins.
- The advisor's **verdict** is still not read by anything — a `reject` unblocks
  the retry exactly like a `go`, and caveats persist only as long as the
  context window holds them. That is deliberately out of scope here and is the
  subject of a separate decision.

## Scope of Done

- [x] Deny message names `subagent_type: "advisor"`; no `model` hint, no
      inline prompt body
- [x] `advisorCallCount` increments on `subagent_type: "advisor"` as well as
      the `advisor:` description prefix
- [x] Tests pin both dispatch routes and the message content
- [ ] Not in scope: parsing the verdict, enforcing or persisting caveats,
      making `reject` block

## Amendment — 2026-08-31: a consult that gates work cannot be backgrounded

The gate this ADR built counts a **dispatch**. That was fine while every
dispatch was synchronous. It is not fine now that the subagent tool takes
`run_in_background`.

Observed on a real turn. The executor hit the DB-migration ADR trigger, the
gate fired its remedy, and the executor dispatched the registered advisor —
with `run_in_background: true`. Three failures followed from that one flag:

1. **The gate discharged with no advice in hand.** `recordAllowedTool`
   incremented `advisorCallCount` on the dispatch. It runs *before*
   `canUseTool`, and its own call-site comment already conceded the tally is
   "a slight over-count" when the gate later denies. For an advice
   requirement it is not slight — it marks the consult done.
2. **[ADR-0095](./0095-advisor-verdict-is-read-and-caveats-persist.md)'s
   verdict reader parsed a launch receipt as a critique.** The tool response
   was `"Async agent launched successfully… agentId: …"`. `parseAdvisorReply`
   found no verdict block, fell through to the prose parser, and logged
   `verdict: "unparsed"` — **25 ms after dispatch**. No advisor answers in
   25 ms. The number was in the telemetry the whole time and said nothing,
   because `unparsed` reads as "the advisor wrote something we could not
   parse" (a prompt problem) when the truth was "the advisor never answered"
   (a structural one).
3. **The turn ended with the gated work undone.** To its credit the executor
   did not proceed — it reported the item "blocked on a gate-required advisor
   consult that's still running". But it then ended the turn, and the
   background result never arrived. The user lost a deliverable and only
   found out by asking.

### Decision

**An `advisor` dispatch carrying `run_in_background: true` is `deny`.**

Scoped to the advisor deliberately. A backgrounded `scout` or `Explore` is
the *point* of them (ADR-0014) — the executor collects the answer whenever it
lands, and nothing waits on it. The advisor is different in kind because its
consult **gates the work that follows**, and you cannot act on advice you have
not received. Any subagent whose result is a precondition belongs under the
same rule; one whose result is an input does not.

Three changes, each closing one of the failures above:

- `policy.ts` denies the dispatch, with a reason that names the remedy
  (re-dispatch without the flag).
- `design-hooks.ts` does not count a backgrounded advisor dispatch toward
  `advisorCallCount`, so the gate stays armed even though the counter runs
  ahead of `canUseTool`.
- `advisor-verdict.ts` gains a distinct `async-pending` verdict and an
  `isAsyncLaunchReceipt` detector, so a launch receipt is never mistaken for
  a critique and the telemetry stops reporting a structural failure as a
  formatting one. It also returns a `systemMessage` telling the executor the
  gate is **not** discharged and it must not end the turn with the gated work
  undone.

The deny makes the other two unreachable in normal operation. They stay as
the detectors that say so if it ever is not — the same reasoning as ADR-0079,
where five guards matching a literal went dead in silence.

### Scope of Done

- [x] A backgrounded `advisor` dispatch classifies as `deny`, under both the
      `Agent` and legacy `Task` spellings.
- [x] A foreground advisor dispatch still auto-allows.
- [x] Backgrounding remains allowed for `scout`, `Explore` and
      `graph-extractor`.
- [x] A backgrounded advisor dispatch does not increment `advisorCallCount`.
- [x] A launch receipt parses as `async-pending`, never `unparsed`.
- [x] 4 new tests; 1036 sidecar tests green.

