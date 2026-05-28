# ADR-0029 — Read the Claude Code Keychain token for live model discovery + tier-based model defaults

**Status:** Accepted — 2026-05-28
**Related:** [ADR-0015](./0015-auto-mode-policy-floor-and-audit-log.md) (auth/policy surfaces), the model-discovery layer (`packages/runtime/src/models.ts`)

## Context

MARVIN already had live model discovery: `listModels()` queries Anthropic's
`/v1/models` REST endpoint and returns the catalogue, falling back to a small
hardcoded `FALLBACK_MODELS` list only when no credential is reachable. The
Settings → Model Picker calls `/api/models` on open, so newly-shipped models
were *supposed* to appear without a code change.

On 2026-05-28, Opus 4.8 shipped. It did **not** appear in MARVIN's picker —
the dialog showed the **"fallback list"** badge and only Opus 4.7 / Sonnet 4.6
/ Haiku 4.5.

### Root cause (verified)

The user authenticates in **host-credentials** mode (`~/.marvin/auth-config.json`
→ `mode: "cli"`; ran `claude auth login`). In that mode the OAuth token lives
in the macOS Keychain (item `Claude Code-credentials`), **not** in
`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` env vars and **not** in an
on-disk `~/.claude/.credentials.json`.

`models.ts → buildAuthHeaders()` only ever read env vars. With none set it
returned `null`, so `listModels()` short-circuited to `FALLBACK_MODELS` —
a hardcoded list that goes stale the instant a new model ships. The live
`/v1/models` call **never happened** in the default logged-in-Mac case.

A second, related defect: even with discovery fixed, `resolveRuntimeMode()`
(sdk-runner) and `defaultModel()` (claude-cli) hardcoded `claude-opus-4-7`
etc. as the *defaults*. So a new model would appear in the picker but MARVIN
would keep defaulting to the old one until the user manually switched.

## Decision

Two changes, both removing version-pinned model ids from the hot path.

### 1. Read the Keychain OAuth token in host-credentials mode

`auth.ts` gains `readHostOAuthToken()`: on darwin, shell out to
`security find-generic-password -s "Claude Code-credentials" -w`, parse the
JSON, return `claudeAiOauth.accessToken` (skipping a clearly-expired token).
Cached in-process for 5 min so we don't re-prompt the Keychain on every call.

`models.ts → buildAuthHeaders()` now resolves credentials in the same order
as `getAnthropicAuth()`: UI-configured API key → env OAuth → env API key →
**Keychain host token**. The Keychain branch is the gap this ADR closes.

This is the same credential the SDK already uses for every turn — we are not
introducing a new secret, only reading an existing one from a new call site.

### 2. Tier-based model defaults — no hardcoded version ids

`models.ts` gains `newestOfTier(models, tier)` (live beats fallback, then
newest `createdAt`), `latestForTier(tier)` (async, through a 10-min TTL cache
over `listModels`), and `fallbackNewestOfTier(tier)` (sync, static-list only).

- `resolveRuntimeMode(mode)` is now **async** and resolves the newest live
  Opus (solo) / newest Sonnet + Opus (advisor) via `latestForTier`.
- `defaultModel()` derives its last-resort from `fallbackNewestOfTier("opus")`
  rather than carrying its own literal.
- `project-skill-discoverer.ts` uses `latestForTier("sonnet")`.
- The picker presets' solo/advisor detectors match by **tier** (`/opus/i`,
  `/sonnet/i`) during the loading moment instead of comparing hardcoded ids.

The single remaining hardcoded list is `FALLBACK_MODELS` in `models.ts` — the
sanctioned "last known good" used only when discovery is fully unavailable
(offline, or the Keychain prompt declined). It carries one entry per tier.

## Why the Keychain read is acceptable

- **Not a new secret.** The token already exists and is already used by the
  SDK every turn. We read it; we don't mint, store, or transmit it anywhere
  beyond the `api.anthropic.com/v1/models` call it was issued for.
- **Sidecar runs as the user.** The node process owns the same Keychain ACL
  context as the `claude` CLI. macOS shows a one-time "allow access" prompt
  the first time node (vs the CLI) reads the item; "Always Allow" makes it
  silent thereafter.
- **Never load-bearing.** `readHostOAuthToken()` returns `null` on any
  failure and every caller falls back gracefully. A declined prompt degrades
  to the fallback list with an honest error string — it never blocks a turn
  (the SDK handles turn auth independently of this path).
- **Darwin-only, host-credentials-only.** Non-mac platforms and API-key/env
  modes never touch the Keychain.

## Consequences

**Positive**
- Opus 4.8 (and every future model) appears in the picker automatically in
  the default Mac login mode — no release, no code change.
- MARVIN auto-defaults to the newest Opus/Sonnet by tier; no version id to
  bump across four files when a model ships.
- One source of truth for offline fallbacks (`FALLBACK_MODELS`).

**Negative / mitigated**
- One-time macOS Keychain prompt the first time the sidecar reads the item.
  *Mitigated:* "Always Allow" makes it permanent; documented in the error
  string the picker surfaces on a declined/failed read.
- OAuth bearer tokens against `/v1/models` — assumes the Claude Code OAuth
  scope is accepted by the models endpoint. *Mitigated:* the pre-existing
  code already bet on this for env-OAuth tokens; on a 401 we fall back to the
  static list with a truthful error rather than failing silently.
- `resolveRuntimeMode` is now async — one `await` added at its sole runtime
  caller (`/api/chat`). *Mitigated:* typechecked; the TTL cache keeps it off
  the per-turn latency path after the first resolve.

**Reversibility**
Fully reversible. Deleting `readHostOAuthToken` + its call site reverts to the
env-only behaviour (host-credentials users go back to the fallback list).
Reverting `resolveRuntimeMode` to sync literals restores the pinned defaults.

## Scope of Done

- [x] `readHostOAuthToken()` reads + caches the Keychain token on darwin.
- [x] `buildAuthHeaders()` uses UI-key → env → Keychain resolution order.
- [x] `newestOfTier` / `latestForTier` / `fallbackNewestOfTier` added with the live-beats-fallback rule, pinned by tests.
- [x] `resolveRuntimeMode` async + tier-resolved; sole caller awaits it.
- [x] `defaultModel()` + skill-discoverer + picker presets de-hardcoded.
- [x] Runtime typecheck clean; tier tests + module-load tests pass.
- [ ] Live `/api/models` returns Opus 4.8 with `source: "anthropic-api"` after the user approves the one-time Keychain prompt (user-verified interactively).
