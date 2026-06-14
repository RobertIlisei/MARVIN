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

Two surfaces, same answer from different angles.

**Soft criteria (this doc, for humans):** write an ADR when the decision is material, structural analysis can't recover it from code alone, and it bounds future work. Skip for typos, internal refactors that don't change contracts, or trivially-obvious choices.

**Hard rules (what MARVIN actually uses at turn time):** the authoritative enumeration lives in [`sidecar/packages/runtime/src/personality.ts`](../../sidecar/packages/runtime/src/personality.ts) under Phase 4 "Deterministic ADR triggers". Nine MUST-write categories:

| # | Trigger |
|---|---|
| a | Foundational framework / runtime / platform change |
| b | Public API shape change (route, envelope, field, status, SSE event naming) |
| c | Persistent-state schema change (JSONL shape, `projects.json`, `cost-tracker`, user config, DB migrations) |
| d | Security-boundary change (auth, creds, tool policy, confirm gate, file sandbox, shell whitelist, network egress) |
| e | Default model or runtime-mode change |
| f | New MCP server registered in `sdk-runner.ts` |
| g | Cross-cutting architectural constraint ("all writes go through the event bus", "no cross-project memory") |
| h | Superseding or deprecating an existing ADR |
| i | User explicitly names it ADR-worthy ("worth an ADR", "decision doc this") |

Plus anti-triggers (typos, internal refactors with no contract change, obvious choices, regenerated artefacts, doc-only updates) so the ADR directory stays trustworthy.

**Fallback when the lists don't cover the case:** the **re-derivation test** — *"8 weeks from now, would a future MARVIN reading only the code + commit messages understand why this choice was made, and would they reach the same conclusion when they had to touch this again?"* If either answer is no → write the ADR.

### MARVIN's behavior on ADRs

- **Phase 2 Discovery** — reads every `<workDir>/docs/adr/*.md`. Surfaces any that might conflict with the current ask.
- **Phase 4 Architecture** — when a material decision is made, drafts an ADR and presents it. The user can edit or accept as-is.
- **Phase 8 Ship** — writes the ADR to `<workDir>/docs/adr/NNNN-*.md` as part of the commit.
- **Mode A / B / C in the workflow audit** — if ADRs are missing for past decisions, MARVIN proposes them (Mode A) and, on user approval, writes them (Mode B). See [`workflow-health.ts`](../../sidecar/packages/project-context/src/workflow-health.ts).

### Reading your own ADRs

```
ls <workDir>/docs/adr/
```

MARVIN's own ADRs are at [`docs/decisions/`](../decisions/). MARVIN's decisions-for-MARVIN start with [ADR-0001](../decisions/0001-single-assistant.md).

## Per-project memory

### What memory is (ADR-0042)

A **curated durable-facts layer**: `<workDir>/.marvin/memory.md` is a
one-line-per-fact **index**, and each fact is a small file under
`<workDir>/.marvin/memory/<slug>.md` (frontmatter `name` / `description` /
`type`). Plain Markdown. It is written **only through the `remember` tool**, not
by editing the file — `remember` writes the fact file, rebuilds the index,
**supersedes by name** (not blind append), caps length, and **rejects
activity/status content**. `recall` searches it.

Memory captures **gotchas, invariants, hard constraints, "we decided Y because
Z was broken" items, and external facts of record** that the next session can't
re-derive from ADRs, git, or the changelog. It does NOT hold what you
implemented (→ git/changelog), decisions (→ ADR), or verification/commit status
(ephemeral). An earlier append-everything model let a real project's memory.md
balloon to 419 KB / ~99 % redundant — the cause of the [context-budget
fix](../decisions/0041-project-graph-lifecycle-and-context-budget.md).

### Format

```markdown
# Project Memory Index

- [Tenant id is realm not org](memory/tenant-id-is-realm-not-org.md) — carried over from 2023 migration, too expensive to rename
- [Webhook retries handled by the queue](memory/webhook-retries-handled-by-the-queue.md) — don't add retry logic inside the handler
```

…with `memory/tenant-id-is-realm-not-org.md`:

```markdown
---
name: Tenant id is realm not org
description: carried over from 2023 migration, too expensive to rename
type: project
---

Tenant id is `realm`, not `org` — a 2023-migration carryover that's too
expensive to rename now. Anything keying on tenant must use `realm`.
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

- **Phase 2 Discovery / Intake** — the memory **index** is injected in the
  project-context block; MARVIN pulls a specific fact's detail on demand with
  `recall` (or by reading the `.marvin/memory/` file).
- **Phase 8 Ship** — if the turn surfaced a *durable fact*, MARVIN records it
  with `remember`. It does NOT log what it implemented or its status.
- **Supersede, don't pile up.** Re-using a fact's `name` updates it in place;
  the index is rebuilt from the fact files, so it never drifts. Run
  `/memory-compact` to distill a memory.md that has bloated into a log.

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

See [`workflow-health.ts`](../../sidecar/packages/project-context/src/workflow-health.ts) for the exact implementation.

## Related

- [Isolation contract](./isolation-contract.md) — why these live in the user's repo.
- [The 8-phase workflow](./eight-phase-workflow.md) — where ADRs and memory are written / read.
- [Graphify integration](./graphify-integration.md) — the third layer of the ramification stack.
- [`workflow-health.ts`](../../sidecar/packages/project-context/src/workflow-health.ts) — Mode A / B / C audit detector.
