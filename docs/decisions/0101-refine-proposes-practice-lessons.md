# ADR-0101 — `/refine` proposes practice lessons; it never writes them

- **Status:** Accepted — implemented 2026-09-01
- **Date:** 2026-09-01
- **Related:** [ADR-0042](./0042-memory-as-durable-facts.md) (memory is facts, and what happens when a store takes the wrong content class), [ADR-0044](./0044-project-backlog.md) (the backlog is work), [ADR-0047](./0047-capture-at-discovery-consent-at-review.md) (capture at discovery, consent at review), [ADR-0085](./0085-graphify-beyond-search.md) (the graph work-memory loop and its measured starvation), [ADR-0100](./0100-advisor-caveats-are-conditions-not-backlog.md) (content class decided at the write boundary)

## Context

Prime Intellect's [Prime Agent](https://www.primeintellect.ai/blog/prime-agent)
(MIT, 19.5k stars) proposes a **Continual Harness**: prompts, memories, skills
and subagent specs as durable state the agent refines from its own trajectory,
triggered by `/refine`, with snapshots for rollback. The user asked whether it
is worth taking.

Most of it is not. Its other abstraction — the **RLM**, where `rlm(...)` spawns
real child agents that share the working directory and talk to each other
without the user — is exactly what Golden Rule 1 forbids, and MARVIN enforces
the opposite at the gate: any call carrying an SDK `agentID` is denied
Write/Edit/unsafe-Bash. Their control surface is a persistent Python REPL in
which "file operations, shell commands, tool use, subagents, and context
management happen through code", which deletes the structural confirm gate —
you cannot pre-flight an `Edit` that is a line inside a program the model
wrote. Their own docs are candid: *"executes model-generated Python and project
commands with your user permissions… not a security sandbox"*, and their
Factorio case study documents reward hacking "despite explicit safeguards".

One idea survives contact, and it is the small one.

**MARVIN has three durable layers and a hole between them.** Measured on a real
project: `.marvin/memory/` holds **106 facts** about the codebase,
`.marvin/backlog/` holds **570 items** of deferred work, `.marvin/plans/` holds
**356 plans**. None of them holds *how to work on this project* — the practice
lessons. On 2026-09-01 a MARVIN session produced four in one day (measure a
layout bug before theorising about it; `onGeometryChange` not
`background(GeometryReader)`, because AppKit counts update passes against the
view count; a rail keyed on vendor tool names outlives nothing) and the only
place they could go was a hand edit to `CLAUDE.md`. A user's project has no
equivalent surface.

**The existing learn-loop proves both the value and the risk.** `graph_reflect`
already aggregates `graph_save_result` outcomes into `LESSONS.md`, and its
**Corrections** section carries genuinely hard-won content — on this project,
that an ADR had assumed `reports.generated_at` proxied an issue date when
`period_start` already held it exactly. That is the shape worth having. But
the loop is **starving, not missing**: `LESSONS.md` here is built from **8
records**, against ADR-0085's measured baseline of *12 saves, 0 reflections*.

And the risk is not hypothetical. MARVIN already had an append-what-you-learned
loop. It reached **419 KB and ~99 % redundancy** with ADRs, git and the
changelog, and caused a context overflow. ADR-0042 exists because of it.

## Decision

`/refine` reviews the session's trajectory and **proposes** durable updates. It
writes nothing.

1. **Read-only by construction.** The command produces proposals. Every one is
   routed through an **existing enforced write path** — `remember` for a fact,
   `backlog_add` for work — so ADR-0042's and ADR-0044's caps and content-class
   rejections still apply. `/refine` adds no new write channel.

2. **Consent at the review, not at discovery.** Proposals are presented
   keep/dismiss, the ADR-0047 shape the backlog already uses. Nothing lands
   because the model was confident.

3. **A `practice` content class, and only that one is new.** A practice lesson
   is *"we tried X, it was wrong, do Y instead"* about **how to work in this
   repo** — distinct from a fact about the codebase (memory), work to do
   later (backlog), a decision (ADR) and status (git). It requires evidence
   from the session: a proposal that cannot cite what happened is rejected at
   the boundary, the same way `backlog_add` rejects a fact.

4. **The base prompt is immutable.** `/refine` never edits `personality.ts`,
   ADRs, or plan files. Prime Agent draws the same line — its refinement
   "never rewrites the immutable base system prompt" — and here the plan and
   memory directories are already gate-denied to direct writes.

5. **Bounded output.** At most a handful of proposals per invocation. A review
   that emits twenty is not a review, and the 419 KB precedent says an
   unbounded learn-loop converges on noise.

## Consequences

**Positive.** The deterministic trigger is the part worth taking. This repo has
measured, repeatedly, that valuable-but-optional model behaviour fires ~0×:
skills across thousands of qualifying contexts, `graph_save_result` at 0 in an
audited window. Relying on MARVIN to *notice* it learned something has a known
failure rate; a command the user runs does not.

**Positive.** No new store, no new write channel, no new injected context. The
proposals land in layers that are already budgeted (ADR-0041) and already
guarded.

**Negative.** Another surface the user must attend to, and its value depends
entirely on the quality of proposals — a `/refine` that suggests obvious things
will be ignored, and a command that is ignored is worse than absent because it
still costs a turn. This is the risk to watch; if it is not earning its keep in
practice, delete it rather than tune it.

**Negative.** It reads the trajectory, which is the largest thing in the
session. The review is a normal turn, so it pays normal context cost — it is
not free, and it should be run at a boundary (scope-met, session end), not
habitually.

**Rejected — a self-refining prompt.** The Continual Harness's most interesting
claim is that the agent edits its own supplemental prompts. MARVIN's firm
surfaces are the load-bearing part of its design and their value comes from
being *fixed* and reviewable; an agent that can soften a MUST it finds
inconvenient has no MUSTs. Prime Agent draws this line too.

**Rejected — a new `.marvin/practice/` store.** A fourth content class with its
own index, MCP tool and injection budget, for something `remember` can hold
with a `kind`. ADR-0100 rejected a `.marvin/conditions/` store for the same
reason: a new store must earn its own lifetime, and this content's lifetime is
the project's, exactly like a fact's.

**Rejected — automatic refinement at turn end.** Every turn producing candidate
lessons is how the 419 KB log happened. The trigger is a command.

## Scope of Done

- [x] `/refine` exists as a slash command and reviews the current session only
      (`NATIVE_COMMANDS` in `slash-commands.ts`; 3 assertions).
- [x] It emits at most 5 proposals, each citing evidence from the session —
      pinned by a test on the expansion, including that "none at all is a valid
      answer", because a review that must produce something produces noise.
- [x] Each proposal routes to `remember` or `backlog_add`; `/refine` itself has
      no write path of its own, and its expansion says so in terms a test
      asserts (`do NOT call \`remember\` or \`backlog_add\``).
- [x] A proposal with no citable evidence is rejected at the boundary —
      `validateRememberPayload` was extracted from the MCP closure precisely so
      this could be tested rather than claimed. 5 assertions, including that
      the evidence floor does not become a way in for the activity/status class
      the store already refuses.
- [x] `personality.ts`, ADRs and `.marvin/plans/` are untouched by it. The
      latter two are already gate-denied; the prompt forbids proposing changes
      to the first.
