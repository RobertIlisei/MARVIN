# ADR-0001 — Single assistant, not an agent team

**Status:** Accepted
**Date:** 2026-04-17
**Deciders:** @robertilisei, MARVIN (single-assistant session)

## Context

In 2025 and early 2026, "AI coding agent" tools broadly split into two camps:

1. **Single-assistant.** One Claude/GPT session in a user↔AI loop. Examples: Claude Code, Cursor chat, Aider.
2. **Multi-agent orchestrations.** A supervisor-agent dispatches role-agents (PO, tech-lead, engineers, QA, devops) that hand off through a "tickets" or "kanban" data layer. Examples: several open-source frameworks, some startup products.

MARVIN is being rebuilt from scratch at `~/marvin/` after a prior multi-agent prototype ("the previous project") hit recurring quality problems. Before committing to a shape, we did a research pass on 2026 multi-agent coding literature (Google, UIUC, Microsoft, Anthropic Research).

The published findings are direct and uncomfortable for the multi-agent camp:

- On sequential coding tasks, multi-agent autonomy degrades quality **up to ~70%** vs a single capable assistant.
- Flat-topology "bag of agents" setups **amplify error rates 17×** through context-loss failures at every handoff.
- The dominant failure mode: an agent downstream of a handoff lacks the context of the upstream decision, makes a plausible-looking-but-wrong assumption, and subsequent agents compound the error.

The failure mode is structural: sequential code work is exactly where handoff tax hurts most. Every step depends on decisions made earlier; every handoff loses fidelity.

## Decision

**MARVIN is a single-assistant pair-programming tool.** One Claude session, one continuous context, one user↔AI loop.

The workflow stages (intake, discovery, impact analysis, architecture, plan, implement, verify, ship) are **phases one assistant moves through in one conversation**, not peers that hand off. See [The 8-phase workflow](../concepts/eight-phase-workflow.md).

## Consequences

**Positive:**

- No handoff tax. Decisions made in Intake propagate verbatim to Ship.
- The user is a continuous overwatch. Course corrections happen in real time, not after a kanban-mediated delay.
- One context window, so:
  - Cache hits accumulate across phases of a single feature.
  - Tool-result memory persists — grep results from Discovery don't get lost by Architecture.
- Failure modes become comprehensible. When MARVIN is wrong, there's one narrative to debug, not six interacting agents.

**Negative:**

- Cannot trivially parallelize within a single feature. If two independent sub-tasks could be done concurrently by two agents, MARVIN must serialize them.
- Scope ceiling per turn. Very large features that exceed the context window need to be split into multiple turns — MARVIN cannot offload the complexity to a separate agent.
- Single failure point. If the main Claude call hangs or errors mid-stream, the turn ends. There's no "backup agent" to take over.
- Culturally unfashionable in 2025/2026. Users coming from multi-agent tools may initially expect MARVIN to "spin up a QA agent" and be surprised by the refusal.

**Narrow escape hatch — subagent delegation:**

MARVIN spawns subagents via Claude Code's native `Task` tool, but only for:

- **Breadth-first exploration** — search 40 files for a pattern in parallel.
- **Bulk independent work** — summarize 20 chat transcripts.
- **Context relief** — offload a large read whose result matters but whose intermediate reasoning doesn't.

Subagents do NOT make design decisions, write code the main thread hasn't reviewed, or dispatch through kanban. See `personality.ts` `CORE_BEHAVIOR` → "Subagent delegation" for the exact rules.

## Alternatives considered

### Multi-agent, hierarchical (CEO → PO → tech-lead → engineers)

*What it is:* A supervisor dispatches role-specialized agents that hand off through a structured data layer (tickets, specs, PRs).

*Why plausible:* Mirrors how human software teams organize. Intuitively, "giving each agent a specialty" should improve output quality.

*Why rejected:* The research disagrees sharply. The intuition breaks down because agents don't have tenure at their specialty — the "tech-lead agent" isn't actually a better tech-lead than the "engineer agent" when both are GPT-4 turbo. You pay the handoff tax without earning specialization benefit.

### Multi-agent, flat ("bag of agents")

*What it is:* Multiple peer agents work on the same problem concurrently, merging or voting on results.

*Why plausible:* Parallelism. Ensemble-like robustness.

*Why rejected:* Worst of the three per the 2026 research — 17× error amplification. Voting/merging layers introduce additional failure modes (agents optimizing for the voting rule rather than the original task).

### Single assistant with automatic "handoff to self" between phases

*What it is:* Pretend there are multiple agents but run them in sequence on the same model, passing a structured summary between phases.

*Why plausible:* Preserves workflow discipline.

*Why rejected:* The "structured summary" is a handoff. You've re-introduced context loss at every phase boundary. Better to let the model manage its own working memory within one continuous context.

### No workflow structure at all (pure chat)

*What it is:* Single assistant, but no mandated phase progression. Let the model decide.

*Why plausible:* Maximum flexibility.

*Why rejected:* Pair-programming sessions without structure degrade into "vibes coding" — diffs without blast-radius analysis, features without migration plans, shipped code without ADRs. The 8-phase workflow isn't dogma; it's a forcing function for the kind of rigor we want. See [The 8-phase workflow](../concepts/eight-phase-workflow.md).

## Related

- [Single assistant — narrative](../concepts/single-assistant.md) — the explanatory version of this decision.
- [The 8-phase workflow](../concepts/eight-phase-workflow.md) — what replaces "multiple agents."
- [`personality.ts` CORE_BEHAVIOR](../../../packages/runtime/src/personality.ts) — where this is encoded in MARVIN's system prompt.
- [CLAUDE.md Golden Rule 1](../../../CLAUDE.md) — the same claim stated as a repo-level rule.
