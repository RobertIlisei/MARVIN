# ADR-0081 — Implementer subagents on isolated worktrees: the one amendment to Golden Rule 1

- **Status:** Accepted
- **Date:** 2026-08-29
- **Related:** [ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md) (the `agentID` invariant this amends),
  [ADR-0077](./0077-ai-native-sdlc-selective-adoption.md) (N human-steered sessions on separate trees — the topology this automates),
  [ADR-0079](./0079-subagent-tool-rename-and-rails.md), [ADR-0080](./0080-background-subagents-and-builtin-readonly-agents.md) (the two steps that made this possible)

## Context

> "I want our Marvin to work faster. Currently waiting for 1 agent to finish
> something and then continuing with something else kills our speed."

ADR-0080 fixed the half of that which was a wiring bug: research no longer
blocks the turn. This ADR is the other half — letting MARVIN **build** two
things at once — and it is the first change to Golden Rule 1 since it was
written.

### What changed in the evidence

The rule was written against Anthropic's June 2025 finding that "most coding
tasks involve fewer truly parallelizable tasks than research" and against the
flat-swarm failures of the 2026 literature. Since then:

- Anthropic's **2026-08-13** *Patterns and problems in multiagent systems*
  measured collaborative coding across model generations: Sonnet 4.6 / Opus
  4.6 merged "a very low fraction" of PRs; Opus 4.8 avoided conflicts by
  "hardly working together at all"; **Sonnet 5 achieved "high code sharing"
  while "maintaining a high PR throughput."**
- The same paper's failure modes are **all shared-state failures**: "when one
  agent makes a bad decision, it is likely that many agents will make that
  same bad decision" — 18 of 30 agents chose the identical branch name;
  2.4 M job requests for 117 accepted jobs.
- Claude Code's own **Agent Teams** — the shared-task-list, self-claiming
  shape Golden Rule 1 calls camp 2 — is experimental, documents "two
  teammates editing the same file leads to overwrites", and is **unavailable
  to Agent SDK sessions** entirely.

So the rule's target was always the *sharing*, and the sharing can now be
removed mechanically.

### What was verified live (all 2026-08-29, SDK 0.3.245)

| Claim | Result |
|---|---|
| `EnterWorktree` from inside a subagent | **Refused**: "would mutate the parent session's process-wide working directory … spawn an Agent with `cwd` set to it" |
| `cwd` input on the `Agent` dispatch | **Accepted, not honoured** — Sonnet passed the worktree path correctly; the subagent's `pwd` was still the main tree and its file landed there |
| A subagent's `Write` reaches `canUseTool` | Yes, with `agentID` **equal to `task_started.task_id`**, and with the path already **resolved to absolute** even when the model passed a relative one |
| Read-only Bash / Read from a subagent | Auto-allowed by the CLI **without** consulting `canUseTool` |

| `runAgent` with a string prompt (single-message mode) | **Every** subagent tool call after the first `result` is denied by the SDK with its generic "the user doesn't want to take this action" — before MARVIN's hooks or gate. Four live runs died on the implementer's first call before this was isolated; `runAgent` now always uses a `TurnInputChannel` |

The last two rows of the table above are the design: MARVIN can identify the agent and see the
absolute target of every write; it cannot see reads, and it cannot rely on
the SDK to place the agent in the tree.

## Decision

**Golden Rule 1's invariant becomes: a subagent cannot mutate the *main*
working tree.** Everything else about the rule stands — no supervisor, no
swarm, no self-claiming task list, no model commanding a model.

1. **MARVIN creates the worktree and names the branch.** `worktree_create`
   on `marvin-control`: `<workDir>/.marvin/worktrees/<slug>` on
   `marvin/<slug>`, cut from the current `HEAD` (not `origin/<default>` — the
   implementer must see the user's unpushed work), excluded via
   `.git/info/exclude`, registered in `.marvin/worktrees.json`. The subagent
   never chooses a name; that is the conformity failure, removed at source.

2. **An `implementer` agent, bound at dispatch.** `task_started` carries the
   `task_id` and the dispatch prompt; a `SubagentRegistry` maps `agentID` →
   type and binds an implementer to the **one** registered worktree its
   prompt names. Naming none or several leaves it unbound, and an unbound
   implementer gets the ordinary read-only collapse.

3. **Containment at the gate, on absolute paths.** For a bound implementer:
   `Edit`/`Write` allowed iff the resolved target is inside its worktree
   (a relative path resolves against the main tree and is denied with the
   reason); `Bash` is **rewritten** to `cd '<worktree>' && (<cmd>)` via
   `updatedInput`, and denied on `..`, `~`, or an absolute path outside the
   tree other than toolchain prefixes; the destructive / publish hard-deny
   floor applies unchanged. Not granted in Ask mode.

4. **The deliverable is a branch. The user merges.** `worktree_list` reports
   commits ahead of base; `worktree_remove` drops the checkout and keeps the
   branch. Nothing auto-merges.

5. Background (ADR-0080), `maxTurns: 60`, model inherited, `WebFetch` and
   `NotebookEdit` disallowed, `marvin-graph` attached.

### Considered and not taken

- **Relying on the SDK's `isolation: worktree`** — frontmatter only; MARVIN
  runs in isolation mode and does not load agent files. And `cwd` on the
  dispatch is ignored, so there is no API-level placement to lean on.
- **Remapping the implementer's *reads* into the worktree** — `PreToolUse`
  hooks carry no agent id, so a remap would hit the main session too. Reads
  of the main tree are stale, not harmful; the prompt demands absolute paths
  and the write-deny message teaches the rule on first contact.
- **Auto-merge on green tests** — the user asked to decide merges
  ("i will be the one deciding if we move with the merge").

## Consequences

- MARVIN can run N independent builds while continuing in the main loop;
  each is an ADR-0077 "separate session on a separate tree", spawned instead
  of typed.
- The main tree is exactly as protected as before this ADR — the collapse
  is untouched for every non-implementer call and for every implementer call
  outside its tree; pinned under both `Task` and `Agent` spellings.
- Cost: each implementer is a full agent loop on the executor's model.
  Bounded by `maxTurns`, but real; the prompt's MUST-NOT list is the brake.
- Known limitation: an implementer that uses relative paths reads the main
  tree. Its own writes are denied with an explanatory reason, so the failure
  is loud, not silent.

## Scope of Done

- [x] `worktree_create` / `worktree_list` / `worktree_remove` on `marvin-control`
- [x] `implementer` registered; bound from `task_started`; gate opens only its tree
- [x] Bash pinned by rewrite; escapes and the hard-deny floor denied
- [x] Golden Rule 1 amended in `CLAUDE.md` and the implementer protocol in `personality.ts`
- [x] Pinned by tests, including real-git lifecycle
- [x] Verified live through `runAgent` (streaming input): `greeting.js` written in the worktree only, `node` verified it, commit `afc7ee7` on `marvin/add-greeting-module`, main `HEAD` unchanged and status clean
- [ ] Not in scope: auto-merge, read remapping, more than one implementer per worktree
