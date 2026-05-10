# ADR-0025 — Skills pane UI (v1)

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0024 — Project-aware skill recommendations](./0024-project-aware-skill-recommendations.md)

## Context

ADR-0024 wired project-aware skill recommendations into MARVIN. Detection works (the fingerprint emits 43 tags on the example project). Recommendations work (the Skill-audit firm surface in `personality.ts` produces a chip-strip in chat). Closing the loop works (the user writes `<workDir>/.marvin/skills.md` to make the audit-pending block disappear).

What's missing is *visibility*. Skills exist as files on disk in two trees:

- `~/.claude/skills/*/SKILL.md` — user-global
- `<workDir>/.marvin/skills/*/SKILL.md` — project-local

The only way to see what's installed today is to `ls` those directories or remember names. There's no surface in MARVIN that says *"here's the catalog you have, here's what's recommended for this project, here's how to act on it"*. Every comparable IDE has this — VS Code Extensions, JetBrains Plugins, Xcode Packages. MARVIN should too.

Beyond visibility, the audit-decision affordance is currently friction. Writing `<workDir>/.marvin/skills.md` by hand is a step most users won't take. A button in the UI ("park all" / "unpark") closes the loop with one click and removes the single biggest reason the audit-pending block keeps re-injecting.

## Decision

Add a **Skills tab** to the existing `LeftPane` — sibling to Files / Search / Source Control. v1 shows three sections, each with a small set of buttons. No new pane key, no new keyboard shortcut, no layout change to `ContentView`.

### Layout

```
┌─ Skills ──────────────────────────────────────────────┐
│                                                       │
│  ⚡ Suggested for this project                        │
│  ────────────────────────────                         │
│  Based on fingerprint tags                            │
│  • webapp-testing      [install]  [why?]              │
│  • flyway-multi-...    [build]    [why?]              │
│                                                       │
│  📦 User-global  (~/.claude/skills/)                  │
│  ────────────────────────────                         │
│  • test-driven-development        [view]              │
│  • systematic-debugging            [view]             │
│  …                                                    │
│                                                       │
│  📁 Project-local  (.marvin/skills/)                  │
│  ────────────────────────────                         │
│  • playwright-golden-path  shadows global  [view]     │
│  [+ Build new skill]                                  │
│                                                       │
│  Audit: not yet decided  [park all]                   │
└───────────────────────────────────────────────────────┘
```

### Verbs in v1

| Verb | What it does | Trust contract |
|---|---|---|
| **view** | Opens `SKILL.md` in MARVIN's existing file viewer (Monaco/STTextView), read-only. | Read-only — no security concerns. |
| **install** | *Only on user-global suggestions.* Drops a chat instruction (e.g. *"install `webapp-testing` from anthropics/skills"*). The user executes it. | We do NOT auto-`git clone` random repos; the user runs the install. |
| **build** | Triggers a chat turn invoking `skill-creator`, seeded with the matched fingerprint tag and target directory `<workDir>/.marvin/skills/<name>/`. | The eval loop owns the rest. The skill is "draft" until the user accepts it. |
| **why?** | Opens a popover citing which fingerprint tag drove the recommendation (e.g. *"matched `test:playwright`"*). | Read-only — informational. |
| **park all** | Writes `<workDir>/.marvin/skills.md` with a one-line decision (`audited 2026-05-11; parked all`). | Server endpoint, requires CSRF token (`X-Marvin-Client`) like every other write route. |
| **unpark** | Deletes `<workDir>/.marvin/skills.md`. Re-arms the audit-pending block. | Same trust contract. |

### Verbs explicitly NOT in v1

- **Browse + install from a remote registry** — no curated catalog exists; UI ahead of data.
- **Inline source editing** — Monaco/STTextView already exists. Click `view` and edit there.
- **"Code review" of skill sources** — supply-chain attack surface. A separate ADR when there's a registry to review against.
- **Auto-install** — same trust contract as ADR-0024 §discipline. Recommendations are surfaces, not actions.

