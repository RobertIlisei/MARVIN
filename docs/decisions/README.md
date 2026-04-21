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
| [0003](./0003-advisor-strategy.md) | Advisor strategy as an experiment | **Superseded by 0007** | 2026-04-18 |
| [0004](./0004-structural-confirm-gate.md) | Structural confirm gate via Agent SDK | Accepted | 2026-04-17 |
| [0005](./0005-per-project-isolation.md) | Per-project isolation | Accepted | 2026-04-17 |
| [0006](./0006-light-first-theme-cascade.md) | Light-first theme cascade | Accepted | 2026-04-19 |
| [0007](./0007-advisor-as-subagent-pattern.md) | Advisor as userland subagent pattern | Accepted | 2026-04-19 |
| [0008](./0008-user-initiated-write-channel.md) | User-initiated write channel for the file tree | Accepted | 2026-04-21 |
| [0009](./0009-file-uploads-from-os.md) | File uploads from the OS to the project tree | Accepted | 2026-04-21 |
| [0010](./0010-desktop-wrapper-tauri.md) | Desktop wrapper via Tauri | Accepted | 2026-04-21 |
| [0011](./0011-sidecar-node-bundling.md) | Standalone `.app` via bundled Node sidecar | **Deprecated** | 2026-04-21 |
| [0012](./0012-source-control-mutation-channel.md) | Source-control mutation channel | Accepted | 2026-04-21 |
| [0013](./0013-git-remote-ops-and-credentials.md) | Git remote ops and credentials | Accepted | 2026-04-21 |

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

**At turn time, MARVIN uses a deterministic list — not judgement.** Nine MUST-write categories + anti-triggers + the re-derivation test, enumerated in [`packages/runtime/src/personality.ts`](../../packages/runtime/src/personality.ts) Phase 4 "Deterministic ADR triggers". The complete list is mirrored in [ADRs + memory](../concepts/memory-and-adrs.md#when-to-write-one).

In short, the categories that require an ADR:

- Foundational framework / runtime / platform change
- Public API shape change
- Persistent-state schema change
- Security-boundary change (auth, creds, tool policy, sandbox, shell)
- Default model or runtime-mode change
- New MCP server
- Cross-cutting architectural constraint
- Superseding / deprecating an existing ADR
- User explicitly names it ADR-worthy

Not ADR-worthy:

- Typos, lint-rule tweaks, formatting
- Internal refactors that don't change contracts
- Trivially-obvious choices with no credible alternative
- Regenerated artefacts (graphify outputs, lockfile bumps)
- Doc-only updates that don't encode new constraints
