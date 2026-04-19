# ADR-0005 — Per-project isolation

**Status:** Accepted
**Date:** 2026-04-17 (afternoon — isolation audit)
**Deciders:** @robertilisei, MARVIN

## Context

A single developer using MARVIN will typically work on several projects over time — a SaaS frontend, a CLI tool, a research repo, whatever. The naive approach to context would be: MARVIN accumulates knowledge across sessions, learning "things I've seen before." This is tempting because it promises a progressively-smarter assistant.

It's also how solo-plus-AI projects fail in practice. Failure modes observed in pre-MARVIN prototypes and published widely:

- **Cross-project contamination.** A decision made while working on Project A ("we use RLS for tenant isolation") bleeds into Project B, where the equivalent decision went the other way. The user can't always catch this — especially not in week 8 when project-A context is hazy.
- **Hardcoded project knowledge.** Service names, realm ids, stack choices, workflow conventions leaking into MARVIN's own source code or runtime cache. Once this happens, MARVIN becomes unusable outside the original project.
- **Opaque state.** If session transcripts, ADRs, and memory live in MARVIN's data dir, they're invisible to code review, survive only on the original machine, and are lost on reinstall.

The industry's broader move toward "per-project rules files" (Cursor `.cursorrules`, Claude Code `CLAUDE.md`, others) signals that the field has landed on the same answer: per-project state belongs in the project's own repo.

## Decision

**MARVIN holds zero cross-session knowledge about past projects.** Every new project starts from zero.

Concretely:

1. **User picks a `workDir` at session start.** Everything outside that `workDir` is opaque to MARVIN.
2. **Per-project state lives inside the `workDir`.** Knowledge graph (`graphify-out/`), ADRs (`docs/adr/`), memory (`.marvin/memory.md`). All travel with the code, survive `git clone`, are visible in code review.
3. **MARVIN's user-scoped data dir** (`~/.marvin/` or `MARVIN_DATA_DIR`) holds **only cross-project plumbing** — session transcripts, cost ledger, registered-projects list, user config. Never project content.
4. **MARVIN's own source code** must carry zero specific-project assumptions. No hardcoded service names, realm ids, stack choices, ports, or workflow conventions.

This is codified as [CLAUDE.md Golden Rule 4 + 5 + 6](../../../CLAUDE.md):

> 4. The user's project is a separate workspace. MARVIN's own code lives in `~/marvin/`. The user's active project lives in its own directory. MARVIN holds no persistent knowledge of past projects between sessions.
> 5. No truncation of project context.
> 6. No hardcoded project knowledge.

## Consequences

**Positive:**

- Zero cross-contamination. Each session is a fresh read of the current `workDir`'s real state.
- ADRs and memory are **portable**. Clone the repo on another machine, another MARVIN install picks them up with no migration.
- Code review sees the reasoning. A teammate reading `docs/adr/` and `.marvin/memory.md` in the PR diff can follow the decision trail without ever having used MARVIN.
- MARVIN is domain-agnostic. It works the same way on a rocket-guidance solver as on a Next.js app.
- Fresh-project behavior is predictable. New projects get the same audit prompts, no mystery "MARVIN seems to remember something from elsewhere."

**Negative:**

- No cross-project learning. Every new project starts at square one on MARVIN's understanding. Experienced users may briefly wish for "MARVIN, remember how we did rate-limiting in the last project" — that's deliberately unavailable.
- First-session overhead. MARVIN has to build the graph (`/graphify .`), read the repo, discover structure. Subsequent sessions reuse the on-disk graph + ADRs, but session #1 is costlier than it would be if MARVIN "remembered."
- Users who don't commit `docs/adr/` or `.marvin/memory.md` lose the benefit. Mitigation: [CLAUDE.md rule 4](../../../CLAUDE.md) documents this; workflow audit nudges users to write ADRs and seed memory.
- Migrating MARVIN's own `~/.marvin/` to a new machine doesn't carry anything useful about user projects. That's by design — the projects carry themselves.

## Alternatives considered

### Cross-project memory cache in `~/.marvin/`

*What it is:* MARVIN maintains a vector store or flat cache of "things I've learned" across every project, keyed by concept.

*Why plausible:* Enables the "learning assistant" experience.

*Why rejected:* Contamination. Cross-project leakage of assumptions is the failure mode this ADR exists to prevent. The cache would be a bug surface with high blast radius — a misrouted "we use Prisma" from Project A surfacing in Project B's SQL-first codebase would be a quiet disaster.

### Per-user config that overrides per-project defaults

*What it is:* A `~/.marvin/user-style.md` file that MARVIN injects into every project's context — personal code-style preferences, common tool picks.

*Why plausible:* Some preferences *are* user-global (code formatter choice, preferred language in side projects).

*Why rejected for v1:* Adds ambiguity about authority. If `~/.marvin/user-style.md` says "prefer Python" but a project's ADR picks Go, which wins? The answer should always be the project, so the cross-project layer is net-negative. If specific user preferences turn out to be valuable later, they can be added as *hints MARVIN reads and always defers to the project on*, not as overrides. Not v1.

### Let the user opt into cross-project memory per session

*What it is:* A "carry over from project X" toggle at session start.

*Why plausible:* User has agency.

*Why rejected:* Introduces a new failure mode: the user forgets they turned it on, gets cross-contaminated context, doesn't realize why MARVIN is confused. Fresh-project-from-zero is a simpler invariant with no escape hatches.

### Store ADRs and memory in `~/.marvin/<projectId>/` instead of in the user's repo

*What it is:* MARVIN's own data dir carries per-project ADRs, keyed by project id.

*Why plausible:* Avoids polluting the user's repo with MARVIN-specific files.

*Why rejected:*

- Not portable. `git clone` on another machine loses the ADRs.
- Not reviewable. PRs don't show them.
- Keeping ADRs in `docs/adr/` is an industry standard (Sun's original proposal, Michael Nygard's 2011 adaptation). MARVIN should inherit the convention, not reinvent it.

Memory (`.marvin/memory.md`) is more debatable — some users might prefer it local-only. The current recommendation is to check it in, but users who want it gitignored can: MARVIN will still read and append to it, it just won't travel.

## Verification

After this ADR was accepted:

- Stripped every runtime tie to any specific prior project. `packages/project-context/src/infra-probes.ts` rewritten — no hardcoded service list, no realm URL, only project-agnostic probe primitives.
- `buildProjectContext()` no longer runs probes by default (caller passes them explicitly).
- Placeholder project paths in `page.tsx`, `CLAUDE.md`, `PLAN.md` replaced with generic `/path/to/your/project`.
- `packages/project-context/src/workflow-health.ts` rewritten to probe only the four domain-agnostic gaps (ADRs, memory, graph presence, graph freshness). No framework sniffers.

See PLAN.md's "2026-04-17 (afternoon) — Isolation audit" and "2026-04-18 (workflow-audit — stack-agnostic rewrite)" changelog entries.

## Related

- [Isolation contract — narrative](../concepts/isolation-contract.md)
- [ADRs + memory](../concepts/memory-and-adrs.md)
- [Storage layout](../reference/storage.md)
- [CLAUDE.md Golden Rules 4, 5, 6](../../../CLAUDE.md)
- [`packages/project-context/src/workflow-health.ts`](../../../packages/project-context/src/workflow-health.ts) — stack-agnostic audit
