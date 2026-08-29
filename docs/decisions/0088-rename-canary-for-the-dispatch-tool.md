# ADR-0088 — Gate the subagent dispatch by SHAPE, not only by name

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0079](./0079-subagent-tool-rename-and-rails.md) (the rename that went undetected), [ADR-0073](./0073-agent-sdk-0-3-upgrade.md) (where the misdiagnosis came from)

## Context

The user asked whether the `Task` / `Agent` / `system/init` discrepancy is
still a problem. Audited, the answer is nuanced:

**Not a runtime issue today.** Nothing in MARVIN reads `system/init`'s tool
list — it is used only to capture the slash-command catalogue. The gate
matches both spellings from one definition (`SUBAGENT_DISPATCH_TOOLS`), and
`isSubagentDispatch()` is called at every decision point. Verified live on SDK
0.3.251: `system/init` still says `Task` while `tool_use` blocks say `Agent`,
and MARVIN handles both.

**But two latent traps remain**, and they are the same shape as the bug that
made ADR-0079 necessary:

1. **Copies of the list.** `AUDITOR_DISALLOWED_TOOLS` re-listed `"Task",
   "Agent"` as literals. When the canonical set gains a third name, a copy
   that does not is exactly how ADR-0079 happened.
2. **Name matching is inherently one rename behind.** Every guard asks "is the
   tool called X". `Agent` cost months of ungated dispatch because it wasn't
   on the list and `classifyToolCall` blanket-allows anything not in
   `KNOWN_TOOL_NAMES`. A fourth name would do it again.

## Decision

**1. Derive, don't copy.** `AUDITOR_DISALLOWED_TOOLS` spreads
`SUBAGENT_DISPATCH_TOOLS`. One edit adds a future name everywhere.

**2. Gate by shape.** `looksLikeSubagentDispatch(name, input)` — an
unrecognised tool whose input carries a non-empty `subagent_type` is a
dispatch whatever it is called. Such a call:

- is checked **before** the not-in-the-gated-set blanket-allow, which is the
  hole ADR-0079 fell through;
- goes through the sanctioned-`subagent_type` ladder, so an unknown type
  confirms and a sanctioned one auto-allows;
- inherits the ADR-0030 read-only collapse when it carries an `agentID`;
- emits `gate.unknown_dispatch_tool`, because the *correct* fix is still to
  add the name to `SUBAGENT_DISPATCH_TOOLS` — the canary buys safety, not a
  reason to stop maintaining the set.

The canary is deliberately narrow: no `subagent_type`, no canary. An ordinary
unknown tool is still blanket-allowed, unchanged.

### Considered and not taken

- **Deriving the tool name from `system/init`.** It reports `Task` while the
  wire uses `Agent`; trusting it is what produced ADR-0073's wrong
  "verified live" claim in the first place.
- **Denying unknown dispatch-shaped tools outright.** A false positive would
  block real work, and the sanctioned-type ladder already routes the risky
  case to `confirm`.

## Consequences

- A future rename degrades to "gated correctly, logged loudly" instead of
  "silently ungated for months".
- One line adds a new name; the auditor and every guard follow automatically.
- Found while implementing: `classifyToolCall` is reachable with `undefined`
  input, and the first version of the canary threw on it — which would have
  taken the whole turn. An existing test caught it; the canary is now
  null-safe and that case is pinned.

## Scope of Done

- [x] `AUDITOR_DISALLOWED_TOOLS` derives from `SUBAGENT_DISPATCH_TOOLS`
- [x] Shape-based canary checked before the blanket-allow, with telemetry
- [x] Unknown dispatch tools get the sanctioned-type ladder and the read-only
      collapse; ordinary unknown tools are unaffected
- [x] Null-safe, pinned by test
- [ ] Not in scope: deriving names from `system/init`; auto-denying unknown
      dispatch tools
