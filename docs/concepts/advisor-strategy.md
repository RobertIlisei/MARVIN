# Advisor strategy — executor + consulted second opinion

The default MARVIN runtime is **Opus 4.7 alone**. The advisor strategy is an opt-in alternative that runs a cheaper executor (typically Sonnet 4.6) with Opus available as a consulted second opinion on hard steps.

This doc explains what the two modes do, when to use which, and how the consult actually happens. **The mechanism changed on 2026-04-19** — see [ADR-0007](../decisions/0007-advisor-as-subagent-pattern.md) for the history.

## The two modes

| Mode | Executor | Consulted advisor | Cost | Trade-off |
|---|---|---|---|---|
| **Opus** (default) | Claude Opus 4.7 | — | highest | Best quality on every step. No consults. |
| **Advisor** | Claude Sonnet 4.6 | Opus via Task subagent | ~30–40% less on routine work | Sonnet does routine work, consults Opus on hard steps via a subagent. |

The mode is picked via the `models` dropdown in the header (two slots: executor + advisor) and persisted to `localStorage`. The executor slot picks which model runs the turn; the advisor slot is used as a hint when MARVIN spawns a consult subagent.

## What "advisor" means mechanically

**The advisor is a userland pattern on top of the Task subagent tool** — it is *not* a callable tool registered by the Agent SDK. See [ADR-0007](../decisions/0007-advisor-as-subagent-pattern.md) for the full rationale; short version: the SDK has an `advisorModel` Options field described as "the server-side advisor tool", but attempting `tool_use {name: "advisor", ...}` returns `No such tool available: advisor`. The routing knob exists; the client-visible tool does not.

A consult looks like this:

```
tool_use Task:
  subagent_type: "general-purpose"
  model:          "opus"                            ← required
  description:    "advisor: <topic>"                 ← prefix is UI contract
  prompt: |
    You are an advisor consulted by MARVIN's executor on a hard step.
    Be blunt. Structure your response:

    ## Risks the plan misses
    ## Alternatives worth considering
    ## Pushback on the weakest points
    ## Verdict: go / go-with-caveats / reject

    Full context: ...
```

`model: "opus"` is required — without it the subagent runs on the parent turn's model (Sonnet), which defeats the point of a second opinion.

The leading `advisor:` prefix on `description` is how MARVIN's UI detects the consult is happening: the companion orb ([`advisor-orb.tsx`](../../sidecar/src/components/brain/advisor-orb.tsx)) watches `tool_use` events with `name === "Task"` and description matching `/^\s*advisor[\s:—-]/i`.

Consult lifecycle:

1. Executor emits the Task `tool_use` above.
2. Claude Code spawns a subagent on the hinted model.
3. The subagent reads context, forms its structured response, and returns.
4. Executor receives the response as `tool_result` and continues the turn with the advisor's input in context.
5. Executor cites the advisor's substantive input in its reply ("Advisor flagged X; I'm going with Y because ...").

## Why this is faster *and* cheaper

**Cheaper**: Sonnet 4.6 is roughly 1/5 the cost of Opus 4.7 per token. Most tool calls in a typical turn are routine (file reads, grep, mechanical edits). Running those on Sonnet is nearly free.

**Often faster**: Sonnet has lower TTFT than Opus. The bulk of a turn — especially the tool-use loop — latency-benefits.

The logic: most code-work steps are routine, Sonnet handles them fine. The rare hard step gets escalated to Opus via a consult — Opus is still the one making the consequential decision, just without being paid to grep 40 files.

**Cost caveat vs the SDK-native version imagined in ADR-0003**: a Task subagent runs a full sub-conversation, not a true one-shot completion. More tokens per consult than a hypothetical native advisor tool would use. Still a net win on routine-heavy turns; not as clean on consult-heavy turns.

## Rule enforcement

**At turn time, MARVIN uses a deterministic list — not judgement — to decide when to consult.** The authoritative rules live in [`sidecar/packages/runtime/src/personality.ts`](../../sidecar/packages/runtime/src/personality.ts) under "Advisor consult — how to run one" (right after the Skills block). Two enforcement surfaces:

1. **User-directed is non-negotiable** (cross-phase hard rule 7). "Use the advisor" / "consult the advisor" / "get the advisor to help you with this" → a Task-based advisor consult MUST fire at least once in Phase 4 or 5. Cite the reply. Silent skipping is the "MARVIN ignored me" failure mode the rule is named for.

