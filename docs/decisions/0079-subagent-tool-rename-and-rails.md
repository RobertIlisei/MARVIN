# ADR-0079 — The subagent tool renamed under us; Golden Rule 1 stands, the rails become mechanical

- **Status:** Accepted
- **Date:** 2026-08-29
- **Related:** [ADR-0007](./0007-advisor-as-subagent-pattern.md) (advisor),
  [ADR-0014](./0014-scout-subagents-read-only.md) (scout),
  [ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md) (the `agentID` read-only invariant),
  [ADR-0054](./0054-plugin-agents-read-only-hooks-stay-stripped.md) (plugin-agent dispatch gate),
  [ADR-0058](./0058-parallel-graph-extraction-scoped-write-subagent.md) (Haiku extraction remap),
  [ADR-0059](./0059-session-auditor-runtime-dispatched-read-only.md) (auditor must not spawn agents),
  [ADR-0073](./0073-agent-sdk-0-3-upgrade.md) (the upgrade whose verification this corrects)

## Context

Two questions arrived together: *"how could we set up multi-agent working on
MARVIN"*, and a request for a deep dive on Anthropic's official guidance.
Answering the first meant reading what MARVIN's gate actually does with a
subagent dispatch. It does nothing.

**Claude Code renamed the subagent tool `Task` → `Agent` in v2.1.63.** MARVIN
matched the literal string `"Task"` in five places. A scan of 12 real
transcripts from this machine:

```
{'Agent': 200}   general-purpose 148 · scout 41 · Explore 6 · (none) 5
```

**200 dispatches. Every one named `Agent`. Not one named `Task`.**

| Site | What it did | What it had been doing instead |
|---|---|---|
| `policy.ts` `KNOWN_TOOL_NAMES` | the gate's canonical tool set | `Agent` absent → `classifyToolCall` fell through to its *"not in the gated set"* blanket-allow. **Subagent dispatch was ungated entirely** |
| `policy.ts` `if (name === "Task")` | ADR-0054's unknown-`subagent_type` confirm | never fired; a plugin agent or a typo'd type dispatched silently |
| `design-hooks.ts` `if (toolName === "Task")` | counts advisor consults | `advisorCallCount` stayed 0, so the advisor-on-ADR-trigger hook could never be discharged |
| `sdk-runner.ts` `if (toolName !== "Task") return null` | ADR-0058's Haiku remap | graphify's extraction fan-out ran on the executor's frontier model. **Real, ongoing, unmeasured cost** |
| `session-auditor.ts` `AUDITOR_DISALLOWED_TOOLS` | ADR-0059 §2: the auditor must not spawn agents | `"Task"` in a `disallowedTools` list the model never sees, because the model calls `Agent`. The auditor could spawn — the exact model→model edge ADR-0059 forbids |

ADR-0073 recorded the opposite, and said it was verified live:

> Verified live, not inferred: a 0.3.245 session … reports **subagent tool
> `Task`** — the wire name MARVIN's gate matches on … is unchanged.