### What surfaces what

The Swift app calls a single new sidecar route:

```
GET /api/skills?workDir=<absolute-path>
```

Response shape:

```json
{
  "fingerprint": { "tags": [...], "byNamespace": {...} },
  "suggestions": [
    {
      "name": "webapp-testing",
      "verb": "install",
      "matchedTags": ["test:playwright"],
      "rationale": "Project uses Playwright; webapp-testing scaffolds new E2E tests.",
      "alreadyInstalled": false,
      "scope": "user-global"
    },
    {
      "name": "flyway-multi-tenant-migrations",
      "verb": "build",
      "matchedTags": ["integration:flyway", "architecture:multi-tenant"],
      "rationale": "Multi-tenant Flyway migrations need dual-track schema discipline.",
      "alreadyInstalled": false,
      "scope": "project-local"
    }
  ],
  "userGlobal": [
    { "name": "test-driven-development", "description": "...", "path": "/Users/.../SKILL.md" }
  ],
  "projectLocal": [
    {
      "name": "playwright-golden-path",
      "description": "...",
      "path": "/Users/.../SKILL.md",
      "shadowsUserGlobal": false
    }
  ],
  "audit": {
    "decided": false,
    "skillsMdPath": "/Users/.../.marvin/skills.md"
  }
}
```

Two write endpoints close the audit loop:

```
POST   /api/skills/park              — writes <workDir>/.marvin/skills.md
DELETE /api/skills/park              — removes the file
```

Both are CSRF-guarded (require `X-Marvin-Client` header) like every other write route in the sidecar.

### Suggestion rules — where they live

A new file `sidecar/packages/runtime/src/suggestion-rules.ts` carries a static table mapping fingerprint tags → suggested skill name + verb + rationale. Format:

```ts
export const SUGGESTION_RULES: SuggestionRule[] = [
  {
    matchTag: "test:playwright",
    suggest: "webapp-testing",
    verb: "install",
    rationale: "Project uses Playwright; webapp-testing scaffolds new E2E tests.",
  },
  {
    matchTag: "integration:flyway",
    suggest: "flyway-multi-tenant-migrations",
    verb: "build",
    rationale: "Multi-tenant Flyway needs dual-track schema discipline.",
    requiresAlsoTag: "architecture:multi-tenant",
  },
  // ...
];
```

The table is intentionally hand-curated. v1 carries ~30 rules covering the namespaces the fingerprint emits today (`framework:*`, `test:*`, `architecture:*`, `domain:*`, `compliance:*`, `integration:*`). The skills-index module applies these rules deterministically against the fingerprint and returns the matched subset.

This is the "skill catalog index" deferred from ADR-0024 §What's NOT in this PR. The data shape is now driven by what the UI actually needs, which is exactly the reason it was deferred.

## Consequences

**Positive**

- **The catalog becomes tangible.** Users see what they have without `ls`.
- **The audit-decision becomes one click.** "Park all" closes the friction point that ADR-0024's design depends on.
- **Project-local vs user-global is visible.** The two-scope distinction (the load-bearing decision in ADR-0024) shows up as two sections, not as prose.
- **The "shadows global" badge is honest.** When a project skill overrides a user-global one of the same name, the UI says so.
- **Lower-friction skill-building.** The `[+ Build new skill]` button is a clearer affordance for users who don't have a terminal habit (especially brew-installed users).

**Negative**

- New surface to maintain. ~300 lines Swift + ~200 lines sidecar code.
- The suggestion-rules table is hand-curated and will drift over time. Mitigated by keeping it small (~30 rules) and adding rules only when a real project's fingerprint surfaces a new high-signal tag. We don't try to enumerate every possible skill.
- The `install` verb produces *chat instructions*, not actions — a UX shape that may surprise users who expect "install" to mean "click and it's there". Caveat copy in the popover (`"This will paste a command into chat — review before running."`).

**Reversible**

- The whole thing is a tab in `LeftPane`. Removing the tab + the API routes is a contained revert.
- The suggestion-rules table is a JSON-shaped TS file. Wrong rules can be edited in place; bad ones can be deleted in one PR.

