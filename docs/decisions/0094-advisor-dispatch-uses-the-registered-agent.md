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
