# ADR-0036 — Ask / Agent / Plan modes + live to-do list

> **Revised by [ADR-0046](./0046-plan-as-durable-spine.md) (2026-06-22) — plan
> as the durable spine.** The two-tier model below kept a single flat
> `todos` array + one plan slot, both wholesale-replaced; a mid-plan
> `TodoWrite` erased the plan and a second plan clobbered the first. ADR-0046
> makes the active plan own hierarchical steps, reconciles incoming
> `TodoWrite`s into them, computes completion over top-level steps only, and
> keeps prior plans in a navigable session list. The tier-1 / tier-2
> distinction below is unchanged.
>
> **Revision 2026-06-11 (v0.1.24) — Plan mode decoupled.** The first cut used
> the SDK's coupled plan permissionMode (plan → ExitPlanMode modal → execute
> in the same turn, same model). Live use exposed three faults: (1) approval
> popped a **modal window** instead of being inline like Cursor; (2)
> approving/continuing stayed in plan mode, so MARVIN **re-planned** instead
> of executing (a "second plan" appeared); (3) plan and execute couldn't use
> **different models**. Revised design: **Plan mode is a read-only planning
> turn** (same `readOnly` gate as Ask) that presents a numbered plan **inline
> in the chat and stops** — no ExitPlanMode, no modal. The turn runs on the
> chosen **advisor** model (role-routed, not hardcoded). An inline **"Approve
> & execute"** chip then switches to **Agent mode** and runs the plan in a
> **separate turn on the executor** model. So planning and execution use the
> models you selected for each role, and re-planning can't happen because
> execution isn't plan mode. The old ExitPlanMode/`ConfirmSheet` plan path
> and SDK `permissionMode: "plan"` are retired.
>
> **Addendum 2026-06-12 — the plan card.** Decoupling left the plan as a
> plain-text bubble. The plan-mode prompt now mandates the reply open with
> `# Plan — <title>`; the native renderer detects that heading and shows the
> message as a structured, collapsible **plan card** (`PlanCardView` —
> title, step count, styled steps), Cursor-style. Detection is
> content-shaped, so it also applies on transcript replay; a plan missing
> the heading degrades to the plain bubble. Approve seeds the To-dos strip
> from the plan's steps.
>
> **Addendum 2026-06-13 — two-tier to-do/plan + plan file in the editor.**
> Live use surfaced that the plan card (in the chat scroll) and the to-do
> strip (above the input) read as *two artifacts that replace each other* —
> approving a plan made the card scroll away and a separate, identical-looking
> "To-dos" strip take its place. Cursor actually keeps **two distinct tiers**,
> and they coexist:
>
> - **Tier 1 — Task list.** A bare `TodoWrite` checklist the agent emits for
>   any multi-step Agent-mode task. Ephemeral, *no plan behind it*. Neutral
>   styling ("Task list", blue, `checklist` icon).
> - **Tier 2 — Plan.** A plan-backed checklist (Plan mode, approved). The plan
>   *is* the to-do list — it persists and ticks off in place. Purple, titled
>   from the `# Plan — <title>` heading, `map` icon, with an "Open plan"
>   affordance.
>
> The `TodoListStrip` now forks on `planTitle != nil` (driven by
> `currentPlanText != nil` in `ChatPreviewView`) to render the right tier, so
> a bare task list never reads as a plan and vice-versa. And, matching Cursor,
> a presented plan is **auto-written to `<workDir>/.marvin/plans/<slug>.md`
> and opened in the editor pane** (`persistAndOpenPlan` → `setSelectedFile`),
> so the user can actually see the plan file; the strip's "Open plan" button
> re-focuses it. The plan-mode prompt contract in `personality.ts` is updated
> to match the revised inline-`# Plan` / stop model (the stale `ExitPlanMode`
> wording is removed) and to make Agent mode open a tier-1 task list for 3+
> step work.

**Status:** Accepted — 2026-06-11
**Touches:** `sdk-runner.ts` (new `mode` axis, read-only gate, plan
permissionMode), chat API route, native `ChatAgentsFooter` / `NativePrefs`
/ `ChatPreviewView` (mode selector + plan-approval + to-do panel),
`personality.ts` (mode contracts). Builds on the permission gate
(ADR-0015), the subagent read-only invariant (ADR-0030), and the change-
review surface (ADR-0034).

## Context

Cursor / VS Code agent surfaces let the user pick how much autonomy the
assistant has per request:

