# ADR-0040 — Interactive AskUserQuestion (clickable decision options)

**Status:** Accepted — 2026-06-14
**Touches:** `sdk-runner.ts` (route `AskUserQuestion` through the confirm
registry in every mode), native `AskQuestionSheet` / `ChatPreviewView` (render
the options + return the answer), `ChatService.respondToConfirm`
(`updatedInput` passthrough), `personality.ts` (use the tool for decisions).
Builds on the confirm gate (ADR-0015) and the confirm round-trip
(`confirm-registry.ts` + `/api/confirm`).

## Context

During plan execution the model frequently hits a real fork ("build the detail
page now vs defer", "approach A vs B") and, per the plan contract, pauses to
ask. It asked in **prose** ("Decision 1 — … (a) … (b) …") and stopped. MARVIN
had no structured-question surface, so the user's only affordances were the
generic **Continue** chip (which sends a canned resume and ignores the
question) or typing a freeform answer. There was no way to *pick* an option —
unlike Cursor / Claude Code, which render the model's `AskUserQuestion` tool as
clickable buttons.

The Claude Agent SDK already exposes **`AskUserQuestion`** as a first-class
built-in tool (`AskUserQuestionInput` / `AskUserQuestionOutput` in
`sdk-tools.d.ts`): `questions[]`, each with `question`, `header`, and
`options[]` of `{ label, description, preview? }`, optionally `multiSelect`.
In headless `query()` usage the tool is surfaced **through the `canUseTool`
callback**, and the host returns the user's choice as the tool RESULT via
`{ behavior: "allow", updatedInput: AskUserQuestionOutput }` (the
`updatedInput` carries `{ questions, answers }`, answers keyed by full question
text, multi-select joined with commas). If `canUseTool` never resolves it, the
turn **hangs** — so MARVIN must handle it explicitly.

## Decision

Treat `AskUserQuestion` as a **decision that rides the existing confirm
channel**, not a permission:

1. **Runtime.** A `maybeAskUserQuestion` short-circuit at the top of *both*
   `canUseTool` builders (auto + gated, before classification) routes
   `AskUserQuestion` through the **same `confirm-registry` + `onConfirmRequest`
   path** gated confirms use. It fires in **every mode** (auto / gated / plan /
   ask) because a question can never be auto-answered — there's no sensible
   default for "which option does the user want". When no UI is wired (a
   headless wakeup turn), it denies with a "proceed on your recommendation"
   message instead of hanging.
2. **Response.** No API change — `/api/confirm` already forwards `updatedInput`
   on `allow`. `ChatService.respondToConfirm` gains an `updatedInput`
   parameter; the native `respond` forwards it.
3. **Native UI.** The sheet presentation branches on
   `toolName == "AskUserQuestion"` to render **`AskQuestionSheet`** instead of
   the Allow/Deny `ConfirmSheet`: each question with its options as selectable
   rows (label + description + optional preview), single- or multi-select, plus
   the auto-added **"Other"** free-text. "Send choice" returns
   `{ questions, answers }`; "Skip — you decide" denies with a nudge to proceed
   on the model's own recommendation, so the turn never hangs.
4. **Prompt.** `personality.ts` instructs the model to call `AskUserQuestion`
   for genuine forks (especially during plan execution) rather than writing
   prose options — and to reserve it for real decisions, not things it can
   settle from the code or sensible defaults.

The prose-decision detection chip (the `PlanDecision` heuristic + "answer in
the box / use the rec" chip) stays as a **graceful fallback** for turns where
the model still asks in prose.

## Rejected alternatives

- **Parse the model's prose options into buttons.** Reproduces the *look* using
  the prose the model already emits, no SDK/model change — but brittle to format
  drift and not the real mechanism. Kept only as the fallback chip.
- **A bespoke MCP `ask_user` tool.** Would need its own correlation id between
  the streamed tool_use and the handler's blocking promise; the built-in
  `AskUserQuestion` already arrives at `canUseTool` with the `toolUseID`, so the
  confirm registry keys it for free.
- **Inline-in-chat rendering instead of a modal sheet.** Deferred — the modal
  reuses the existing `pendingConfirms` queue + `.sheet` presentation and
  guarantees the blocked turn is seen. Inline is a possible later refinement.

## Scope of Done

- [x] `AskUserQuestion` routes through the confirm registry in auto + gated
      `canUseTool`; denies (no hang) when no UI is wired.
- [x] `respondToConfirm` / `respond` forward `updatedInput`; `/api/confirm`
      unchanged.
- [x] `AskQuestionSheet` renders questions + options (single/multi + Other) and
      returns `{ questions, answers }`; Skip denies with a proceed nudge.
- [x] Sheet presentation branches on `AskUserQuestion`; Bash/Edit confirms
      unaffected.
- [x] `personality.ts` + the plan-execution control instruction tell the model
      to use the tool for decisions.
- [x] runtime `tsc` clean; `swift build` clean.
- [ ] Runtime-verified end to end (model asks → buttons → answer returns) —
      pending a live session; the `updatedInput → tool result` mapping follows
      the SDK type defs + claude-code-guide's reading but isn't yet exercised
      against a real turn.