## Alternatives considered

### Standalone pane (sibling to Files / Graph / Terminal / Browser Preview)

*What it is:* A new `skills` key in `PaneState`, new menu entry, new keyboard shortcut, new column in the HSplitView.

*Why deferred:* More layout complexity, more state to persist. The 4th-tab-in-LeftPane shape captures 95% of the value at 30% of the cost. Promote to standalone pane if usage shows users want skills + files visible simultaneously.

### Modal dialog

*What it is:* A "Skills…" menu item that opens a sheet.

*Why rejected:* Modals interrupt. Skill management is a browse-and-park-once interaction; sitting alongside the file tree is the right resting state, not a dialog.

### Settings panel section

*What it is:* A new section inside the existing Settings sheet.

*Why rejected:* Settings is for configuration. Skills are a *capability catalog* — closer to file tree than to preference toggles.

### Auto-install + auto-build

*What it is:* Buttons execute, no chat-instruction intermediary.

*Why rejected:* Same trust contract as ADR-0024. Auto-install of a remote skill is supply-chain risk; auto-build of a project-local skill skips the `skill-creator` eval loop. The chat-instruction shape keeps the user in the loop and reuses the existing review/execute pattern.

## Verification

- `GET /api/skills?workDir=…` against the example project returns at least 5 suggestions matching tags it produces (`webapp-testing` from `test:playwright`, `flyway-multi-tenant-migrations` from `integration:flyway` + `architecture:multi-tenant`, etc.). User-global section lists the existing ~20 skills from `~/.claude/skills/`. Project-local section is empty until the first SKILL.md lands.
- `POST /api/skills/park` against an arbitrary workDir creates `<workDir>/.marvin/skills.md` with the expected one-line content. The audit-pending block stops re-injecting next session.
- `DELETE /api/skills/park` removes the file. The audit-pending block re-injects on the next first-message turn.
- The Skills tab in LeftPane renders the three sections, displays the suggestion chips, and the buttons fire the right actions:
  - `view` opens the SKILL.md in the existing file viewer overlay.
  - `install` and `build` paste a chat instruction; both stop short of actually executing.
  - `park all` calls the POST endpoint and updates the audit-decided line in the same view.

## Scope of Done

- [ ] `sidecar/packages/runtime/src/suggestion-rules.ts` carries ~30 hand-curated rules covering `framework:*`, `test:*`, `architecture:*`, `domain:*`, `compliance:*`, `integration:*`.
- [ ] `sidecar/packages/runtime/src/skills-index.ts` reads user-global + project-local skills, applies suggestion rules to the fingerprint, returns the unified shape.
- [ ] `sidecar/src/app/api/skills/route.ts` exposes `GET`. `sidecar/src/app/api/skills/park/route.ts` exposes `POST` + `DELETE`. Both write routes are CSRF-guarded.
- [ ] `macos/MARVIN/SkillsPane.swift` renders three sections + the audit decision footer, hooked to the API.
- [ ] `LeftPane.swift` gains a 4th tab "Skills" — same Picker pattern as the existing tabs.
- [ ] Cold-start test on the example project: open MARVIN, switch LeftPane to Skills tab, see at least 5 suggestions. Click "park all", verify `<workDir>/.marvin/skills.md` lands and the audit footer flips to "Audit: parked 2026-05-11".

## Related

- [ADR-0024 — Project-aware skill recommendations](./0024-project-aware-skill-recommendations.md) — the underlying recommendation engine this UI surfaces.
- [`fingerprint.ts`](../../sidecar/packages/project-context/src/fingerprint.ts) — the tag source the suggestion rules match against.
- [`project-skills-plugin.ts`](../../sidecar/packages/runtime/src/project-skills-plugin.ts) — the SDK skill-discovery extension already in place from ADR-0024.
- [`LeftPane.swift`](../../macos/MARVIN/LeftPane.swift) — host for the new Skills tab.