- **Ask** — read-only Q&A. Explores and explains; never edits.
- **Agent** — full autonomy: reads, edits, runs commands, multi-step.
- **Plan** — drafts a plan + a to-do checklist first, waits for approval,
  then executes, ticking items off as it goes.

MARVIN had only the **auto / gated** *permission strategy* (ADR-0015) —
"how is each edit confirmed" — which is a different axis from "what is the
assistant allowed to attempt this turn." There was no read-only mode and no
first-class plan/approval surface, even though the underlying Claude Agent
SDK already supports a `plan` permission mode and a `TodoWrite` tool.

**Single-assistant caveat (Golden Rule 1).** "Agent mode" here is the
*autonomy level of the one assistant* — NOT multi-agent dispatch. None of
these modes spawn an implementation agent team; the sanctioned read-only
subagents (advisor / scout / dynamic workflows) are unchanged.

## Decision

Add a **`mode` axis — `ask | agent | plan`** — orthogonal to the existing
`auto | gated` permission strategy. Both are kept (confirmed with the user):
mode = *what MARVIN may do*; strategy = *how edits get confirmed while it
executes*. Default is **`agent`**, so untouched behaviour is identical to
pre-0.1.22.

| Mode | `permissionMode` | Gate behaviour | Edits? |
|---|---|---|---|
| **ask** | `default` | read-only invariant: any mutating tool hard-denied | no |
| **agent** | `default` | the `auto`/`gated` strategy (unchanged) | yes |
| **plan** | `plan` (SDK-native) | SDK auto-denies edits; ExitPlanMode → approval | after approval |

### Ask — read-only at the gate

`classifyToolCall` already collapses the decision ladder to a hard-deny for
any **subagent** mutation (the ADR-0030 `agentID` invariant). Ask mode
reuses the exact mechanism for the **main loop**: a `readOnly` flag makes
`classifyToolCall` deny anything that isn't auto-class (Edit / Write /
NotebookEdit / mutating Bash) with an "Ask mode is read-only" reason.
Read-only tools — Read / Grep / Glob / read-only Bash / the graph MCP —
still allow. An SDK-level `disallowedTools: [Edit, Write, NotebookEdit]`
backstops the gate (same belt-and-braces as the scout). Enforced, not
advised — the firm-surfaces philosophy.

### Plan — the SDK's native plan mode + approval

`permissionMode: "plan"` (was hardcoded `"default"`). The SDK drafts a plan,
auto-denies edits during planning, and surfaces an **ExitPlanMode** request
that MARVIN renders as a plan-approval card. Approve → the turn proceeds to
execution under the session's *Agent* posture (the `auto`/`gated` strategy
applies to the edits that follow); reject → the plan is discarded. The user
chose approval-gated over auto-proceed.

### To-do list — driven by `TodoWrite`

The model's `TodoWrite` tool is the source of truth (it already rewrites the
whole list with per-item status each call). MARVIN captures `TodoWrite`
tool-input from the turn event stream and renders a live native checklist
that ticks off as items move to `completed`. No bespoke todo protocol — we
surface what the SDK already emits. (Phase 2.)

## Phasing

- **Phase 1** — the three modes end to end: runtime `mode` wiring, Ask
  read-only gate + test, Plan `permissionMode` + approval card, native mode
  selector (persisted, defaults to Agent), `personality.ts` contracts.
- **Phase 2** — the live to-do checklist from `TodoWrite`.

## Rejected alternatives

- **Fold perms into modes** (Agent ⇒ auto, Plan ⇒ gated). Rejected: loses
  gated-confirm *inside* Agent, which the user relies on. Kept orthogonal.
- **Ask mode by prompt only.** Rejected: no hard guarantee; the gate is the
  honest enforcement point and the mechanism already exists.
- **A bespoke todo tool / parsing the plan text.** Rejected: `TodoWrite` is
  already emitted by the model — surface it rather than invent a parallel.

## Scope of Done

- [ ] `mode` axis plumbed UI → route → `runAgent`; defaults to `agent`
      (untouched behaviour unchanged).
- [ ] Ask hard-denies main-loop mutations at the gate (+ unit test); reads
      still work.
- [ ] Plan runs under `permissionMode: "plan"` with an approval card before
      execution.
- [ ] Native mode selector in the agents bar, persisted across reloads.
- [ ] Live to-do checklist from `TodoWrite` (Phase 2).
- [ ] `personality.ts` documents the three modes; runtime + web tsc clean;
      `swift build` clean.
