# ADR-0024 — Project-aware skill recommendations

**Status:** Accepted
**Date:** 2026-05-11
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN's current skill set is hardcoded into `personality.ts` Phase 5 ("Skills to reach for") and is identical for every project the user opens. A Spring-Modulith Romanian agri-SaaS, a Next.js frontend monorepo, an embedded firmware project, and an ML training pipeline all see the same trigger list — `test-driven-development`, `systematic-debugging`, `pr-review`, `security-audit`, `frontend-design`, `graphify`. The list isn't *wrong* for any of those, but it's missing what each project specifically needs and it never points the user at skills they don't yet have.

Skills are the right granularity for this — coarser (generic LLM advice) loses domain context; finer (one-off scaffolders) doesn't compose. A skill is a named, scoped, evaluable capability, and there's a working ecosystem (`anthropics/skills`, the user's `~/.claude/skills/`, the existing `skill-creator` skill that produces new ones).

What's missing is the *recommendation surface*: MARVIN inspecting the project it's parked in, recognising what kind of project it is, and suggesting which skills to install or build. Today the user has to know which skills exist and reach for them by name; MARVIN never volunteers.

This ADR defines that surface. It also makes a structural choice the rest of the design hangs on: project-specific skills live *in the project repository*, not in the user's global `~/.claude/skills/`. Skills travel with the code that needs them.

## Decision

A four-piece system added to `sidecar/`, gated by the same firm-surface discipline that already governs Workflow Audit:

### 1. Project fingerprint detector (`project-context/src/fingerprint.ts`)

Pure-FS, deterministic, no LLM call. On project open, scans top-level signals and emits a typed `ProjectFingerprint` with ~10–20 tags. Cached at `<workDir>/.marvin/fingerprint.json`; refreshed on graphify update or whenever the cache file is older than the newest project file.

Signal sources, all cheap:

- **Stack manifests** — `package.json`, `pom.xml`, `build.gradle{,.kts}`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Package.swift`, `*.csproj`, `Gemfile`, `composer.json`, `mix.exs`.
- **Framework tells** — substrings in those manifests (`next`, `vite`, `spring-boot-starter`, `django`, `fastapi`, `@nestjs/core`, `expo`, `swiftui`, `tauri`, `electron`).
- **Architecture signals** — `apps/*` (monorepo), `terraform/`, `infrastructure/`, `.github/workflows/`, `docker-compose.yml`, `Modulith` annotations in source.
- **Test stack** — `vitest`, `jest`, `playwright`, `cypress`, `pytest`, `junit5`, `testcontainers`.
- **Domain / compliance** — keywords scanned in `<workDir>/.marvin/memory.md` and ADR titles (`ANAF`, `APIA`, `eFactura`, `HIPAA`, `PCI`, `SOX`, `GDPR`).

Tags are namespaced (`language:typescript`, `framework:next@16`, `architecture:modular-monolith`, `domain:romanian-tax-compliance`, `test:playwright`). The namespace is what lets the catalog match without ambiguity.

### 2. Skill catalog index (`runtime/src/skill-catalog.ts`)

Walks two filesystems and produces one queryable index:

| Location | Scope | Lifecycle |
|---|---|---|
| `~/.claude/skills/*/SKILL.md` | User-global, every project | Stable, slow-moving (Anthropic + community skills) |
| `<workDir>/.marvin/skills/*/SKILL.md` | This project only | Versioned with the stack |

For each skill, reads the YAML frontmatter (`name`, `description`, optional `tags`). Caches the union at `~/.marvin/skill-catalog.json` (denormalised cache; the truth lives in the two filesystems). Exposes `findByTags(tags: string[])` for the suggestion engine.

The catalog is a discovery convenience, not a source of truth. If it goes stale or gets deleted, nothing breaks — it gets rebuilt by walking the two trees.

### 3. SDK skill-discovery extension (`runtime/src/sdk-runner.ts`)

The Claude Agent SDK currently discovers skills from `~/.claude/skills/` only. We add `<workDir>/.marvin/skills/` as a second discovery path with **higher precedence** — a project-local skill named `playwright-golden-path` shadows a user-global one of the same name. The project knows its own context better than a generic skill could.

Discovery order:

```
<workDir>/.marvin/skills/      ← highest precedence (project-local)
~/.claude/skills/              ← fallback (user-global)
```

This mirrors the precedence rule the SDK already applies to per-project MCP overrides.

### 4. Skill-audit firm surface (`personality.ts`)

A new MUST/MUST-NOT block in the personality, gated like Workflow Audit. Two modes:

**A. Soft suggestion (non-disruptive).** When (1) `<workDir>/.marvin/fingerprint.json` exists, (2) `<workDir>/.marvin/skills.md` is missing or empty, and (3) the user opens a fresh real-work session — emit a single chip-strip recommendation:

> *Based on your project's signals (Spring-Modulith, PostGIS, Playwright, Romanian compliance), here are the skills I'd reach for: **install** `webapp-testing`, `pdf`; **build** `flyway-multi-tenant-migrations`, `playwright-golden-path`. Want to walk through them?*

STOP after one suggestion per session. Disappear once `<workDir>/.marvin/skills.md` lands.

**B. On-demand build.** User says *"build me a skill for X"*. MARVIN invokes the already-installed `skill-creator` skill, but seeds the prompt with `ProjectFingerprint` so the generated skill is stack-aware. Output lands at `<workDir>/.marvin/skills/<name>/SKILL.md`. Next turn the SDK discovery extension picks it up.

### Two verbs the suggestion engine produces

The fingerprint tags decide which verb wins:

- **"Install"** → general-purpose skill (matches `language:*` or `framework:*` tags). Lives at `~/.claude/skills/`. Once-per-machine action.
- **"Build/edit"** → project-shaped skill (matches `architecture:*`, `domain:*`, or compliance tags). Lives at `<workDir>/.marvin/skills/`. Per-project action, committed to the repo.

## Why project-local skills (the structural choice)

Three properties most teams underestimate until they've burned themselves:

1. **They travel with the repo.** A new contributor clones the project, MARVIN inherits the project-tuned behaviour on first session — no "you have to install these 14 skills first" onboarding doc. Same property `<workDir>/.marvin/memory.md` and the `docs/adr/` directory have today.

2. **They're PR-reviewable.** A change to a project-local skill is a code review like any other change — it shows up in `git diff`, the team can argue about whether the new skill encodes the right rule, and a bad skill gets caught before it ships.

3. **They version with the stack.** When the project pivots away from a framework, the old skill gets retired in the same commit that retires the framework. There's no "this skill assumes a stack we no longer use" drift, because the skill was always tied to the codebase.

User-global skills coexist for the genuinely-portable case: a `pdf` skill that works the same in any project doesn't belong in fifty repos.

## Discipline / guardrails

The system degrades to noise without these. Five non-negotiable rules:

1. **Never auto-install or auto-build.** Recommendations are chat output the user acts on. Same trust contract as the existing ADR triggers.
2. **Track the audit decision.** `<workDir>/.marvin/skills.md` records what was recommended, what was adopted, what was rejected with a reason. MARVIN reads it next session: *"you parked `playwright-golden-path` last month with reason 'too small a test surface' — still true?"*
3. **Eval-bounded build.** Built skills go through `skill-creator`'s eval loop before they're treated as "recommended". A skill without an eval is "draft", surfaced differently.
4. **Staleness re-check.** When the fingerprint shifts (graphify update detects a new framework added or an old one removed), re-emit the audit with a different prompt: *"your stack changed — old recs may be stale."*
5. **No skill bloat metric.** The catalog tracks usage. If MARVIN has recommended skill X three times and the user has parked it three times, MARVIN stops recommending it. The user's "no" is durable.

## Consequences

**Positive**

- A non-trivial fraction of the friction MARVIN currently produces (suggesting `webapp-testing` to a project that doesn't have a UI; never suggesting `pdf` to a project that renders compliance reports as PDF) goes away.
- The ecosystem of project-local skills becomes a real artefact teams can share. AgriCore's `eFactura-ubl21` skill is copyable into the next Romanian-tax project without re-derivation.
- New contributors inherit the project's MARVIN customisation by cloning the repo. No onboarding doc to maintain.
- ADR-driven design means subsequent contributors can reason about *why* skills are wired this way, not just *that* they are.

**Negative**

- More moving parts. Two new modules (`fingerprint`, `skill-catalog`), one extension (`sdk-runner`), one new firm-surface block. Mitigated by following the existing Workflow Audit pattern, which has already proven the shape.
- Project-local skill quality is variable. A team can ship a bad skill into their repo. The PR-reviewable property mitigates this but doesn't eliminate it.
- The fingerprint detector is heuristic. False positives ("this project has Playwright as a dev dep but no actual E2E tests") will produce ~irrelevant recommendations. The user-decision-tracking system is the relief valve.

**Reversible**

- The fingerprint module is pure-FS — if its heuristics turn out wrong, retuning is local to one file.
- The catalog cache can be deleted with no data loss.
- The personality firm surface can be removed by deleting one block; the rest of the system is dormant infrastructure.

## Alternatives considered

### Push everything into user-global `~/.claude/skills/`

*What it is:* All skills, including project-specific ones, live in the user's home directory. MARVIN tags them by metadata.

*Why rejected:* Loses every property the project-local choice gives — skills don't travel with the repo, aren't PR-reviewable, drift independently of the codebase. Also, two contributors on the same project would diverge on which skills they have installed, defeating the "team norm" use case.

### Auto-build all suggested skills

*What it is:* MARVIN detects a gap, runs `skill-creator`, commits the new skill — no user gate.

*Why rejected:* Skill bloat. Quality ceiling. Trust violation. The same arguments that govern auto-PR-merging in MARVIN's existing rules apply here: humans approve, MARVIN proposes.

### Just hardcode a bigger skill list in `personality.ts`

*What it is:* Add 30 more skills to the trigger list.

*Why rejected:* Token weight on every turn. No project awareness. Doesn't scale to the long tail of project-shaped skills (`romanian-eFactura-ubl21`, `agricore-rbac-capability`) that don't generalise.

### Skill catalog as a remote service

*What it is:* MARVIN's sidecar fetches a centralised catalog over HTTP.

*Why deferred:* Adds network dependency, infra to maintain, trust questions. Today the catalog has two sources (user-global, project-local), both filesystem-local. A remote catalog might make sense once the community ecosystem grows; not yet.

## Verification

- `detectFingerprint(workDir)` against AgriCore returns tags including `language:java`, `framework:spring-boot@3.5`, `framework:react@19`, `architecture:modular-monolith`, `architecture:multi-tenant`, `test:playwright`, `domain:romanian-tax-compliance`. All deterministic, all cheap.
- Cached `fingerprint.json` is regenerated when the cache mtime is older than the newest project file (excluding ignored dirs).
- The skill catalog walks both filesystems and produces a single index. A `findByTags(["framework:spring-boot"])` query returns the matching subset; an empty filesystem produces an empty index without throwing.
- The `<workDir>/.marvin/skills/` path is added to the SDK's skill discovery; a project-local skill with the same name as a user-global one wins precedence.
- The Skill-audit block fires on a fresh AgriCore session and DOES NOT fire on subsequent turns once `<workDir>/.marvin/skills.md` lands.
- A built skill at `<workDir>/.marvin/skills/<name>/SKILL.md` is callable by MARVIN on the next turn without restart.
- Cold-start test: open MARVIN on AgriCore knowing nothing in this session — the first-turn injection includes a `## Project fingerprint` summary AND a single skill-audit recommendation. No second recommendation in the same session.

## Scope of Done

- [ ] `sidecar/packages/project-context/src/fingerprint.ts` exists with `detectFingerprint` + `formatFingerprintBlock` + `formatSkillAuditBlock`.
- [ ] `<workDir>/.marvin/fingerprint.json` cache is read/written; refresh is gated on cache vs newest-file mtime.
- [ ] `sidecar/packages/runtime/src/skill-catalog.ts` exists with the two-filesystem walk + frontmatter parse + `findByTags` query.
- [ ] `sdk-runner.ts` adds `<workDir>/.marvin/skills/` to the SDK's skill discovery path with higher precedence.
- [ ] `personality.ts` carries a "Skill audit — when to run one" block, gated by file existence, with an explicit STOP-after-one rule.
- [ ] `buildProjectContext` injects a `## Project fingerprint` block on first message AND a self-expiring `## Skill audit pending` block until `<workDir>/.marvin/skills.md` exists.
- [ ] Cold-start test on AgriCore produces a relevant recommendation.

## Related

- [ADR-0014 — Read-only scout subagents for parallel research](./0014-scout-subagents-read-only.md) — same shape (a self-contained capability bounded by deterministic triggers).
- [`personality.ts` "Workflow audit"](../../sidecar/packages/runtime/src/personality.ts) — the firm-surface pattern this ADR mirrors.
- [`workflow-health.ts`](../../sidecar/packages/project-context/src/workflow-health.ts) — the implementation pattern `fingerprint.ts` follows (pure FS, structured data + format-block pair, cheap on every turn).
- [Anthropic skills repo](https://github.com/anthropics/skills) — the source of user-global skills the catalog will index.
- [`skill-creator` skill](https://github.com/anthropics/skills) — the engine that produces new project-local skills.
