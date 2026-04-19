# ADR-0004 — Structural confirm gate via Agent SDK

**Status:** Accepted
**Date:** 2026-04-17 (Phase 2+3 closeout)
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN's original runtime spawned the Claude CLI as a child process: `claude -p --dangerously-skip-permissions --output-format stream-json`. This was the fastest path to a working chat stream, but the `--dangerously-skip-permissions` flag is what it says on the tin — every tool call runs unattended.

Shipping an end-user pair-programming tool with no way to review an Edit before it lands was a non-starter for:

- Any session working in sensitive code (auth, billing, migrations).
- Users who wanted the Claude Code confirm experience but in a browser.
- The "I can catch MARVIN taking a wrong turn" contract in [ADR-0001](./0001-single-assistant.md).

The CLI exposes a `--permission-mode` flag, but the granularity was limited — it's an all-or-nothing pre-flight, not a per-tool gate that can distinguish auto-allow / confirm / hard-deny. And it couldn't pause mid-turn waiting for a browser user to click allow.

Anthropic's Agent SDK exposes a programmatic `query()` function with a `canUseTool` callback: a per-tool-call hook that can return `{ behavior: "allow" | "deny", message?: string }` async. This is exactly the shape MARVIN needed.

## Decision

**Migrate MARVIN's runtime from the raw CLI spawn to `@anthropic-ai/claude-agent-sdk`'s `query()`**, and implement the confirm gate as a `canUseTool` callback.

Implementation:

- [`packages/runtime/src/sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts) owns the `runAgent()` entrypoint. It calls `query({ canUseTool, ... })` with the callback installed.
- [`packages/runtime/src/confirm-registry.ts`](../../../packages/runtime/src/confirm-registry.ts) holds an in-process map from `(turnId, toolUseId)` → pending promise resolver. When `canUseTool` fires and the policy returns `confirm`, we register a resolver and emit a `confirm.request` SSE event to the browser.
- `/api/confirm` (POST) accepts `{ turnId, toolCallId, decision, denyMessage? }`, looks up the resolver, and resolves the promise — which unblocks the SDK's waiting `canUseTool`.
- The browser renders an inline `<ConfirmPrompt>` in the tool-call card. For `Edit` / `Write` it shows a Monaco diff; for `Bash` it shows a `$ <command>` block.

The **auto vs gated** mode ([see confirm-gate.md](../concepts/confirm-gate.md)) is implemented as two code paths:

- **Auto**: SDK runs with `permissionMode: "bypassPermissions"`, no `canUseTool` callback. Everything runs.
- **Gated**: `canUseTool` installed. Policy decides auto-allow / confirm / hard-deny.

Hard-deny patterns are enforced in both modes — they short-circuit the callback and return `{ behavior: "deny", message }` without emitting a `confirm.request` event.

## Consequences

**Positive:**

- The gate is **structural**, not advisory. The Agent SDK cannot execute the tool until the promise resolves. There is no race window where the tool runs before the browser can say no.
- Per-tool granularity. Reads auto-allow, Edits confirm, `rm -rf` hard-denies — in a single pass, no flag juggling.
- Hard-deny list is enforced even in `auto` mode. "Dangerously skip permissions" becomes "skip permissions *except the obviously-destructive ones*" which is the right default for a dev tool.
- Async-friendly. Browser can disconnect and reconnect; the promise stays parked in `confirm-registry` until resolved or aborted.
- Composes with MARVIN's existing SSE turn stream — the confirm flow is just another event type on the same stream.

**Negative:**

- Heavier runtime dependency. `@anthropic-ai/claude-agent-sdk` is a bigger surface than the CLI binary. Must stay current with SDK releases.
- Slightly more state to manage. The confirm registry adds a new source of in-flight state that has to be cleaned up on abort / timeout / server restart.
- Debugging shifted — stack traces now pass through the SDK's internals rather than a clean child-process boundary. Mitigated by: SDK throws typed errors, which get surfaced via `turn.error` SSE events.
- Locked in to the SDK's tool-use shape. If Anthropic evolves the SDK in a breaking way, MARVIN's runtime needs to move with it.

## Alternatives considered

### Keep the CLI spawn, add a pre-flight filter on the client

*What it is:* The CLI still runs `--dangerously-skip-permissions`, but the browser previews each tool call before relaying it.

*Why plausible:* Simplest diff from the original runtime.

*Why rejected:* Not structural. The CLI *already ran* the tool by the time the client sees it in the stream. At best the client could hide the result; the side effect on disk has happened.

### Keep the CLI spawn, use `--permission-mode ask`

*What it is:* Use the CLI's native per-tool ask mode.

*Why plausible:* No SDK dependency.

*Why rejected:*

- Ask mode in the CLI is designed for a human at a terminal, not a browser with an SSE round-trip. Blocking on stdin doesn't translate cleanly.
- Limited policy granularity. We wanted auto-allow for `Read`/`Grep`/etc. and hard-deny for `rm -rf`, not a uniform "prompt for everything."

### Fork the CLI to expose the gate

*What it is:* Fork `@anthropic-ai/claude-code` and add a custom permission handler.

*Why plausible:* Full control over the flow.

*Why rejected:* The Agent SDK already exposes this via `canUseTool`. Forking would duplicate the maintenance burden and diverge us from upstream.

### Run tools ourselves; use the CLI only for the model call

*What it is:* Intercept tool-use requests, execute them in MARVIN's own code.

*Why plausible:* Maximum control.

*Why rejected:* The SDK's built-in tool implementations (Edit, Read, Write, Grep, etc.) are battle-tested and get updates. Re-implementing them would cost weeks and introduce subtle divergences.

## Verification

- SSE trace from a gated turn: `turn.started` → `cli.event`(tool_use) → `confirm.request` → (wait) → POST `/api/confirm` → `cli.event`(tool_result) → `turn.completed`.
- Manual hard-deny test: `rm -rf /tmp/test` triggers the pattern, `canUseTool` returns deny without emitting `confirm.request`, the SDK's tool_result records the denial, MARVIN's next response acknowledges it and finds an alternative path.
- Browser disconnect mid-confirm: user can reopen the tab, the `<ConfirmPrompt>` still renders (because the JSONL transcript replay re-creates it), and clicking allow/deny still resolves the original pending promise via `confirm-registry`.

See PLAN.md's "2026-04-17 (pre-dawn — Phase 2 + 3 closeout)" changelog entry for the shipping details.

## Related

- [Confirm gate — narrative](../concepts/confirm-gate.md)
- [Tool policy reference](../security/tool-policy.md)
- [`sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts)
- [`confirm-registry.ts`](../../../packages/runtime/src/confirm-registry.ts)
- [`@anthropic-ai/claude-agent-sdk` docs](https://docs.claude.com/en/api/agent-sdk/overview)
