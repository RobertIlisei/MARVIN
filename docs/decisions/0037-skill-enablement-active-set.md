# ADR-0037 — Per-project skill enablement (installed ≠ active)

**Status:** Accepted — 2026-06-11
**Touches:** new `skill-enablement.ts` (runtime), chat route (system-prompt
injection), `GET /api/skills` + new `POST /api/skills/enable`, Skills pane
(`SkillsPane.swift`). Builds on the fingerprint + suggestion-rules engine
(ADR-0024) and the Skills pane (ADR-0025).

## Context

A review of MARVIN's skills handling found the recommendation side is
already well-curated — 27 hand-curated suggestion rules (deduped, narrowed
by `requiresAlsoTag`), the LLM "discover" capped at 4 and opt-in, the
skill-audit nudge self-expiring. The actual problem is **enablement**:

> The SDK's `claude_code` preset loads **every** user-global skill from
> `~/.claude/skills/` into **every** session, for **every** project. There
> are 20 installed; a Swift/macOS project needs ~4. The other 16 (`xlsx`,
> `pptx`, `canvas-design`, `brand-guidelines`, `internal-comms`, …) are
> just *always there* — token cost, decision noise, and the "MARVIN
> discovers a lot we don't need" feeling. They aren't discovered; they're
> unconditionally loaded.

There was no "installed vs active" distinction. "Park" recorded an audit
note but disabled nothing.

**SDK spike (0.2.113).** There is no main-thread skills allowlist: `skills`
exists only on `AgentDefinition` (subagents); `settingSources`
(`'user'|'project'|'local'`) doesn't scope skills; `strictPluginOnlyCustomization`
is a managed/admin knob, not a per-session Option; skills don't surface as a
cleanly-gateable named tool. So the SDK will keep loading all 20 — we can't
stop that from the Options.

## Decision

Add the missing **enablement layer at MARVIN's own prompt layer** — the same
firm-surface pattern as Ask mode. We can't unload the skills, but we can
**tell the model which ones are active for this project and to ignore the
rest**, and make that set user-manageable.

- **`skill-enablement.ts`** — `CORE_SKILLS` (always-on engineering-process
  skills: `graphify`, `skill-creator`, `systematic-debugging`,
  `test-driven-development`, `pr-review`, `security-audit`) vs everything
  else ("domain": document / design / format / framework skills, gated on a
  fingerprint match). `selectActiveSkills(index, explicit)` (pure, tested) =
  explicit user choice, else core ∪ fingerprint-matched install-suggestions;
  project-local skills are always active; only installed skills returned.
- **`.marvin/skills.json`** — the per-project active set when the user
  overrides the default. Written by the Skills pane.
- **System-prompt injection** — `formatActiveSkillsBlock(workDir)` names the
  active skills each turn and instructs: *the other installed skills are not
  relevant to this project; do not invoke them — if you genuinely need one,
  tell the user to enable it.* This is the actual behavioural lever.
- **`GET /api/skills`** now returns `enablement: { active, explicit, core }`;
  **`POST /api/skills/enable`** writes `skills.json`. The Skills pane gets
  per-skill enable/disable toggles defaulting from the fingerprint.

### Why prompt-enforced, not gate-enforced

Ask mode hard-denies at the gate because edits surface as named tools
(`Edit`/`Write`). Skills don't surface as a reliably-named gate tool in
0.2.113, and a wrong guess would either block nothing or block everything.
Prompt-naming the active set is reliable and SDK-version-independent; a
gate-deny belt can be added later once the skill-invocation tool name is
confirmed from a live transcript.

## Consequences

- A Swift project's prompt now says "active: graphify, systematic-debugging,
  pr-review, …" instead of leaving the model to weigh 20. The default is
  automatic (no user action); the pane is the override.
- Token cost of the loaded skill frontmatter is unchanged (SDK limitation) —
  this addresses decision-noise and relevance, not raw load. Trimming the
  installed bundle (selective `install-skills.sh`) is a deferred follow-up
  that would also cut the load.
- `personality.ts`'s static skill-trigger enumeration is unchanged for now;
  a follow-up can scope it to the active set.

## Rejected alternatives

- **Filter skills into the session via the SDK** — no such Option for the
  main thread in 0.2.113 (spike above).
- **`strictPluginOnlyCustomization: ['skills']` + re-provide enabled skills
  as a plugin** — heavy (assemble a per-session plugin of skill dirs) and the
  knob is managed-settings-scoped, so unreliable as a per-session lever.
- **Gate-deny skill invocations** — skill tool name unconfirmed; risk of
  fail-closed breakage. Deferred to a belt once observed.

## Scope of Done

- [x] Core/domain catalog + pure `selectActiveSkills` (unit-tested).
- [x] `.marvin/skills.json` read/write; default from fingerprint.
- [x] Active-skills block injected into the turn system prompt.
- [x] `GET /api/skills` returns the active set; `POST /api/skills/enable`.
- [x] Skills pane enable/disable toggles (per user-global skill).
- [ ] (Deferred) selective install; personality skill-trigger scoping;
      gate-deny belt.
