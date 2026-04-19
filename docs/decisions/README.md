# Architecture decisions

This directory is MARVIN's Architecture Decision Record (ADR) log. Each file captures *why* a material decision was made.

## Why ADRs

Code tells you *what*. Comments tell you *what*. Commit messages tell you *what changed*. None of them reliably tell you *why we picked this over the alternative*, especially six months later when the trade-off matters again.

ADRs live in the repo, travel with the code, are visible in review, and survive reinstalls. The format is deliberately small — 1-3 pages — so writing one doesn't feel heavy.

See [ADRs + memory](../concepts/memory-and-adrs.md) for how MARVIN uses ADRs in its 8-phase workflow.

## Current ADRs

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-single-assistant.md) | Single assistant, not an agent team | Accepted | 2026-04-17 |
| [0002](./0002-default-to-opus-4-7.md) | Default to Claude Opus 4.7 | Accepted | 2026-04-17 |
| [0003](./0003-advisor-strategy.md) | Advisor strategy as an experiment | Accepted | 2026-04-18 |
| [0004](./0004-structural-confirm-gate.md) | Structural confirm gate via Agent SDK | Accepted | 2026-04-17 |
| [0005](./0005-per-project-isolation.md) | Per-project isolation | Accepted | 2026-04-17 |
| [0006](./0006-light-first-theme-cascade.md) | Light-first theme cascade | Accepted | 2026-04-19 |

## Template

See the template in [ADRs + memory](../concepts/memory-and-adrs.md#template).

Summary:

```markdown
# ADR-NNNN — Imperative decision statement

**Status:** Proposed | Accepted | Superseded by ADR-MMMM | Deprecated
**Date:** YYYY-MM-DD
**Deciders:** @handle, MARVIN

## Context
## Decision
## Consequences
## Alternatives considered
## Related
```

## Numbering

Monotonic. ADR-0001 is first. Never overwrite a number. A superseded ADR keeps its number and gets `Status: Superseded by ADR-MMMM`.

## When to write one

A decision deserves an ADR when it:

- Bounds future work (e.g., "all writes go through the event bus")
- Would be expensive to re-derive from code alone
- Has credible alternatives that were rejected
- Creates contracts other code depends on

When to NOT write one:

- Typos, lint-rule tweaks, formatting
- Internal refactors that don't change contracts
- Trivially-obvious choices