2. **Seven deterministic auto-triggers** (beyond user direction):

   | # | Trigger |
   |---|---|
   | 1 | Writing a new ADR in Phase 4 |
   | 2 | Security-sensitive work (auth, creds, tool policy, shell, file sandbox, persistence) |
   | 3 | Blast radius ≥ 5 files in Phase 3 |
   | 4 | Non-backward-compatible change (schema drops, protocol bumps, removed public exports) |
   | 5 | 2+ viable architecture options with no clear winner (tiebreaker) |
   | 6 | Concurrency / distributed-state work |
   | 7 | Cryptographic choices (KDF, signatures, sessions, transport) |

   Plus an anti-trigger list (typos, lint, mechanical renames, doc-only updates, regenerated artefacts, anything scoped trivial/fast-path) so advisor tokens don't get wasted.

The **companion orb** (`sidecar/src/components/brain/advisor-orb.tsx`) surfaces consult activity in the UI — when it flies in next to the main brain, a Task-based advisor consult is running on the current turn. The caption reads `advisor · <model hint> · <topic>`.

## When to use which

**Default (Opus alone)** when:
- You're doing architecture-critical work. Auth, billing, migrations, protocol design.
- Early in a project, when every decision compounds.
- You want the simplest, most predictable cost behavior.
- Cost is not the binding constraint.

**Advisor (Sonnet executor, Opus consulted)** when:
- Routine feature work in a codebase MARVIN already knows.
- Mechanical refactors, test additions, documentation passes.
- Long sessions on well-understood code where you want the cost saving.
- You want MARVIN to actually show you when it's second-guessing itself.

## How to switch

- Header → `models` pill → pick executor (e.g. `claude-sonnet-4-6`) and advisor (`claude-opus-4-7`).
- Persisted to `localStorage.marvin.executorModel` + `localStorage.marvin.advisorModel`.
- MARVIN's runtime passes both to the Agent SDK via `Options.model` + `Options.advisorModel`. `advisorModel` is opaque today — Anthropic does something with it server-side, we don't rely on it for anything visible. Kept for forward-compat.

## Resolution order

`/api/chat` picks the runtime model via this fallback chain ([`route.ts:89-92`](../../sidecar/src/app/api/chat/route.ts)):

```
const model = body.model?.trim() || resolved.model || defaultModel();
const advisorModel = body.advisorModel?.trim() || resolved.advisorModel;
```

1. **Explicit picker values** (`body.model` / `body.advisorModel`) win. This is what the header sends.
2. **`resolveRuntimeMode(runtimeMode)`** — the older binary toggle. `"opus"` → Opus solo; `"advisor"` → Sonnet + Opus-4.6. Only used if explicit picker values are empty.
3. **`defaultModel()`** — env var `MARVIN_MODEL`, else `claude-opus-4-7`.

The `/api/health` endpoint's `defaultModel` field reports step 3's fallback — it is NOT the live model for any active turn. See [Health checks](../operations/health.md).

## What changed on 2026-04-19

- **Invocation** moved from `tool_use {name: "advisor", ...}` (never worked — tool doesn't exist) to `tool_use {name: "Task", subagent_type: "general-purpose", model: "opus", description: "advisor: ..."}`.
- **Orb detection** retargeted from `name === "advisor"` to `name === "Task"` with the advisor description prefix.
- **Rule 7** still mandates user-directed advisor calls; the target is now a Task call.
- **Deterministic triggers and anti-triggers** unchanged — they're about *when* to escalate, not *how*.
- **ADR-0003** marked superseded; ADR-0007 carries the corrected history.

## Related

- [ADR-0007 — Advisor as userland subagent pattern](../decisions/0007-advisor-as-subagent-pattern.md) — current.
- [ADR-0003 — Advisor strategy](../decisions/0003-advisor-strategy.md) — superseded, kept for history.
- [ADR-0002 — default to Opus 4.7](../decisions/0002-default-to-opus-4-7.md)
- [`resolveRuntimeMode()` source](../../sidecar/packages/runtime/src/sdk-runner.ts)
- [`personality.ts` "Advisor consult — how to run one"](../../sidecar/packages/runtime/src/personality.ts)
- [`advisor-orb.tsx`](../../sidecar/src/components/brain/advisor-orb.tsx) — UI signal component.
