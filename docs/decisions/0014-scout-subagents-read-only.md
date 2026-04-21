# ADR-0014 — Read-only scout subagents for parallel research

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0007 — Advisor as a userland subagent pattern](./0007-advisor-as-subagent-pattern.md)

## Context

MARVIN's [golden rule 1](../../CLAUDE.md) has always said: *single assistant,
not an agent team.* The research it cites is on *multi-agent autonomy* —
role catalogs ("frontend agent", "backend agent"), flat-topology swarms,
Kanban-as-source-of-truth pipelines. Those patterns degrade up to ~70 %
on sequential code work and amplify error rates 17× in flat-topology
"bag of agents" setups (2026 multi-agent coding literature).

What the rule did not ban — and [ADR-0007](./0007-advisor-as-subagent-pattern.md)
confirmed is compatible — is a single orchestrator occasionally spawning a
short-lived subagent for a bounded, parenthetical task. The advisor is
exactly that: one subagent, spawned by MARVIN, Opus-hinted, returning a
structured opinion. Not a team.

Claude Code's baseline behaviour goes a step further: it routinely spawns
read-only *scout* subagents via the `Task` tool for breadth-first
research ("find every call site of X", "compare five bug hypotheses in
parallel"). This is plainly faster than serial file reads on codebase-
wide questions. MARVIN's `personality.ts` already had a "When to delegate
to a subagent" section (lines 803-825) pointing at the same pattern.
Nothing enforced it. Nothing constrained the subagent's capabilities.

Three concrete gaps motivated this ADR:

1. **No write-tool constraint.** A spawned subagent inherits the full
   `claude_code` preset — Edit, Write, Bash included. The operating-model
   premise ("Claude is the orchestrator, scouts just read") was not
   enforced by anything. A runaway scout could commit code.
2. **No knowledge-graph inheritance.** The `marvin-graph` MCP server is
   registered per-turn on the parent session
   (`packages/runtime/src/sdk-runner.ts:207-213`); spawned subagents do
   not see it. A research subagent dispatched to "survey every call site
   of X" would grep-and-pray — a direct violation of
   [golden rule 7](../../CLAUDE.md) (graphify first).
3. **No UI signal.** Advisor consults light the companion orb via
   `description: "advisor: …"` prefix detection. A generic research
   subagent had no matching plumbing, so the user would see MARVIN
   "thinking" for 30 s with no indication it had forked into three
   parallel scouts.

This ADR closes all three gaps by defining a sanctioned *scout* agent
wired through the SDK's `agents` option.

## Decision

**Register one custom subagent type — `scout` — at SDK initialisation.
It inherits the knowledge graph, is denied write tools at the SDK layer,
and is the only kind of non-advisor subagent `personality.ts` sanctions.**

Specifically:

### 1. SDK wiring (`packages/runtime/src/sdk-runner.ts`)

A new `agents` option is passed alongside `mcpServers`:

```ts
agents: {
  scout: {
    description:
      "Read-only research scout. Spawn for breadth-first exploration " +
      "(parallel searches across a codebase, competing-hypothesis " +
      "investigation) — never for writes or sequential implementation.",
    disallowedTools: ["Edit", "Write", "Bash", "NotebookEdit"],
    mcpServers: ["marvin-graph"],
    prompt: SCOUT_SYSTEM_PROMPT,
    model: "inherit",
  },
}
```

- **`disallowedTools`** is the SDK-level enforcement. Even if MARVIN's
  prompt for the scout accidentally asked it to edit, the SDK refuses
  the tool call before it reaches the model's turn. Belt and braces with
  `tools?: string[]` rejected in favour of a denylist: if Anthropic adds
  new read-only built-ins later, scouts pick them up automatically; they
  never pick up new write tools without explicit ADR amendment.
- **`mcpServers: ["marvin-graph"]`** is the key fix for graphify-first
  discipline. The string form references the parent's already-registered
  MCP server by name, so scouts see the same graph tools the main turn
  does: `graph_summary`, `graph_search`, `graph_neighbors`, `graph_path`.
  `marvin-playwright` is deliberately NOT inherited — scouts are
  *read-only research*, not driving browsers.
- **`model: "inherit"`** keeps cost in line with the parent turn. Scouts
  are meant to be cheap parallel work, not Opus-escalation; that's the
  advisor's job.
- **`prompt`** embeds the scout's operating contract: graph-first, read-
  only, return a concise synthesis.

### 2. Personality rules (`packages/runtime/src/personality.ts`)

The existing "When to delegate to a subagent" section (lines 803-825) is
tightened from guidance into a MUST / MUST-NOT list, matching the
structure of the graphify-first and advisor-trigger surfaces.

**When to dispatch a scout (MUST use the `scout` subagent type):**

1. Three or more independent searches/reads that would otherwise run
   serially (for-loop of greps, five competing bug hypotheses).
2. Breadth-first exploration of an unfamiliar area ("survey every call
   site of X", "list every file that touches Y").
3. Context pressure: the main conversation is running hot and the answer
   can be summarised without pulling the full source corpus into the
   parent context window.

**When NOT to spawn any subagent:**

1. Single-question lookups (one grep, one file read). Scout overhead is
   ≥4× the tokens of an inline tool call.
2. Sequential implementation — refactors with shared state, feature work
   where later steps depend on earlier decisions. Research is
   unambiguous: multi-agent coordination degrades up to ~70 % on
   sequential tasks.
3. Anything user-facing. The user talks to MARVIN. Scouts return
   synthesised findings; MARVIN owns and delivers the answer.

**Invocation shape:**

```
tool_use Task:
  subagent_type: "scout"
  description: "scout: <one-line topic>"
  prompt: <graph-first brief: the question, and what graph query
           the parent has already run, so the scout doesn't repeat it>
```

The `description: "scout: …"` prefix mirrors ADR-0007's `"advisor: …"`
convention. The companion orb (follow-up PR) uses it as the UI signal.

### 3. Golden rule 1 amendment (`CLAUDE.md`)

The ban stays. What changes is an explicit carve-out sentence referencing
ADR-0007 and this ADR, so future readers don't re-derive the single-
assistant rule as an absolute ban on the `Task` tool:

> "Do not reintroduce multi-agent dispatch, role catalogs, pipeline
> rules, or Kanban-as-source-of-truth. The one sanctioned exception is a
> read-only subagent spawned by the main session for a bounded,
> parenthetical task — the `advisor` (ADR-0007) and the `scout`
> (ADR-0014). Any new subagent type requires a new ADR."

## Consequences

**Positive:**

- **SDK-enforced read-only.** The `disallowedTools` denylist runs at the
  SDK gate — the scout literally cannot call Edit/Write/Bash even if its
  prompt or Task description drifts. Golden rule 1 is now structurally
  defended, not just prose.
- **Graphify-first extends to scouts.** Scouts inherit `marvin-graph`
  via `mcpServers: ["marvin-graph"]`, so the rule "query the graph
  before reading files" applies to parallel research the same way it
  applies to the main turn.
- **Observable.** Scout dispatches surface as `tool_use` events with
  `name === "Task"` and `description` matching `/^\s*scout[\s:—-]/i` —
  the same detection pattern ADR-0007 uses for the advisor orb. The UI
  companion is a small follow-up PR, not a rebuild.
- **Single-assistant invariant preserved.** The main MARVIN session
  remains the orchestrator, synthesiser, and sole voice to the user.
  Scouts are inputs, not co-authors.
- **Amortises well.** Once three-or-more parallel searches are
  sanctioned, codebase-wide questions ("where do we encode session
  IDs", "every place we set a cookie") finish in one scout round instead
  of a serial for-loop of greps in the parent turn.

**Negative:**

- **Prompt-engineering risk.** Under-briefed scouts hallucinate.
  Mitigated by: (a) the scout's system prompt mandates graph-first, so
  the first tool call is always a graph query; (b) the MUST-dispatch
  rules require the parent to include what it has already found in the
  scout brief.
- **Cost floor raised.** A scout round is ≥4× the tokens of an inline
  grep. The MUST-NOT list ("single-question lookups") keeps this bounded
  but MARVIN will occasionally pay the overhead on a borderline call.
- **Two subagent carve-outs now exist.** If a third case arises
  (long-running background work? vision-heavy visual diff analysis?), a
  new ADR is required. Keeps the total short and intentional.

**Neutral:**

- **Advisor and scout do not overlap.** Advisor is Opus-hinted,
  opinion-shaped, one-off — for "tell me if this design is wrong."
  Scout is inherit-model, read-only, parallel-friendly — for "go find
  every X." The description prefix disambiguates in the UI and in
  transcripts.
- **`marvin-playwright` is not inherited by scouts.** Scouts don't drive
  browsers. If a use case arises for that, it's a new subagent type and
  a new ADR — not a scout expansion.

## Alternatives considered

### Leave golden rule 1 as an absolute ban, and never spawn subagents

*What it is:* Interpret "single assistant" strictly. No advisor, no
scout, no Task calls.

*Why plausible:* Simplest mental model. Cannot accidentally reintroduce
multi-agent autonomy if there is no mechanism for it.

*Why rejected:* ADR-0007 already carved out the advisor on the same
logic that applies here — a main-session-orchestrated, short-lived,
parenthetical task is not the failure mode the research warned about.
Forbidding scouts on a stricter reading of golden rule 1 would also
forbid the advisor, which demonstrably delivers value. The honest rule
is the distinction: one orchestrator with bounded scouts ≠ a team. This
ADR codifies that distinction.

### Allow scouts but do not constrain tools at the SDK layer

*What it is:* Keep `personality.ts` telling MARVIN "only dispatch scouts
for read-only work" and trust the prompt.

*Why plausible:* Less code. The advisor pattern works that way today.

*Why rejected:* Prompt-as-contract has a failure mode: under context
pressure MARVIN can misroute, e.g. dispatching a "scout" with a prompt
that says "fix the bug you find." Today nothing stops that subagent
from calling Edit. SDK-level `disallowedTools` makes the constraint
structural — if MARVIN bugs out, the SDK refuses the write. This is the
same defence-in-depth principle ADR-0004 applies to the main channel
(prompt + `canUseTool` gate), extended to the subagent channel.

### Use an allowlist (`tools: ["Read", "Grep", "Glob"]`) instead of a denylist

*What it is:* Explicitly enumerate the tools scouts may call, rather
than listing what they may not.

*Why plausible:* Allowlist is tighter. A new write tool shipped by
Anthropic would not silently become scout-callable.

*Why rejected:* Allowlist forces scout maintenance every time Anthropic
adds a read-only tool (a new search primitive, a new metadata reader).
The failure mode of forgetting to add it is "scouts silently lose a
capability" — painful to debug. Denylist's failure mode is "scouts
silently gain a new *read* capability" — benign. For write tools
specifically, the existing ADR-0004 confirm gate is the backstop even
in the theoretical case a new write tool slipped through.

### Let scouts see `marvin-playwright` as well

*What it is:* Scouts could drive a browser during research (read a
rendered page, verify a URL is live).

*Why plausible:* "Read a rendered page" is a read operation, technically
compatible with the read-only framing.

*Why rejected:* Playwright's action tools (click, type, navigate,
file_upload) are write-equivalent from a blast-radius perspective —
they can mutate external state, submit forms, trigger network writes.
Scoping scouts to `marvin-graph` keeps the read-only contract
unambiguous. If a research use case genuinely needs a live browser, it
escalates back to the main session.

### Keep running scouts as generic `Task` calls with no agent definition

*What it is:* Don't register anything in the `agents` option. Use the
default `general-purpose` subagent type, rely on prompt hygiene.

*Why plausible:* Zero SDK config change. Works today.

*Why rejected:* This is exactly the state ADR-0007 deemed insufficient
for the advisor, and the reasons are identical: the scout's contract
(read-only, graphify-aware) has to be encoded somewhere. The SDK's
`agents` option is the right surface — it's what Anthropic built for
this — rather than hoping the prompt gets it right every time.

## Verification

- `pnpm -r typecheck` green after the SDK-option addition in
  `sdk-runner.ts`.
- `packages/runtime/src/sdk-runner.test.ts` — new case asserting
  `agents.scout` exists in the Options passed to `query`, with
  `disallowedTools` containing Edit/Write/Bash and
  `mcpServers: ["marvin-graph"]`.
- Grep check: `rg 'subagent_type: "scout"' packages/runtime/src/personality.ts`
  returns the invocation-shape documentation (proves the rule is
  codified in MARVIN's actual prompt, not just this ADR).
- Manual: dispatch a scout from a MARVIN session, confirm the Task
  event fires with description prefix `scout:`, confirm the subagent
  calls `graph_search` as its first action, confirm an accidental
  `Edit` call would be refused at the SDK gate. (The orb UI is a
  follow-up PR; not blocking this ADR.)

## Related

- [ADR-0004 — Structural confirm-before-act gate](./0004-structural-confirm-gate.md) — the parent-session write gate this ADR extends to subagents.
- [ADR-0007 — Advisor as a userland subagent pattern](./0007-advisor-as-subagent-pattern.md) — the first sanctioned subagent carve-out.
- [`packages/runtime/src/sdk-runner.ts`](../../packages/runtime/src/sdk-runner.ts) — where the `agents` option is wired.
- [`packages/runtime/src/personality.ts`](../../packages/runtime/src/personality.ts) — the "When to dispatch a scout" trigger surface.
- [`CLAUDE.md`](../../CLAUDE.md) — golden rule 1 amendment referencing this ADR.
- [`docs/security/tool-policy.md`](../security/tool-policy.md) — policy table now covers scout tool constraints.
