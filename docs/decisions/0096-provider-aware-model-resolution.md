# ADR-0096 — When OpenRouter is the provider, every model id must be OpenRouter's

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0029](./0029-keychain-token-read-for-model-discovery.md) (tier resolution, which this keeps and makes provider-aware), [ADR-0024](./0024-project-aware-skill-recommendations.md) (the skills path this unbreaks), [ADR-0033](./0033-advisor-registered-agent-per-role-effort.md)

## Context

MARVIN reaches OpenRouter by pointing the Claude CLI at a local proxy
(`/api/proxy/openrouter`) that forwards Anthropic-format requests upstream.
The design is sound — probed directly on 2026-08-30:

```
POST https://openrouter.ai/api/v1/messages              -> 401  (exists, needs auth)
POST https://openrouter.ai/api/v1/messages/count_tokens -> 404  (not implemented)
```

What is not sound is the **model id**. OpenRouter addresses models by
vendor-prefixed slug (`anthropic/claude-sonnet-4.5`); Anthropic's API uses a
bare id (`claude-sonnet-5`). MARVIN resolves models through one tier layer
(`latestForTier`, ADR-0029) that reads the live catalogue — and on OpenRouter
that catalogue *is* OpenRouter's, so the happy path already produces correct
slugs.

Every **unhappy** path does not. `FALLBACK_MODELS` (`models.ts:61`) holds bare
Anthropic ids only, and `listModels` returns it on any credential or network
hiccup (`:181`, `:218`, `:266`), as does `fallbackNewestOfTier` and
`defaultModel()`'s last-resort literal. So a transient failure silently swaps
a working OpenRouter session onto ids OpenRouter cannot resolve — for the
executor, the advisor, the graph-extractor, the session auditor, and skill
discovery.

Skill discovery is the worst-affected because it has a second bug on top.
`SkillsPane.runDiscovery` sends `model` only when the executor picker is not
on "default", and `project-skill-discoverer.ts:234` reads:

```ts
const discoveryModel = (isOpenRouter && model) ? model : (await latestForTier("sonnet")) ?? "claude-sonnet-4-6";
```

The condition reads as "prefer the caller's model on OpenRouter" but means "if
we are on OpenRouter **and** got a model" — so the OpenRouter-aware branch is
the first thing dropped when the caller omits one, landing on a hardcoded bare
Anthropic id. `session-auditor.ts:658` repeats the shape verbatim. This is why
"skills don't work on OpenRouter": not the skills machinery, which is CLI-side
and provider-independent, but the discovery call failing on an unusable id.

## Decision

**Provider awareness belongs in one layer, not at every call site.** The six
places that resolve a model all funnel through `latestForTier`,
`fallbackNewestOfTier` and `defaultModel()`; making *those* provider-aware
fixes them together, and keeps ADR-0029's "no hardcoded version id in business
logic" intact.

1. **`activeProvider()`** — derived from the auth config, the single source of
   truth for which catalogue is in play.
2. **Provider-scoped fallbacks.** `fallbackModelsForProvider()` returns the
   Anthropic list as today, or an OpenRouter list of vendor-prefixed slugs.
   The lists stay short and `live: false`, exactly as ADR-0029 intended — the
   point is not to be current, it is to be *addressable* by the provider that
   will receive it.
3. **A boundary guard.** `ensureProviderModelId()` rewrites a bare Anthropic id
   to its OpenRouter slug when the provider is OpenRouter, preferring a match
   from the live catalogue and falling back to the static map. It logs every
   rewrite. This is the backstop for any resolution path added later that
   forgets the rule — the failure mode this ADR exists to end is a *silent*
   provider mismatch.
4. **The inverted condition is deleted, not patched.** `latestForTier` is now
   provider-correct, so both sites become `model ?? (await latestForTier(…))`
   with no provider branch at all. Fewer places to know about OpenRouter, not
   more.

### Not decided here

`count_tokens` returning 404 on OpenRouter is real and out of scope — it
affects token accounting, not model addressing, and the fix belongs with
whatever consumes it.

Whether non-Claude models on OpenRouter actually *invoke* skills well is a
model-behaviour question this ADR cannot answer; it removes the mechanical
blocker so the question can be asked.

## Consequences

- An OpenRouter session degrades to a *usable* model on a catalogue failure
  instead of a broken one.
- The static OpenRouter slug list will age, like every fallback list. It is
  marked `live: false` and only consulted when discovery fails, which is the
  same bargain ADR-0029 already accepted for Anthropic.
- One more concept (`activeProvider`) in `models.ts`, in exchange for removing
  provider branches from two call sites and preventing them in future ones.

## Scope of Done

- [x] `activeProvider()` derives the provider from the auth config
- [x] Fallback lists are provider-scoped; no bare Anthropic id is returned on
      an OpenRouter session
- [x] `ensureProviderModelId()` rewrites and logs a mismatched id at the
      boundary
- [x] The `(isOpenRouter && model)` inversion is gone from both call sites
- [x] Tests pin each path, with a negative control per fix
- [ ] Not in scope: `count_tokens`, non-Claude skill-invocation behaviour,
      OpenRouter-specific pricing or context-window accounting
