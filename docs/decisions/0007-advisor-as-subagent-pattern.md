# ADR-0007 — Advisor as a userland subagent pattern, not an SDK tool

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** @robertilisei, MARVIN
**Supersedes:** [ADR-0003 — advisor strategy (as SDK tool)](./0003-advisor-strategy.md)

## Context

[ADR-0003](./0003-advisor-strategy.md) adopted Anthropic's "advisor strategy" as MARVIN's cost-vs-quality escape hatch. The claim, based on a reading of the Agent SDK types, was:

> When `advisorModel` is set in the Agent SDK `Options`, the SDK registers an internal `advisor` tool that the executor can call at its own discretion.

**That claim is wrong.** A direct test on 2026-04-19 — executor (Sonnet 4.6) with `advisorModel: claude-opus-4-7` set, explicit `tool_use {name: "advisor", ...}` attempted — returned:

```
Error: No such tool available: advisor
```

Inspecting `@anthropic-ai/claude-agent-sdk@0.2.113/sdk.d.ts`:

```ts
/** Advisor model for the server-side advisor tool. */
advisorModel?: string;
```

The load-bearing phrase is **"server-side"**. `advisorModel` is a routing knob that tells Anthropic's infrastructure which model to use for internal escalation. The tool runs on the server; the executor never sees it as a callable tool and cannot invoke it via `tool_use`.

Consequence: every rule in `personality.ts` that said "call the `advisor` tool" was asking the executor to call something that doesn't exist from its perspective. The companion orb in the UI (`apps/web/src/components/brain/advisor-orb.tsx`) watched for `tool_use` events with `name === "advisor"` — events that would never fire. The "second opinion visible in the UI" feature was structurally broken.

The user experience was: user types "use the advisor" → MARVIN tries `tool_use: advisor` → SDK returns error → MARVIN reports "advisor slot is empty, proceeding solo" → every advisor interaction is a no-op.

## Decision

**Abandon the SDK-tool model for the advisor. Emulate the advisor pattern in userland via the Task subagent tool, with an Opus model hint.**

Specifically:

- Advisor consults are spawned via `Task` (the Claude Code subagent tool, available in every MARVIN turn via the `claude_code` system-prompt preset).
- The Task call carries:
  - `subagent_type: "general-purpose"` — the supported subagent type.
  - `model: "opus"` — required, so the consult actually runs on Opus (otherwise it runs on the parent turn's model, defeating the point).
  - `description: "advisor: <topic>"` — the leading `"advisor:"` prefix is the UI contract that lights up the companion orb.
  - `prompt` — a structured consultation prompt asking for risks / alternatives / pushback / verdict.
- `personality.ts` cross-phase rule 7 still mandates user-directed advisor calls, but the invocation target changes from the non-existent `advisor` tool to a Task subagent consult.
- Companion orb (`advisor-orb.tsx`) detection retargets from `tool_use name === "advisor"` to `tool_use name === "Task"` with a description matching `/^\s*advisor[\s:—-]/i`.
- The SDK's `advisorModel` option remains passed through from `sdk-runner.ts` — it's opaque, might still do something server-side, and is harmless. We don't rely on it for anything visible.

## Consequences

**Positive:**

- **Honest.** The executor really is calling a second model (Opus) via a subagent. It's not pretending to call an SDK tool that doesn't exist.
- **Visible.** The Task `tool_use` event surfaces in the chat stream the same way every other tool call does. The companion orb has a real signal to fire on.
- **Observable in JSONL.** Session transcripts show the consult as a Task call with a distinctive description, so `grep -a '"advisor' session.jsonl` finds it. No more "did the advisor fire?" uncertainty.
- **Portable.** The pattern works against any Claude Code session that has the Task tool, not just MARVIN. If the Agent SDK ever ships a real `advisor` tool, we can migrate; until then we own the mechanism.
- **Composable.** The consult prompt is a plain string we control — we can tune what the advisor focuses on (e.g., "stress-test the ADR template's Alternatives section") without waiting on SDK updates.

**Negative:**

- **Costlier than a real one-shot.** A Task subagent runs a full sub-conversation, not a one-shot completion. More tokens per consult than an SDK-native tool would use.
- **No reuse of `advisorModel`.** If Anthropic does ship a real advisor tool later, we'll have parallel mechanisms until we migrate.
- **Relies on the user's Claude Code runtime exposing `Task`.** Every current MARVIN deployment does, but the coupling is new.
- **Opus hint is advisory.** If the user's environment has no Opus access, the `model: "opus"` hint falls back to whatever's available; the subagent might run on Sonnet too, in which case the consult is Sonnet-consulting-Sonnet. Flag in the reply if suspected.

**Neutral:**

- The 7 deterministic advisor triggers and the anti-trigger list from ADR-0003 survive unchanged. They're about *when* to escalate, not *how*. Only the invocation mechanism moves.
- Cross-phase rule 7 (user-directed tool use is non-negotiable) survives unchanged. The mandate still applies; the target is a Task call now.

## Alternatives considered

### Keep ADR-0003 as-is, add "check if the tool exists" step

*Why plausible:* Maybe the SDK would register `advisor` under some flag we hadn't found.

*Why rejected:* We read the SDK source and tested directly. The `advisor` tool is not registered client-side regardless of flags. Further search would be hope, not engineering.

### Wait for Anthropic to ship a real callable advisor tool

*Why plausible:* The "server-side advisor tool" description in the Options type hints that future versions might expose a client-callable variant. Wait it out.

*Why rejected:* No ETA, no published roadmap for the advisor tool specifically, and in the meantime the feature is structurally broken. Better to ship something that works and migrate later.

### Use Anthropic's REST API directly from `sdk-runner.ts` to run a one-shot Opus completion on demand

*Why plausible:* Avoids the Task-subagent overhead.

*Why rejected:* Requires plumbing API credentials into `sdk-runner.ts` in a second code path (the SDK already handles auth; we'd duplicate it). Also bypasses the Claude Code tool-call UX — the consult wouldn't show up as a `tool_use` event, so the chat stream wouldn't see it, so the orb couldn't fire. We'd lose exactly the visibility this ADR is trying to deliver.

### Scrap the advisor feature entirely

*Why plausible:* Simplest response to "the SDK doesn't do what I thought."

*Why rejected:* The operating-model value (second-opinion on hard steps, visible in UI) is real and independent of *how* the consult happens. We built most of the scaffolding. Reframing is cheaper than deletion.

## Migration notes

- **Running sessions that used ADR-0003's language:** will continue to misbehave (call nonexistent tool, report "slot is empty") until the `personality.ts` update is deployed and the backend reloads. Restart MARVIN after the merge.
- **User-facing behavior:** "use the advisor" now triggers a Task subagent spawn. The companion orb fires on the Task call. The caption will read `advisor · opus` instead of `advisor · opus-4-7` (we hint the model family, not the specific version).
- **Existing sessions' transcripts:** won't have `tool_use` with `name: "advisor"` — they never did. Previously, we misread that as "advisor wasn't called"; it was actually "that tool never exists." The new pattern leaves unambiguous traces.

## Related

- [ADR-0003 — Advisor strategy](./0003-advisor-strategy.md) — superseded by this ADR. Keep for history.
- [docs/concepts/advisor-strategy.md](../concepts/advisor-strategy.md) — rewritten to match.
- [`personality.ts` "Advisor consult — how to run one"](../../packages/runtime/src/personality.ts) — the operational contract.
- [`apps/web/src/components/brain/advisor-orb.tsx`](../../apps/web/src/components/brain/advisor-orb.tsx) — UI signal.
