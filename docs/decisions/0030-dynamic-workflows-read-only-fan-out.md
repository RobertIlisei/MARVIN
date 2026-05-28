# ADR-0030 — Dynamic workflows as a third sub-agent pattern, scoped read-only

**Status:** Accepted — 2026-05-28
**Extends:** [ADR-0007](./0007-advisor-as-subagent-pattern.md) (advisor), [ADR-0014](./0014-scout-subagents-read-only.md) (scout)
**Touches:** [Golden Rule 1](../../CLAUDE.md) — adds a third sanctioned sub-agent pattern

## Context

Anthropic shipped **dynamic workflows** in Claude Code: Claude writes
orchestration scripts that spawn tens-to-hundreds of **parallel sub-agents**
in a single session, with verification / adversarial loops, resumable
progress. Aimed at codebase-wide audits, bug hunts, profiler-guided
optimization, and large migrations. Activated by `effort: xhigh` (the
"ultracode" regime) or by an explicit request.

MARVIN just gained an effort-level picker that exposes `xhigh` (the effort
ladder commit). That makes dynamic workflows **reachable** from a normal
MARVIN turn — which collides head-on with [Golden Rule 1](../../CLAUDE.md):

> *"Single assistant, not an agent team… that pattern degrades up to 70% on
> sequential code work and amplifies errors 17× in flat-topology 'bag of
> agents' setups. The two sanctioned exceptions are the advisor and the
> scout. Any new subagent type requires a new ADR."*

This ADR is that required ADR.

### Spike findings (verified against the installed SDK 0.2.113 + CLI 2.1.154)

1. The SDK exposes **no `Workflow` tool** to allow/deny. Workflows are
   emergent inside the Claude binary; the SDK only streams
   `SDKTaskStartedMessage { task_type: 'local_workflow', workflow_name }`
   and `task_updated` events back. So the scout enforcement model
   (`disallowedTools` on a MARVIN-defined agent) **does not reach workflow
   children** — MARVIN never defines them.
2. `effort: 'xhigh'` is a valid SDK option; user is on **Max 20x**, entitled.
3. **`CanUseTool` carries `agentID`** — *"If running within the context of a
   sub-agent, the sub-agent's ID."* The parent permission gate is passed the
   sub-agent's ID precisely so it can govern sub-agent tool calls. Combined
   with PreToolUse hooks firing on *every* tool call before the permission
   pipeline, this gives MARVIN a **real tool-layer control point** over
   workflow children, not just a prompt.

### Advisor consult (Opus, 2026-05-28)

Verdict: **ACCEPT with a tighter boundary.** Key corrections, adopted here:

- **Re-cut the boundary from task-semantics to tool-capability.** "Audit-only"
  forces the model to self-classify ("is this audit or implementation?") —
  exactly what fails under pressure. State the line as a mechanical
  invariant: *spawned workflow agents are read-only at the tool layer.*
- **A prompt-only MUST-NOT is theater under auto-mode** (no human in the
  loop). The principled version requires the tool gate. Because `canUseTool`
  fires for sub-agent calls (the `agentID` fact), wire a deny-on-mutate rule.
- **Be honest about Rule 1's evidence.** The 70% / 17× figures describe
  *flat* topology and *sequential* code work. Dynamic workflows are
  hierarchical (orchestrator + verification) and the sanctioned use is
  parallel *read* fan-out — which the literature *supports*. So this carves
  out the **read-only slice Rule 1 never had evidence against**. That
  carve-out is principled **only if read-only is mechanically enforced**.

## Decision

**Sanction dynamic workflows as a third sub-agent pattern — but only as
read-only fan-out, enforced at the tool layer, opt-in, never automatic.**

### 1. The boundary is a tool-capability invariant, not a task category

**No MARVIN sub-agent — scout, advisor, or dynamic-workflow child — may
mutate the workspace.** Concretely, in `classifyToolCall` (the gate both
`auto` and `gated` modes share): when the SDK reports an `agentID` (i.e. the
call originates in a sub-agent), any tool that would otherwise `confirm` or
`deny` is **hard-denied** — Write / Edit / NotebookEdit and any unsafe or
destructive Bash. Read-only / whitelisted tools (auto-class) still allow.
The hard-deny regex floor (e.g. `rm -rf`, force-push) applies on top,
unchanged. See `sdk-runner.ts::classifyToolCall` + the dispatch tests.

This means "migration analysis, not execution" falls out for free: analysis
reads, execution writes — and writes from a sub-agent are denied.

### 2. Effort is opt-in, never auto

`xhigh` (the ultracode rung that lets Claude auto-decide to spawn workflows)
is exposed in the picker but is **never auto-selected** by MARVIN. The
default stays `high`. A workflow only ever runs because the user picked
`xhigh` or explicitly asked for one.

### 3. Prompt-level MUST / MUST-NOT (defense-in-depth, not the primary gate)

`personality.ts` gains a "Dynamic workflows" section mirroring scout/advisor:
MUST use only for read-only audit/research/discovery fan-out; MUST-NOT for
parallel implementation, cross-agent file mutation, or replacing the single
user↔MARVIN loop for normal work. The prompt is the *first* line; the gate
(§1) is the *enforced* line.

## Consequences

**Positive**
- Repo-scale read-only audits (security-audit, pr-review), breadth-first
  surveys, and migration *discovery* can fan out — the regime where
  parallelism genuinely helps.
- Read-only is **mechanically enforced** for every sub-agent, closing the
  gap that scouts only had via `disallowedTools`.
- The invariant is simpler than the old per-type story: one rule covers
  scout, advisor, and any future sub-agent.

**Negative / mitigated**
- The `agentID`-fires-for-workflow-children fact is verified *by type
  contract* (the field's documented purpose) but not yet pinned by a live
  `local_workflow` run. *Mitigated:* the deny rule is safe regardless — no
  current sub-agent writes — and the Scope of Done flags the live check as
  the one open item.
- Token cost of workflows is high. *Mitigated:* opt-in only; surfaced via
  the existing cost tracker.
- A future sub-agent that legitimately needs to write would be blocked.
  *Mitigated:* that requires an ADR amendment — same bar as scout.

**Reversibility**
Fully reversible: drop the `agentID` branch in `classifyToolCall` and the
personality section to revert to "workflows reachable, ungoverned" (status
quo before this ADR), or remove `xhigh` from the picker to make them
unreachable again.

## Scope of Done

- [x] `classifyToolCall` denies workspace-mutating tools when `agentID` is present; both gate callbacks thread `agentID` through.
- [x] Dispatch tests pin the invariant (allow reads, deny Write/Edit/NotebookEdit/unsafe-Bash from a sub-agent; main-loop behaviour unchanged).
- [x] `personality.ts` "Dynamic workflows" MUST/MUST-NOT section added.
- [x] `xhigh` exposed but never auto-selected (default stays `high`).
- [x] Golden Rule 1 + firm-surfaces table updated in CLAUDE.md.
- [ ] Live verification: a `local_workflow` child's mutating tool call is actually denied by the gate (needs an entitled xhigh workflow run; the type contract says it will, but it hasn't been observed end-to-end).
