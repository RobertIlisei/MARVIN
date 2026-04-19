# Advisor strategy — executor + advisor

The default MARVIN runtime is **Opus 4.7 alone**. The advisor strategy is an opt-in alternative that saves ~30–40% on routine code work by running a cheaper executor (Sonnet 4.6) with a smarter advisor (Opus) on call for hard steps.

This doc explains what the two modes do, when to use which, and how the handoff actually works.

## The two modes

| Mode | Executor | Advisor | Cost | Trade-off |
|---|---|---|---|---|
| **Opus** (default) | Claude Opus 4.7 | — | highest | Best quality on every step. No handoffs. |
| **Advisor** | Claude Sonnet 4.6 | Claude Opus 4.6 | ~30–40% less | Sonnet does routine work, escalates on demand. |

The mode is picked via the `models` dropdown in the header (two slots: executor + advisor) and persisted to `localStorage`. At the API layer, the client sends explicit `model` + `advisorModel` in the chat body. See [Models picker](../reference/api.md#post-apichat).

## What "advisor" means mechanically

When `advisorModel` is set in the Agent SDK `Options`, the SDK registers an **internal `advisor` tool**. The executor sees it as one tool among its usual set (`Read`, `Grep`, `Edit`, etc.) and can call it at its own discretion.

Calling the advisor tool:

1. Executor emits `tool_use` with name `advisor` and an input (usually a focused question + relevant context snippet).
2. SDK dispatches a **one-shot** call to the advisor model with that input.
3. Advisor's response returns as `tool_result` into the executor's ongoing turn.
4. Executor continues with the new information in context.

The trigger is **model-driven, not rule-driven**. There's no code in MARVIN that says "after N tool calls, consult the advisor." The executor decides based on its reasoning about task difficulty. Typical triggers:

- Ambiguous architecture decision with multiple viable paths.
- Complex refactor where the blast radius is non-obvious.
- Edge-case planning (concurrency, auth, migrations under load).
- Anything where the executor hits the end of what it can reason about alone.

The executor's system prompt implicitly instructs it: "you have an advisor tool, call it on hard steps."

## Why this is faster *and* cheaper

**Cheaper**: Sonnet 4.6 is roughly 1/5 the cost of Opus 4.7 per token. Most tool calls in a typical turn are routine (file reads, grep, mechanical edits). Running those on Sonnet is nearly free.

**Often faster**: Sonnet has lower TTFT than Opus. The bulk of a turn — especially the tool-use loop — latency-benefits.

**Not lossy (per Anthropic's launch data)**: the "minimal quality loss" claim lives in [`packages/runtime/src/sdk-runner.ts:42-44`](../../packages/runtime/src/sdk-runner.ts):

> Per Anthropic's launch data (advisor_20260301), this saves ~30-40% on routine code work with minimal quality loss.

The logic: most code-work steps are routine, Sonnet handles them fine. The rare hard step gets escalated — Opus is still the one making the consequential decision, just without being paid to grep 40 files.

## Rule enforcement

**At turn time, MARVIN uses a deterministic list — not judgement — to decide when to call the advisor.** The authoritative rules live in [`packages/runtime/src/personality.ts`](../../packages/runtime/src/personality.ts) under "Advisor tool — when to call it" (right after the Skills block). Two enforcement surfaces:

1. **User-directed is non-negotiable** (cross-phase hard rule 7). "Use the advisor" / "consult the advisor" / "get the advisor to help you with this" → `advisor` tool MUST fire at least once in Phase 4 or 5. Cite the reply. Silent skipping is the "MARVIN ignored me" failure mode the rule is named for.

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

The **companion orb** (`apps/web/src/components/brain/advisor-orb.tsx`) surfaces advisor activity in the UI — when it flies in next to the main brain, the `advisor` tool is firing on the current turn.

## When to use which

**Default (Opus alone)** when:
- You're doing architecture-critical work. Auth, billing, migrations, protocol design.
- Early in a project, when every decision compounds.
- You want the simplest, most predictable cost behavior.
- Cost is not the binding constraint.

**Advisor (Sonnet executor, Opus advisor)** when:
- Routine feature work in a codebase MARVIN already knows.
- Mechanical refactors, test additions, documentation passes.
- Long sessions where the 30–40% savings compound.
- You're dog-fooding MARVIN on MARVIN itself (where you're less worried about the executor making a plausible-looking mistake).

## How to switch

Header → `models` pill → two dropdowns.

**Executor** runs the turn loop. **Advisor** is escalated to for hard steps.

Model IDs (as of 2026-04-19):

- `claude-opus-4-7` — flagship, latest
- `claude-opus-4-6` — one version back
- `claude-sonnet-4-6` — balanced, fast, cheap
- `claude-haiku-4-5` — very fast, very cheap, reserved for subagent bulk work

Set **Advisor = off** (`—`) to disable the advisor tool entirely; executor runs solo.

## Resolution order

`/api/chat` picks the actual model via this fallback chain ([route.ts:89-92](../../apps/web/src/app/api/chat/route.ts)):

```
const model = body.model?.trim() || resolved.model || defaultModel();
const advisorModel = body.advisorModel?.trim() || resolved.advisorModel;
```

1. **Explicit picker values** (`body.model` / `body.advisorModel`) win. This is what the header sends.
2. **`resolveRuntimeMode(runtimeMode)`** — the older binary toggle. `"opus"` → Opus solo; `"advisor"` → Sonnet + Opus-4.6. Only used if explicit picker values are empty.
3. **`defaultModel()`** — env var `MARVIN_MODEL`, else `claude-opus-4-7`.

The `/api/health` endpoint's `defaultModel` field reports step 3's fallback — it is NOT the live model for any active turn. See [Health checks](../operations/health.md).

## History

MARVIN shipped originally with a binary `"opus" | "advisor"` toggle. That was replaced with the two-slot picker on 2026-04-18 when users asked to mix & match (e.g., Sonnet executor + latest Opus-4.7 advisor). The picker values "win over `runtimeMode`" — see [PLAN.md changelog for 2026-04-18 refresh-safe turns + dynamic models](../../PLAN.md).

## Related

- [ADR-0003 — advisor strategy as Phase 5 experiment](../decisions/0003-advisor-strategy.md) — the decision record.
- [ADR-0002 — default to Claude Opus 4.7](../decisions/0002-default-to-opus-4-7.md) — why Opus is the default.
- [`resolveRuntimeMode()` in `sdk-runner.ts`](../../packages/runtime/src/sdk-runner.ts) — the implementation.
- [Models endpoint](../reference/api.md#get-apimodels) — how the dropdown gets its options.
