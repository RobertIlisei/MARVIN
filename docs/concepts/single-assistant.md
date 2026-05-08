# Single assistant, not an agent team

This is the most-violated principle in 2026 AI pair-programming tools. It's also MARVIN's most load-bearing design choice. If you don't buy this, you won't understand why MARVIN refuses to do a bunch of things.

## The claim

**One Claude session, in a user ↔ MARVIN loop.**

Not:
- CEO-agent dispatching PO-agent dispatching engineer-agents
- Role catalogs with kanban-as-source-of-truth
- "Agent teams" that hand tasks off to each other

MARVIN's "roles" are **phases** one assistant moves through in one conversation, not peers that hand off. See [The 8-phase workflow](./eight-phase-workflow.md).

## Why — the research

Published work on 2026 sequential-coding tasks (Google, UIUC, Microsoft, Anthropic Research) shows:

- Multi-agent autonomy degrades quality **up to ~70%** on sequential code work vs a single capable assistant.
- Flat-topology "bag of agents" setups **amplify error rates 17×** through context-loss failures at every handoff.
- The failure mode that dominates: an agent downstream of a handoff doesn't have the context it needs, makes a plausible-looking but wrong assumption, and subsequent agents compound the error.

These aren't edge cases. Sequential code work is *exactly* where the handoff tax hurts most — every step depends on decisions made earlier, which means every handoff loses fidelity.

## The subagent exception

MARVIN *does* spawn subagents. But only via Claude Code's native `Task` tool, and only for:

1. **Breadth-first exploration** — "search these 40 files for a pattern" (subagents run in parallel, don't need each other's context).
2. **Bulk independent work** — "summarize these 20 chat transcripts" (each item is self-contained).
3. **Context relief** — offload a large read whose *result* matters but whose *intermediate reasoning* doesn't, to keep the main context uncluttered.

What MARVIN will *not* do:

- Spawn a subagent to make an architectural decision that the main thread will then build on. That's a handoff with all the context-loss failure modes.
- Let a subagent write code the main thread hasn't reviewed. Code edits happen in the main loop, under the confirm gate, visible to you.
- Dispatch subagents through a "task artifact" / "kanban" layer. That's multi-agent orchestration by another name.

See [`personality.ts` → CORE_BEHAVIOR → "Subagent delegation"](../../sidecar/packages/runtime/src/personality.ts) for the exact rules encoded in MARVIN's system prompt.

## What this looks like in practice

**Good (single-assistant):**

> "Let's add OAuth to the login page."
>
> MARVIN: *queries the graph, reads `lib/auth.ts` + callers, reads the existing ADRs, proposes a plan with trade-offs, asks for go-ahead, applies the diff, runs typecheck, offers to commit.*

All of that happened in one conversation, one Claude session, one continuous context.

**Bad (multi-agent) — what MARVIN refuses to do:**

> "Let's add OAuth to the login page."
>
> PO-agent: *writes ticket*
> Tech-lead-agent: *reads ticket, writes spec*
> Engineer-agent-1: *reads spec, writes backend*
> Engineer-agent-2: *reads spec independently, writes frontend*
> QA-agent: *reads diff, writes tests*
> Release-agent: *writes changelog*

Every arrow is a context-loss boundary. By the time the QA-agent is writing tests, it has no memory of why the tech-lead chose the OAuth flow it did. The handoff tax is paid six times.

## User implication

You are the **continuous overwatch**, not a second-tier approver sitting downstream of other agents. If MARVIN is about to take a wrong turn, you'll see it in real time — because there's only one actor making decisions, and its reasoning is narrated as it goes.

This means:

- You *should* skim MARVIN's plan before approving work. It's not a rubber stamp; if you disagree with a trade-off, this is the cheap moment to redirect.
- You *don't* need to review every file read or grep — those are part of MARVIN's reasoning, not artifacts you own.
- When MARVIN delegates to a subagent (reports "dispatching 4 readers in parallel"), the subagents work in your context only long enough to return a compact summary. They don't make decisions for you.

## When this is wrong

The research is on **sequential code work**. For problems that decompose cleanly into truly independent sub-problems (running 100 evals in parallel, summarizing 500 PRs), multi-agent parallelism is strictly better.

MARVIN is not the right tool for those workloads. It's built for the pair-programming loop, which is almost never cleanly decomposable.

## Related

- [ADR-0001 — single assistant, not an agent team](../decisions/0001-single-assistant.md) — the formal decision record.
- [The 8-phase workflow](./eight-phase-workflow.md) — how "roles" become phases.
- `personality.ts` [`CORE_BEHAVIOR`](../../sidecar/packages/runtime/src/personality.ts) — what MARVIN's system prompt actually says on this.
