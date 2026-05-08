# MARVIN documentation

The table of contents for the MARVIN codebase.

> "I have a million ideas. They all point to certain death."

If you just want to run MARVIN, start with [Quickstart](./getting-started/quickstart.md). If you want to understand *why* MARVIN is shaped the way it is, start with [Single-assistant philosophy](./concepts/single-assistant.md) and the [8-phase workflow](./concepts/eight-phase-workflow.md).

## Getting started
- [Overview](./getting-started/overview.md) — what MARVIN is, who it's for, what it won't do
- [Quickstart](./getting-started/quickstart.md) — install, credentials, first session
- [Architecture at a glance](./getting-started/architecture.md) — one-page map of processes, surfaces, and storage

## Core concepts
- [Single assistant, not an agent team](./concepts/single-assistant.md)
- [The 8-phase senior-engineer workflow](./concepts/eight-phase-workflow.md)
- [Per-project isolation contract](./concepts/isolation-contract.md)
- [Confirm-before-act gate — auto vs gated](./concepts/confirm-gate.md)
- [Advisor strategy — executor + advisor](./concepts/advisor-strategy.md)
- [Graphify — knowledge-graph first](./concepts/graphify-integration.md)
- [ADRs + per-project memory](./concepts/memory-and-adrs.md)

## Reference
- [HTTP API](./reference/api.md) — request/response shapes, SSE events, error codes
- [Environment variables](./reference/env-vars.md)
- [Storage layout](./reference/storage.md) — `~/.marvin/` + localStorage keys
- [MCP servers](./reference/mcp-servers.md) — `marvin-graph`
- [Keyboard shortcuts](./reference/shortcuts.md)

## Operations
- [Cost tracking](./operations/cost-tracking.md)
- [Observability](./operations/observability.md) — what's instrumented, what's planned
- [Sessions — persistence + resume](./operations/sessions.md)
- [Health checks](./operations/health.md)

## Security
- [Credentials](./security/credentials.md) — Keychain, API keys, host-credentials auto-detection
- [Tool permission policy](./security/tool-policy.md)
- [Data flow](./security/data-flow.md) — what leaves your machine, what doesn't

## Development
- [Local setup](./development/local-setup.md)
- [Workspace layout](./development/workspace.md)
- [Testing](./development/testing.md)
- [Contributing](./development/contributing.md)

## Architecture decisions
- [Index](./decisions/README.md)
- [ADR-0001 — single assistant, not an agent team](./decisions/0001-single-assistant.md)
- [ADR-0002 — default to Claude Opus 4.7](./decisions/0002-default-to-opus-4-7.md)
- [ADR-0003 — advisor strategy as experiment](./decisions/0003-advisor-strategy.md)
- [ADR-0004 — structural confirm gate via Agent SDK](./decisions/0004-structural-confirm-gate.md)
- [ADR-0005 — per-project isolation](./decisions/0005-per-project-isolation.md)
- [ADR-0006 — light-first theme cascade](./decisions/0006-light-first-theme-cascade.md)

## Business
- [Vision](./business/vision.md)
- [Cost model](./business/cost-model.md)
- [Licensing](./business/licensing.md)

## Roadmap + history
- [Roadmap](./roadmap.md) — current state (in flight, shipped, deferred, not planned)
- [Changelog](./history/CHANGELOG.md) — chronological record of what shipped, when, and why

---

## How these docs are organised

This structure mirrors [Claude Code's documentation](https://docs.claude.com/en/docs/claude-code/) intentionally. Someone who already knows Claude Code should find the right page in a couple of clicks.

**Source of truth, in order of precedence:**

1. **Code** — if the docs and the code disagree, trust the code. File an issue or open a PR to fix the doc.
2. **ADRs in [`/docs/decisions/`](./decisions/)** — material design decisions, written at the time the decision was made. Conflicts between a proposed change and an ADR are surfaced in the 8-phase workflow (see [Architecture](./concepts/eight-phase-workflow.md#phase-4-architecture)).
3. **[Roadmap](./roadmap.md) + [Changelog](./history/CHANGELOG.md)** — current state and chronological history of shipped work.
4. **The rest of the docs** — explanatory, contextual, should be readable without prior exposure to MARVIN.

**Never baked into MARVIN's own code:** any specific user project's service names, realm ids, workflow conventions, or infrastructure assumptions. MARVIN is supposed to work the same way for a rocket-guidance solver as for a Next.js app. Those live in each user project's own `<workDir>/docs/adr/` and `<workDir>/.marvin/memory.md` — see [Memory and ADRs](./concepts/memory-and-adrs.md).
