# ADR-0036 — Ask / Agent / Plan modes + live to-do list

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
