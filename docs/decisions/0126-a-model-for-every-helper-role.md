# ADR-0126 — Every helper role gets a user-selectable model, resolved against the active provider

- **Status:** Accepted — implemented 2026-10-12
- **Date:** 2026-10-12
- **Related:** [ADR-0029](./0029-keychain-token-read-for-model-discovery.md) (live discovery, no hardcoded version ids), [ADR-0058](./0058-parallel-graph-extraction-scoped-write-subagent.md) (graph-extractor on the Haiku tier), [ADR-0096](./0096-provider-aware-model-resolution.md) (never hand a bare Anthropic id to OpenRouter), [ADR-0108](./0108-per-session-posture.md) (executor/advisor are per-session posture), [ADR-0125](./0125-server-side-advisor-alongside-the-advisor-subagent.md) (server-side advisor), [ADR-0118](./0118-one-prompt-per-session-and-settings-isolation.md) (settingSources)

## Context

The user picks two models: the executor and the advisor. Every other model MARVIN runs was fixed in code, as a tier:

| Role | Where | Before |
|---|---|---|
| Scout subagent | `SCOUT_AGENT` | the session's model |
| Graph-extractor subagent | `sdk-runner.ts` | `latestForTier("haiku")` |
| Commit messages | `api/git/commit-message` | `fallbackNewestOfTier("haiku")` — the **static** list, never the live one |
| Practice-rule drafts | `practice-draft.ts` | `latestForTier("sonnet")` |
| Session auditor | `session-auditor.ts` | `latestForTier("sonnet")` |
| Skill discovery | `project-skill-discoverer.ts` | `latestForTier("sonnet")` |
| Claude Code's own small calls | the CLI's `haiku` alias | Claude Code's default — `claude-haiku-4-5` in every agri-saas transcript (10,993 occurrences) |
| Server-side advisor | — | not wired (ADR-0125) |

A tier is provider-aware (ADR-0096), but it is still a choice the user cannot make. On OpenRouter the catalogue holds models from every vendor, and the user wants to run a helper on one of them — a tier can only ever pick a Claude model.

## Decision

**One app-wide map from helper role to model, stored at `<MARVIN_DATA_DIR>/role-models.json`, edited from the Models dialog's "Helpers" section.** App-wide, not posture: these roles are not part of a conversation, and the off-turn ones (commit message, practice draft, auditor, discovery) run with no session at all.

`role-models.ts` owns the role list, the file, validation and resolution:

- **Default** per role is a tier (resolved with `latestForTier` against the active provider), `inherit` (the session's own model), or `off` (server advisor only). No model id appears in a default.
- **A pick** is any id the active provider's `/models` lists — Claude or not.
- **A stale pick** (saved under one provider, absent from the other's live catalogue) falls back to the default and logs `model.role.stale`. Switching provider never breaks a turn. On a non-live (fallback) catalogue the pick is kept: a fallback list cannot prove it stale.
- **Anthropic-only roles** (the server advisor) resolve to null on any other provider.
- **Validation** at the write boundary (`PUT /api/models/roles`, client-header guarded) and the read boundary: unknown roles, non-strings and strings that cannot be a model id are refused; a hand-edited file keeps its valid entries.

Per-turn wiring (`roleTurnOverrides`, pure and tested):

- background pick → `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL`; default sets neither, leaving Claude Code (and the user's own env) in charge;
- server advisor on → `settings.advisorModel` in the flag layer; off → `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`, which also closes the leak ADR-0125 found (a `/advisor` choice in a Claude Code terminal reaching MARVIN through `settingSources: ["user"]`).

`MARVIN_COMMIT_MESSAGE_MODEL` still wins over the role for commit messages — it is an existing escape hatch, not removed.

## Consequences

- The commit-message generator now uses the live catalogue (it never did), so it moves from Haiku 4.5 to Haiku 5.5 with no pick made.
- The fallback list gains `claude-haiku-5-5`, so offline resolution is current too.
- Setting the background model also changes what the `haiku` alias means inside a turn (e.g. an `Agent` call with `model: "haiku"`). That is intended — the pick is "what MARVIN means by the small model".
- ADR-0125 planned a per-tab toggle for the server advisor; it is app-wide here, like the other helpers. A per-tab override can be added later on top of this map if the measurement asks for it.
- Not covered: `refreshDocs` in `graphify-bridge` hardcodes `claude-haiku-4-5` but has no caller; left alone.

## Scope of Done

- [x] `GET` / `PUT /api/models/roles` reads and writes the map; unknown roles and malformed ids are refused (exercised live: 200 / 400 / 403 without the client header).
- [x] Scout, graph-extractor, commit messages, practice drafts, session auditor, skill discovery, background model and server advisor all resolve through `resolveRoleModel`.
- [x] Server advisor off → `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`; on → `settings.advisorModel` (`role-models.test.ts`).
- [x] The Models dialog shows a Helpers section, one picker per role, filled from the live list; "default" shows what it resolves to now.
- [x] Runtime vitest green (13 role-model tests; suite green apart from load-induced timeouts that pass in isolation), `swift build` green.
