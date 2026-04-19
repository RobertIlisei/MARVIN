# ADR-0002 — Default to Claude Opus 4.7

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN's runtime is the Claude Agent SDK. Every chat turn runs against a Claude model. At the time of this decision (April 2026), the available Claude models were:

| Model | Tier | Speed | Cost | Quality on seq-code |
|---|---|---|---|---|
| Opus 4.7 | Flagship | Slowest | Highest | Best |
| Opus 4.6 | Previous flagship | Moderate | High | Very good |
| Sonnet 4.6 | Mid-tier | Fast | Low | Good on routine, gap widens on hard tasks |
| Haiku 4.5 | Entry | Very fast | Very low | Below acceptable for sequential code work |

MARVIN is built for the **pair-programming loop**, which is sequential code work — every step depends on earlier decisions (see [ADR-0001](./0001-single-assistant.md)). Published benchmarks place Opus furthest ahead of Sonnet/Haiku precisely on this regime.

The user-facing partner is the single point of contact for the developer. Cost-saving on the partner has a direct quality cost that's hard to recover.

## Decision

**MARVIN defaults to Claude Opus 4.7** for the executor.

The default is implemented in [`packages/runtime/src/claude-cli.ts`](../../../packages/runtime/src/claude-cli.ts) as:

```ts
export function defaultModel(): string {
  return (
    process.env.MARVIN_MODEL?.trim() ||
    "claude-opus-4-7"
  );
}
```

Users can override at three levels:

1. **Per-turn** — `/api/chat` body's `model` field wins over everything else.
2. **Session default** — the header `<ModelPicker>` persists the user's executor + advisor picks to `localStorage`.
3. **Process-wide** — `MARVIN_MODEL` env var.

If all three are unset, turns run on Opus 4.7.

## Consequences

**Positive:**

- Out-of-the-box, MARVIN operates at the highest quality tier available. New users don't have to know which model to pick to get a good experience.
- The sequential-code regime is where Opus's lead is largest. Defaulting to it maximizes the delta over the alternatives.
- Aligns with the user-facing rationale: "the partner stays top-tier."

**Negative:**

- Costliest default. Users running long sessions on Opus alone may be surprised by the per-day spend. The [cost pill in the header](../operations/cost-tracking.md) surfaces this; users who care about cost can opt into advisor mode ([ADR-0003](./0003-advisor-strategy.md)).
- Slowest default. Opus has higher TTFT than Sonnet. For very short interactions ("rename this variable"), the model is overkill.
- Raises the bar for any cheaper default to justify itself. Switching the default to Sonnet would require evidence that the quality loss is smaller than the cost saving in practice — which is exactly what the advisor strategy experiment was designed to gather.

## Alternatives considered

### Default to Sonnet 4.6

*What it is:* Use the mid-tier model by default; reserve Opus for when the user explicitly asks.

*Why plausible:* Roughly 1/5 the cost. Faster TTFT. Sufficient for routine work.

*Why rejected:* Sequential code work in a novel codebase involves enough "hard" steps (ambiguous architecture, subtle refactors) that the quality gap shows up repeatedly in a typical session. Users experiencing MARVIN for the first time through Sonnet wouldn't know what they're missing. Moving to Opus later requires them to already know about the option.

### Auto-switch model based on perceived complexity

*What it is:* Heuristic or LLM-based dispatcher decides per-turn whether to call Sonnet or Opus.

*Why plausible:* Pay for Opus only when needed.

*Why rejected:*

- Complexity prediction is a research problem, not a product feature. Mis-classifications in either direction are costly (Opus when Sonnet would do: money; Sonnet when Opus is needed: quality).
- The advisor strategy ([ADR-0003](./0003-advisor-strategy.md)) achieves the same goal *with lower risk*: the executor itself decides when to escalate, using its own reasoning about task difficulty rather than a pre-flight heuristic.
- A deterministic top-level dispatcher would violate [ADR-0001](./0001-single-assistant.md) — it'd be another agent making decisions, with another handoff.

### Default to whatever was most-recently picked

*What it is:* Boot with the user's last executor/advisor selection.

*Why plausible:* User preference.

*Why rejected:* This is what happens anyway — the `<ModelPicker>` persists to `localStorage`. The question here is what the *first-ever* default is. That has to be opinionated. Opus wins.

## Revisit when

This decision should be revisited if any of these become true:

- Sonnet's gap to Opus narrows to the point where advisor-mode consistently outperforms solo-Opus on real user sessions (measure via cost + user-reported quality).
- A new model tier lands (Opus 4.8, Haiku 4.6, etc.) that shifts the curve materially.
- Anthropic publishes cost/quality benchmarks that directly contradict this choice.

## Related

- [ADR-0003 — advisor strategy](./0003-advisor-strategy.md) — the cost-optimization experiment layered on top.
- [Advisor strategy — narrative](../concepts/advisor-strategy.md)
- [`defaultModel()` source](../../../packages/runtime/src/claude-cli.ts)
- [Anthropic model lineup](https://docs.claude.com/en/docs/about-claude/models/overview) — the cross-reference the advisor strategy cites.
