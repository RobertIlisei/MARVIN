# ADR-0015 — Auto-mode policy floor + audit log

**Status:** Accepted
**Date:** 2026-04-26
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0004 — Structural confirm gate](./0004-structural-confirm-gate.md),
[ADR-0007 — Advisor as a userland subagent pattern](./0007-advisor-as-subagent-pattern.md),
[ADR-0014 — Read-only scout subagents](./0014-scout-subagents-read-only.md)

## Context

MARVIN's permission model has always exposed two strategies:

- **`gated`** — every mutating tool call (Edit, Write, non-allowlisted
  Bash) renders an inline confirm card. The user clicks allow / deny.
- **`auto`** (default) — full bypass. Documented as
  "matches `claude --dangerously-skip-permissions`."

The `auto` default was a deliberate productivity choice — most users
running MARVIN against a project they own want it to *go*, not pause
on every diff. But the implementation took the SDK's
`permissionMode: "bypassPermissions"` literally: no `canUseTool`
callback was installed, the SDK skipped the gate entirely, and there
was no record of what auto-allowed actions actually fired.

The 2026-04-26 audit (`docs/reviews/2026-04-26-full-audit.md`,
finding #2) made three concrete observations:

1. **The hard-deny floor was leaky.** The Bash regex set in
   `packages/tools/src/policy.ts` matched `rm -rf /…` literally but
   not `rm -rf $HOME/…`, `rm -rf ~`, `rm -rf ../`, `rm -rf *`,
   `git push -f`, `git clean -fd`, `chmod -R 777`, or
   `curl … | sh`. In `auto` mode those silently ran.
2. **`Task` and `NotebookEdit` weren't in `KNOWN_TOOL_NAMES`.** The
   gate's classifier short-circuits to `allow` for anything outside
   that set. A bare `Task` call (no `subagent_type`) inherited the
   parent's permission posture — i.e. bypass — and could spawn a
   subagent doing arbitrary writes. NotebookEdit was unprotected too.
3. **No audit trail.** Even when the auto-allowed call was benign,
   there was no record. The user couldn't, after the fact, ask "what
   did MARVIN actually run today?"

The audit also surfaced a related gap (finding #5): pending confirms
in `gated` mode had no timeout. If the user closed the tab without
deciding, the SDK loop blocked forever waiting on the registry.

## Decision

We change four things in one coherent move. They share a single
underlying principle: **every mutating tool call goes through a
classification step, regardless of the user's permission strategy.
The strategy decides what the gate *does* with confirm-class calls,
not whether the gate runs.**

### 1. `auto` mode now installs `canUseTool` (logging shim)

Before:

```ts
// sdk-runner.ts (pre-#2)
permissionMode: permissionStrategy === "auto"
  ? "bypassPermissions"
  : "default",
...(permissionStrategy === "gated" ? { canUseTool } : {}),
```

After:

```ts
// sdk-runner.ts (post-#2)
permissionMode: "default",
canUseTool: permissionStrategy === "gated"
  ? canUseTool          // user-prompting gate
  : autoModeLogger,     // logging-only shim
```

The `autoModeLogger` runs the same `classifyToolCall` the prompting
gate runs. `deny` decisions still deny (the hard-deny floor stays
load-bearing). `confirm` and `allow` decisions both downgrade to
`allow`, but the call is appended to the audit log first. The user
sees no UI change; the SDK loop is no longer in true bypass mode.

### 2. `BASH_HARD_DENY` tightened — seven new patterns

Pinned at `packages/tools/tests/policy.test.ts` (26 cases). New
patterns cover:

- `rm -rf $HOME(\b|/)`
- `rm -rf ~(\/|\s|$)` — `\b` doesn't anchor on `~`, explicit boundary
- `rm -rf \.\.(\/|\s|$)`
- `rm -rf (\*|\.\*)` — wildcard glob
- `rm -[rR]f?` (was `-rf` only, now matches `-Rf`, `-r`)
- `git push … -f` (shorthand)
- `git clean -[fdx]`
- `chmod -R 777`
- `(curl|wget) … | (sh|bash|zsh)` — pipe-to-shell installer

A 26-case Vitest suite at `packages/tools/tests/policy.test.ts`
asserts each new pattern matches the bad string and that
representative safe commands (`git status`, `pnpm ls`, `make build`)
do not.

### 3. `Task` and `NotebookEdit` now go through the gate

`KNOWN_TOOL_NAMES` is the single set the runner consults; previously
it lived in two places (`packages/tools/src/policy.ts` and
`packages/runtime/src/sdk-runner.ts`) — drift waiting to happen.
Deduped and exported from `@marvin/tools/policy`. Now includes
`Task` and `NotebookEdit`.

`Task` is special-cased in `toolPolicy()`:

- `subagent_type: "scout"` (ADR-0014) → `auto`
- `subagent_type: "general-purpose"` (ADR-0007 advisor) → `auto`
- any other `subagent_type` → `confirm`
- bare `Task` (no subagent_type) → `confirm`

`NotebookEdit` is treated like `Edit` — confirm by default.

### 4. Auto-mode audit log

A new module `packages/runtime/src/auto-audit.ts` exposes
`appendAutoAuditEntry` and `readAutoAuditTail`. The append path
writes one JSON-line per auto-allowed mutating call to
`<workDir>/.marvin/auto-audit.jsonl`. The reader returns the tail
(default 50, hard cap 500) for the Settings UI.

Entry shape:

```ts
{
  at: string;          // ISO-8601
  tool: "Edit" | "Write" | "Bash";
  reason: string;      // policy classifier's reason
  descriptor: string;  // first 200 chars of the descriptor — Bash command, file path
  turnId: string;
  toolUseId: string;
}
```

A new HTTP route exposes the tail to the UI:
[`GET /api/audit/auto?cwd=…&limit=…`](../reference/api.md#audit).

The append is **best-effort and never throws**. A failure to write
the audit line must not block the SDK turn; the user's call is
already happening.

### 5. Confirm prompts get a 5-minute auto-deny

Adjacent fix (audit finding #5): the registry now schedules a timer
when `registerPendingConfirm` is called and clears it on resolve /
clearTurnConfirms. Default 5 minutes, configurable via
`MARVIN_CONFIRM_TIMEOUT_MS` (`0` disables — used in tests). On
timeout, the registry resolves the pending promise with `deny` and
a "no user response" message. Closing the tab no longer hangs the
SDK loop.

### 6. First-run banner

The Empty-state hero renders a one-time banner explaining `auto`
mode when:

- `permissionStrategy === "auto"` (default), AND
- the user has never dismissed it (persisted as
  `marvin.autoModeBannerDismissed === "true"` in localStorage).

Click "got it" → dismiss persistently. **`reset()` does NOT clear
the dismissed flag** — the user has already learned the message;
re-explaining it on every reset is annoying.

## Consequences

### Good

- The hard-deny floor is now load-bearing in **both** `auto` and
  `gated` modes. The audit's finding #2 was that this was true on
  paper but false in practice; it's now true in code with test
  coverage.
- After-the-fact audits work. A user can review what MARVIN did
  yesterday by reading `<project>/.marvin/auto-audit.jsonl` (or the
  Settings UI surface that reads it).
- `Task` and `NotebookEdit` no longer slip the gate. ADR-0007 +
  ADR-0014 promised "subagents are bounded" — that promise is now
  enforceable. A contractor adding a new subagent type with no ADR
  registration gets a confirm prompt; the user can refuse.
- No more hung SDK loops on tab close (audit finding #5).
- The first-run banner makes the `auto` default an informed choice
  rather than a surprise.

### Acceptable

- The `autoModeLogger` adds one synchronous file-system call
  (append) per mutating tool use. The append is to a small JSONL
  file in the user's project; cost is negligible compared to the
  tool call itself (a Bash spawn or a Read-Edit-Write round-trip).
- The audit log grows unboundedly. Acceptable because (a) the file
  lives inside the project the user controls — they can rotate it
  with `mv` if it gets large, (b) the read-side hard caps the tail
  at 500 entries, (c) we don't read the whole file under normal
  operation.

### Bad / one-way doors

- The audit log file format is now part of MARVIN's public surface
  (the user could write a tail-watcher). Schema changes need a
  migration. Mitigation: the JSONL shape is intentionally narrow
  and keyed by the audit entry's `at` field; backward-compatible
  additions are easy, removals are not.
- `MARVIN_CONFIRM_TIMEOUT_MS` is a public env contract. Tests pass
  `0` to disable; users could set arbitrary values. The 5-minute
  default is a guess based on the audit author's intuition; if
  users complain it's too short the value is easy to bump.

### Not done

- The audit log doesn't roll over by date. If a user runs MARVIN
  for a year on the same project, the file will grow. We accept
  this for now; a follow-up ADR can introduce a rotation policy
  if the file becomes a problem.
- The audit log records auto-allowed calls but does not record
  hard-denied ones. Symmetry would be nice; deferred to keep this
  ADR focused.
- Non-Mutating tools (Read, Grep, Glob, WebFetch, WebSearch) are
  filtered out at the `appendAutoAuditEntry` layer. If we ever
  want a "MARVIN read these files" view, we'd need a separate log
  or extend the filter.

## Alternatives considered

**A. Keep `bypassPermissions` and add a separate audit hook.** The
SDK doesn't have a per-tool-call hook independent of the gate.
Either we install `canUseTool` (this ADR) or we observe `cli.event`
post-hoc and try to reconstruct what ran — fragile and racy.

**B. Make `gated` the default.** Considered and rejected. The user-
research signal (audit author + maintainer overlap) is that gated
mode interrupts flow enough that users in practice always switch
to auto. Defaulting to gated would push users back into the
"`--dangerously-skip-permissions` is fine, just don't tell anyone"
pattern, only via env var instead of UI toggle. Better to make
auto safe by default than to force the user to overcome friction
to reach it.

**C. Separate hard-deny floor + leave auto-mode bypassed.** Keeps
`bypassPermissions` for performance, runs only the deny regex set
in a pre-spawn hook. Was tempting until we realised the hook point
also gives us the audit log essentially for free. Doing both at
once is cheaper than two ADRs.

## References

- [Audit 2026-04-26 finding #2](../reviews/2026-04-26-full-audit.md)
- [Audit 2026-04-26 finding #3](../reviews/2026-04-26-full-audit.md)
- [Audit 2026-04-26 finding #5](../reviews/2026-04-26-full-audit.md)
- [`packages/tools/src/policy.ts`](../../packages/tools/src/policy.ts) — classifier + regex sets
- [`packages/tools/tests/policy.test.ts`](../../packages/tools/tests/policy.test.ts) — 26-case pin
- [`packages/runtime/src/sdk-runner.ts`](../../packages/runtime/src/sdk-runner.ts) — `canUseTool` + `autoModeLogger`
- [`packages/runtime/src/auto-audit.ts`](../../packages/runtime/src/auto-audit.ts) — log writer / reader
- [`packages/runtime/src/confirm-registry.ts`](../../packages/runtime/src/confirm-registry.ts) — timeout
- [`apps/web/src/app/api/audit/auto/route.ts`](../../apps/web/src/app/api/audit/auto/route.ts) — HTTP read surface
- [`apps/web/src/app/page.tsx`](../../apps/web/src/app/page.tsx) — first-run banner render
- [`apps/web/src/lib/use-prefs.tsx`](../../apps/web/src/lib/use-prefs.tsx) — banner-dismissed flag
