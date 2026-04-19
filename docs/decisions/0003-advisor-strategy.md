# ADR-0003 — Advisor strategy as an experiment

**Status:** Accepted (experimental — Phase 5 stretch, shipped 2026-04-18)
**Date:** 2026-04-17 (scoped); 2026-04-18 (shipped)
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN defaults to Opus 4.7 ([ADR-0002](./0002-default-to-opus-4-7.md)) because sequential code work is where Opus's lead over cheaper models is largest.

That default has an obvious cost: routine steps inside a session (file reads, greps, trivial edits, mechanical refactors) are paying flagship prices for work a mid-tier model handles fine. Typical sessions spend the bulk of their tokens on these routine steps.

In March 2026, Anthropic launched the Agent SDK's `advisorModel` option (`advisor_20260301`). It registers an internal `advisor` tool that the executor can call on demand — a one-shot escalation to a smarter model for hard steps only. Anthropic's launch data claims **~30-40% savings on routine code work with minimal quality loss.**

The option fits MARVIN's shape well:

- It preserves single-assistant semantics ([ADR-0001](./0001-single-assistant.md)) — one continuous context, one user↔AI loop. The advisor is a *tool*, not a separate agent.
- The executor decides when to escalate, which sidesteps the "auto-switch by heuristic" failure mode discussed in [ADR-0002](./0002-default-to-opus-4-7.md#auto-switch-model-based-on-perceived-complexity).
- It's opt-in — the default user experience is unchanged.

MARVIN's PLAN.md had already penciled this in as a Phase 5 stretch item on the 2026-04-17 evening decision lock: "Advisor Strategy experiment (Sonnet exec + Opus advisor) for cost reduction once v1 stabilises."

## Decision

**Ship advisor strategy as an opt-in alternative**, accessible via the header `<ModelPicker>`. Default stays Opus-4.7 solo.

Implementation:

- [`resolveRuntimeMode(mode)`](../../../packages/runtime/src/sdk-runner.ts) maps `"opus"` → `{ model: "claude-opus-4-7" }` and `"advisor"` → `{ model: "claude-sonnet-4-6", advisorModel: "claude-opus-4-6" }`. This was the initial binary toggle.
- On 2026-04-18 the binary toggle was replaced with a two-slot `<ModelPicker>` (executor + advisor) persisting to `localStorage`. Explicit picker values win over `runtimeMode`.
- The resolution order in [`/api/chat`](../../../apps/web/src/app/api/chat/route.ts) is: explicit `body.model` → `resolveRuntimeMode(runtimeMode)` → `defaultModel()`.

## Consequences

**Positive:**

- Users on long sessions can opt into 30-40% savings without giving up the flagship for hard steps.
- Preserves single-assistant semantics — the advisor is a tool the executor invokes, not a peer agent.
- Escalation is model-driven (the executor decides), which fails gracefully: worst case is the executor doesn't escalate and Sonnet ships a mediocre answer, which is no worse than Sonnet alone (the previous next-best alternative).
- Zero cost to users who don't opt in — default stays Opus-4.7 per [ADR-0002](./0002-default-to-opus-4-7.md).

**Negative:**

- Adds a decision surface. Users now have to understand executor vs advisor to pick wisely. Mitigated by: default behavior is unchanged, picker has helper text ("executor runs the turn loop", "advisor escalated for hard steps").
- "Model-driven escalation" is a soft guarantee. Anthropic's launch data is real but based on their benchmarks, not MARVIN's. Users will see session-level variance.
- Creates an information gap: which model *actually* ran a given turn? The `turn.started` SSE event emits the `model` + `advisorModel` in use, and the JSONL transcript records tool calls to `advisor`, so this is inspectable — but a casual user reading the header might misread the picker state as "Sonnet is doing everything." (This gap was the impetus for the brain side-panel's executor/advisor display, and for this doc.)
- Advisor-mode sessions have different cost profiles than Opus-only, breaking intuitive "this conversation cost $X" comparisons. Mitigated by: `/api/cost` aggregates over real token usage, not model price.

## Alternatives considered

### Keep Opus-only; skip advisor entirely

*Why plausible:* Simplest. Fewest moving parts. Most predictable cost behavior.

*Why rejected:* Leaves 30-40% cost savings on the floor for users running long sessions. Anthropic explicitly built the advisor tool for this use case; ignoring it would be losing the benefit for no architectural reason.

### Ship advisor as the default; demote Opus-only to opt-in

*Why plausible:* Cost optimization by default; users who want max quality opt in.

*Why rejected:*

- First-time users wouldn't experience MARVIN at its best. They'd get a Sonnet-driven session and not know what the ceiling is.
- Violates the "user-facing partner stays top-tier" principle from [ADR-0002](./0002-default-to-opus-4-7.md).
- Re-litigates that ADR. If cost becomes the binding constraint later, flip the default explicitly, don't do it as a side-effect of this ADR.

### Custom heuristic dispatcher on MARVIN's side

*Why plausible:* Total control over when escalation happens.

*Why rejected:* See [ADR-0002 → auto-switch alternative](./0002-default-to-opus-4-7.md#auto-switch-model-based-on-perceived-complexity). Writing a good dispatcher is a research problem. Let the SDK's `advisor` tool handle it — Anthropic has better visibility into the model's decision-making than MARVIN does.

### Offer advisor but hide it behind a feature flag

*Why plausible:* Conservative rollout.

*Why rejected:* Phase 5 is explicitly the experiments lane. Shipping it directly in the picker is consistent with MARVIN's "no feature flags in code that's already written" guidance.

## Verification

The launch implementation was verified via `curl` on 2026-04-18:

- `runtimeMode: "advisor"` — the Agent SDK's `init` event reports `model: claude-sonnet-4-6`. Tool-use events include calls to the `advisor` tool.
- `runtimeMode: "opus"` — `init` reports `model: claude-opus-4-7`. No `advisor` tool calls.
- Header picker override — setting executor to `claude-sonnet-4-6` + advisor to `claude-opus-4-7` (current Opus, not 4.6) works; body `model` fields win over `runtimeMode`.

See PLAN.md's "2026-04-18 (Phase 5 #1 + #5)" changelog entry for the shipping note.

## Revisit when

- Real user data shows advisor mode either exceeds or falls short of the ~30-40% savings claim at scale.
- A new model tier materially changes the executor/advisor cost-quality curve.
- User feedback suggests the decision surface is too complex (e.g., "I can't tell which model is running").

## Related

- [ADR-0002 — default to Opus 4.7](./0002-default-to-opus-4-7.md)
- [Advisor strategy — narrative](../concepts/advisor-strategy.md)
- [`resolveRuntimeMode()` source](../../../packages/runtime/src/sdk-runner.ts)
- [Anthropic Agent SDK advisor tool docs](https://docs.claude.com/en/api/agent-sdk/overview)
