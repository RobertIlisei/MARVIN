# ADRs + per-project memory

Two persistent layers that live in the user's project and survive across MARVIN sessions, git clones, and time. Together with the knowledge graph, they form the **three-layer ramification stack** — how MARVIN stops month-8 changes from silently breaking month-2 decisions.

## The three layers

| Layer | Location | Size | Written at | Read at |
|---|---|---|---|---|
| 1. Knowledge graph | `<workDir>/graphify-out/graph.json` | MB-scale | code changes (auto via watchdog or hook) | phase 2 Discovery, phase 3 Impact analysis |
| 2. ADRs | `<workDir>/docs/adr/NNNN-*.md` | KB per record | phase 4 Architecture | phase 2 Discovery |
| 3. Memory | `<workDir>/.marvin/memory.md` | small; one line per entry | phase 8 Ship | phase 2 Discovery |

The graph is covered in [Graphify integration](./graphify-integration.md). This page covers the two text-based layers.

## Architecture Decision Records

### What an ADR is

A short Markdown file capturing *why* a design decision was made. Usually 1-3 pages. Written once, at decision time. Read by every future MARVIN session before that area gets touched.

ADRs persist decisions that **structural analysis cannot see**. The graph can tell you that `lib/auth.ts` is imported by 12 files. It *cannot* tell you "we chose tenant isolation via RLS, not middleware, because a 2025-Q4 incident with realm leakage across request handlers forced the decision."

### Template (enforced by personality.ts)

```markdown
# ADR-0042 — Short imperative decision statement

**Status:** Accepted (or: Proposed, Superseded by ADR-0051, Deprecated)
**Date:** 2026-04-19
**Deciders:** @robertilisei, MARVIN (single-assistant session)

## Context

Why is this decision happening now? What forces are at play? What's
the constraint that made the status quo untenable?

## Decision

The decision itself, stated as an imperative. "We will use X because Y."

## Consequences

What becomes true once this is adopted. Positive and negative.
Include the things that get harder, not just the things that get
easier.

## Alternatives considered

At least 2, usually 3. For each: what it is, why it's plausible,
why it was rejected.

## Related

Links to: the ADR this supersedes, the PR that implements it,
the memory.md entries it turned into gotchas.
```

### Numbering

Monotonic. ADR-0001 is the first decision ever made for this project; ADR-0042 is the 42nd. Never overwrite a number. A superseded ADR keeps its number and gets a `Status: Superseded by ADR-NNNN` header.

### When to write one

A decision deserves an ADR when:

- **It's material.** You'd regret having to re-derive it from scratch in 6 months.
- **Structural analysis can't recover it.** Code comments can't fully explain "why not the other option."
- **It bounds future work.** "All writes go through the event bus" is an ADR; "use `Array.from()` not `[...]` for this one call site" is not.

When to *not* write one:

- Typo fixes, lint rule changes, trivial renames.
- Internal refactors that don't change contracts.
- Decisions that will be obvious to any future reader from the code alone.

### MARVIN's behavior on ADRs

- **Phase 2 Discovery** — reads every `<workDir>/docs/adr/*.md`. Surfaces any that might conflict with the current ask.
- **Phase 4 Architecture** — when a material decision is made, drafts an ADR and presents it. The user can edit or accept as-is.
- **Phase 8 Ship** — writes the ADR to `<workDir>/docs/adr/NNNN-*.md` as part of the commit.
- **Mode A / B / C in the workflow audit** — if ADRs are missing for past decisions, MARVIN proposes them (Mode A) and, on user approval, writes them (Mode B). See [`workflow-health.ts`](../../packages/project-context/src/workflow-health.ts).

### Reading your own ADRs

```
ls <workDir>/docs/adr/
```

MARVIN's own ADRs are at [`docs/decisions/`](../decisions/). MARVIN's decisions-for-MARVIN start with [ADR-0001](../decisions/0001-single-assistant.md).

## Per-project memory

### What memory is

A single file: `<workDir>/.marvin/memory.md`. Append-only. One line per entry. Plain Markdown.

Memory captures **gotchas, invariants, "we decided Y because Z was broken" items** that don't warrant a full ADR but would be painful to re-derive.

### Format

```markdown
# <Project Name> — MARVIN memory

Running log, appended at Phase 8 (Ship). Newest at bottom.

## 2026-04-17
- Tenant id is `realm` not `org` — carried over from 2023 migration, too expensive to rename.
- Webhook retries are handled by the queue, not the handler. Don't add retry logic inside the handler.

## 2026-04-18
- Feature flag `USE_NEW_AUTH` is a rollout flag, not a permanent toggle. Target removal: 2026-06-01.
- `lib/pdf/fonts/` is checked in despite being binary; CI assumes this.
```

### What belongs in memory vs an ADR

Heuristic: if a 6-months-later reader would ask "why" and the answer is long, write an ADR. If the answer is "because X was broken," write a memory entry.

| Example | Memory or ADR? |
|---|---|
| "Tenant id is `realm` not `org`" | Memory — short, specific gotcha |
| "We use RLS for tenant isolation instead of middleware" | ADR — material design, multiple alternatives |
| "Rate limits are 100 req/s for /search, 1000 req/s elsewhere" | Memory — constant, compact |
| "We built our own queue instead of using Redis" | ADR — has alternatives, consequences |

### MARVIN's behavior on memory

- **Phase 2 Discovery** — reads `<workDir>/.marvin/memory.md`. Includes it verbatim in the project context block.
- **Phase 8 Ship** — appends one line summarizing anything surprising from this session.
- **Never rewrites history.** New entries append; old entries stay as-is.

## Why these live in the user's repo, not MARVIN's data dir

The ADRs and memory travel with the code. They survive `git clone`. They're visible in code review. A new team member checking out the repo can understand the project's history without access to MARVIN.

If these lived in `~/.marvin/`, they'd be machine-local — lost on reinstall, invisible in review, useless to anyone but the original author.

See [Isolation contract](./isolation-contract.md) for the full rationale.

## Bootstrapping a project with no ADRs or memory

A fresh `workDir` has none of these. MARVIN's **workflow audit** (injected on every turn until gaps close) flags this:

```
! No ADRs found at <workDir>/docs/adr/
  Mode A: I can propose the first 3-5 ADRs based on what I see
  in the repo. Say "audit" or "propose ADRs" to start.

! No memory at <workDir>/.marvin/memory.md
  I'll seed this with the first real decision we make together.
```

See [`workflow-health.ts`](../../packages/project-context/src/workflow-health.ts) for the exact implementation.

## Related

- [Isolation contract](./isolation-contract.md) — why these live in the user's repo.
- [The 8-phase workflow](./eight-phase-workflow.md) — where ADRs and memory are written / read.
- [Graphify integration](./graphify-integration.md) — the third layer of the ramification stack.
- [`workflow-health.ts`](../../packages/project-context/src/workflow-health.ts) — Mode A / B / C audit detector.
