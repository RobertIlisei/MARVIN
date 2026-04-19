# Vision

What MARVIN is trying to be.

## The problem

A developer working with an AI coding assistant in 2026 has two choices:

1. **Claude Code / Cursor** — a chat interface next to the editor. The assistant sees one file at a time. You prompt, it answers, you copy-paste or accept a diff.
2. **Multi-agent frameworks** — supervisor-agents dispatching role-agents through a structured task layer. Promising architecture; degrades up to 70% on sequential code work per 2026 research.

Option 1 is fine for small changes but breaks down as projects grow — the assistant doesn't see the blast radius of a change, doesn't know about decisions made six months ago, doesn't have enough context to catch ramifications.

Option 2 addresses those problems in theory but solves them in a way that reliably makes things worse.

## The bet

**A single capable assistant, operating with the same context-management discipline a senior engineer would use, beats both alternatives.**

Concretely that means:

- **One context, one conversation, one Claude session.** No handoffs, no kanban-as-source-of-truth, no "agent teams." See [ADR-0001](../decisions/0001-single-assistant.md).
- **Persistent per-project state** in the project's own repo — ADRs (why), memory (gotchas), knowledge graph (structure). Travels with the code, survives session boundaries, visible in review. See [ADR-0005](../decisions/0005-per-project-isolation.md).
- **Structural rigor** — an 8-phase workflow that forces blast-radius analysis and ADR discipline on material changes, skipped for trivial ones. See [The 8-phase workflow](../concepts/eight-phase-workflow.md).
- **User as continuous overwatch** — not a rubber-stamp at the end but an attentive partner throughout. The confirm gate, the visible brain state, the inline diff all exist to support that.

If the bet is right, a sufficiently-disciplined single assistant closes more of the gap to human senior-engineer quality than a multi-agent architecture does, while being easier to reason about when things go wrong.

## Non-goals

MARVIN is not trying to be:

- **A replacement for Claude Code.** Claude Code is the CLI, MARVIN is a browser shell over the Agent SDK. Different form factor; both useful.
- **A hosted product.** No MARVIN server, no analytics, no cloud dashboard. Everything runs on your machine.
- **Multi-tenant.** One user, one machine. If a team wants MARVIN, each member runs their own.
- **A general-purpose agent framework.** MARVIN is specifically for pair-programming. Other workloads (bulk research, data processing) are not in scope.
- **Framework-prescriptive.** Per [ADR-0005](../decisions/0005-per-project-isolation.md), MARVIN works the same way on a rocket-guidance solver as on a Next.js app. Specific-framework assumptions stay in the user's project.

## What success looks like

In 6 months:

- A developer using MARVIN on a real project month-over-month finds the ramification-tracking layers (graph + ADRs + memory) catching bugs that would otherwise ship.
- The cost per feature shipped is meaningfully lower than running Claude solo, because the advisor strategy and graphify integration reduce wasted exploration.
- The 8-phase workflow feels like a forcing function, not ceremony. Material changes get ADRs; trivial changes don't.
- MARVIN has a small number of concrete failure modes that users have explicit mental models of — "MARVIN forgot the context" rarely happens because the three ramification layers catch it.

In 12 months:

- There's evidence one way or the other on the single-vs-multi bet. If MARVIN is visibly losing to multi-agent tools on real tasks, that's data. If it's winning, the operating model generalizes to other domains.
- A small number of external contributors have written ADRs and the PR process has been exercised.
- Honeycomb (or equivalent observability) MCP ships, giving MARVIN real production trace access for debugging.

## What MARVIN deliberately leaves on the table

- **The hosted-product business model.** MARVIN doesn't aspire to be a SaaS.
- **Maximum day-one adoption.** The install requires `pnpm`, Node 22, and some comfort with a local dev loop. This is a power-user tool.
- **Broad framework compatibility.** MARVIN works with any codebase, but the onboarding assumes the user has opinions about their stack. Zero-config beginners are better served by Claude Code.
- **Multi-agent features "just in case."** Every time the design gets tempted toward multi-agent, [ADR-0001](../decisions/0001-single-assistant.md) is the answer.

## Related

- [Overview](../getting-started/overview.md) — what MARVIN is.
- [Cost model](./cost-model.md) — what it costs to run.
- [Licensing](./licensing.md) — the legal shape (TBD).
- [ADR-0001 — single assistant](../decisions/0001-single-assistant.md)
- [ADR-0005 — per-project isolation](../decisions/0005-per-project-isolation.md)