That verification read `system/init`, which still advertises the old name. The
`tool_use` blocks — the only thing `canUseTool` and the hooks ever see — carry
the new one. **The check looked at the wrong surface, and the wrong surface
agreed with us.** This is the second time a rename has passed a green
verification (ADR-0073's own `TodoWrite` finding was the first), and both times
the tell was the same: nothing errored, a guard just stopped matching.

## What Anthropic's guidance actually says

The research question deserves a direct answer, because the honest one is
"no change": the current official guidance **argues for Golden Rule 1**, not
against it.

> "most coding tasks involve fewer truly parallelizable tasks than research"
>
> multi-agent fails in "domains that require all agents to share the same
> context or involve many dependencies between agents"
>
> "multi-agent systems use about **15× more tokens** than chats"

The documented failure modes are verbatim the ones Golden Rule 1 exists to
prevent — agents "spawning 50 subagents for simple queries", "duplicate work,
leave gaps". Multi-agent is recommended for *breadth-first research with
separable subtasks*, which is precisely the shape MARVIN already carves out
for the scout (ADR-0014) and read-only dynamic workflows (ADR-0030).

**Decision: Golden Rule 1 is unchanged.** Parallel *implementation* on shared
state stays forbidden. No new subagent type, no supervisor, no swarm.

What *has* changed since the rule was written is that the SDK now offers
mechanical rails for the shape MARVIN already permits. Prose said "one level
deep, bounded"; nothing enforced it. That gap closes here.

## Decision

**1. Match both spellings, from one place.** `SUBAGENT_DISPATCH_TOOLS` +
`isSubagentDispatch()` in `@marvin/tools/policy` are now the single definition;
`Agent` joins `Task` in `ToolName`, `KNOWN_TOOL_NAMES`, `BASE`, and
`AUDITOR_DISALLOWED_TOOLS`. Keeping the old name costs nothing and preserves
older SDK pins. Every gating test is `describe.each(["Task", "Agent"])`, so a
third rename fails a test instead of silently disarming the gate.

**2. The prompt names the tool the model actually has.** `personality.ts` and
the design-hook steer told MARVIN to emit `tool_use Task:`. Now `Agent`, with
the old name noted as a fallback.

**3. Depth and concurrency become env rails, not prose.**
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` and
`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=8` in `turnEnv` (SDK defaults: 3 and 20).
Every sanctioned subagent is one level deep by design and `personality.ts`
already tells scouts "no nested subagent dispatches" — depth 2 leaves one level
of slack for a plugin agent that legitimately fans out. A user who sets either
variable keeps their own value.

**4. Every registered agent gets a turn ceiling.** `maxTurns` — scout 40,
advisor 20, graph-extractor 15. Nothing bounded a runaway subagent before; it
burned the parent turn's budget with no ceiling and no signal to the user.

### Considered and not taken

- **`options.maxBudgetUsd`** — a per-turn spend cap exists in 0.3.245, but it
  applies to the *whole turn*, not the subagent subtree. Setting it would kill
  legitimate long implementation turns, which is a worse failure than the one it
  prevents. Revisit if the SDK scopes it to subagents.
- **`AgentDefinition.effort` on the scout** — available, and lowering it would
  save money. Not taken: MARVIN already has a dynamic-effort ladder
  (`effort.ts`), and silently downgrading scout reasoning is a quality change
  wearing a cost-saving's clothes. It belongs in the ladder, if anywhere.
- **`skills: ["graphify"]` preloading** — attractive (a scout could skip
  discovery), but the skill is installed per-user and a missing name is a
  turn-level failure. Needs an installed-check first.
- **A standing supervisor agent** — already rejected 2026-07-24; nothing in the
  new guidance reopens it.

## Consequences

- Subagent dispatch is gated again: an unknown `subagent_type` confirms, and the
  ADR-0030 collapse applies to the dispatch itself, not only to the inner calls.
- ADR-0058's Haiku remap fires, so graphify's semantic pass costs what the ADR
  said it would. The saving was never realised on any run before today.
- The session auditor can no longer spawn agents — ADR-0059 §2 is enforced
  rather than declared.
- A runaway subagent now stops at its turn ceiling instead of at the user's
  patience.
- **ADR-0073's "verified live" line is wrong** and is corrected there and in
  `CLAUDE.md`. The lesson generalises: verify a tool-name contract against a
  `tool_use` block from a real transcript, never against `system/init`.

## Scope of Done

- [x] `isSubagentDispatch` is the only place either spelling is written, and
      every former `=== "Task"` site calls it
- [x] `Agent` is in `KNOWN_TOOL_NAMES`, so dispatch can never again reach the
      not-in-the-gated-set blanket-allow
- [x] Gating, remap, advisor-count and auditor tests all run under both names
- [x] Depth/concurrency rails and per-agent `maxTurns` are set, and overridable
- [x] ADR-0073 and `CLAUDE.md` no longer claim the tool is named `Task`
- [ ] Not in scope: any change to Golden Rule 1, any new subagent type, and the
      `maxBudgetUsd` / `effort` / `skills` levers listed above
