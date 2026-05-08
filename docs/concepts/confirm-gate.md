# Confirm-before-act gate — auto vs gated

MARVIN ships with a structural gate around every tool call. The gate itself is a function the Agent SDK invokes *before* executing a tool — it's not a modal, not a prompt, not a wrapper around an already-running command. The tool doesn't run unless the gate says yes.

## The two modes

### Auto (default)

Matches `claude --dangerously-skip-permissions`. The Agent SDK runs with `permissionMode: "bypassPermissions"`, no `canUseTool` callback installed. Every tool call executes immediately.

Best for experienced users who want uninterrupted flow. This is how MARVIN is designed to feel at steady state.

### Gated

The pre-flight `canUseTool` callback is installed. Every tool call is classified by [`toolPolicy()`](../../sidecar/packages/tools/src/policy.ts) into one of three outcomes:

| Outcome | Behavior | Examples |
|---|---|---|
| **auto-allow** | Executes immediately. No confirm card. | `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, and whitelisted safe `Bash` (`git status`, `npm run …`, `pnpm typecheck`, etc.) |
| **confirm** | Renders an inline confirm card in the tool-call block. MARVIN pauses until you click allow or deny. | `Edit`, `Write`, non-whitelisted `Bash` |
| **hard-deny** | Blocks without even asking. MARVIN gets `{ behavior: "deny", message }` back from the SDK. | `rm -rf /`, `git push --force` to main, anything touching `.env` without explicit intent |

## Toggling

The **perms** pill in the header (`auto` / `gated`) flips between the two modes. Persists across reloads via `localStorage.marvin.permissionStrategy`.

Server-side, `/api/chat` accepts a `permissionStrategy: "auto" | "gated"` in the body. Default if omitted: `auto`.

## How the gate actually works

```
browser                    Next.js                  Agent SDK
   │                          │                         │
   │  POST /api/chat           │                         │
   │  perms=gated, msg="…"    │                         │
   ├─────────────────────────▶│                         │
   │                          │  runAgent({ canUseTool })
   │                          ├────────────────────────▶│
   │                          │                         │  … Claude wants to call Edit(…)
   │                          │                         │
   │                          │   canUseTool called ────┤
   │                          │◀────────────────────────┤
   │  confirm.request (SSE)   │  policy = "confirm"     │
   │◀─────────────────────────┤  → emit SSE event       │
   │  render <ConfirmPrompt/>│                          │
   │                          │   … waits …            │
   │  POST /api/confirm       │                          │
   │  { allow }               │                          │
   ├─────────────────────────▶│                          │
   │                          │  resolve(allow)         │
   │                          ├────────────────────────▶│
   │                          │                         │  Edit executes
   │                          │                         │  tool_result flows back
   │  cli.event (SSE)         │                         │
   │◀─────────────────────────┤                         │
```

Key pieces:

- [`canUseTool` callback in `sdk-runner.ts`](../../sidecar/packages/runtime/src/sdk-runner.ts) — the SDK invokes this before running each tool. Returns `{ behavior: "allow" | "deny" }`.
- [`confirm-registry.ts`](../../sidecar/packages/runtime/src/confirm-registry.ts) — in-process map keyed by `(turnId, toolUseId)` that holds the pending promise resolver.
- `/api/confirm` — POST endpoint the client calls after the user clicks allow/deny; looks up the resolver and resolves the promise.
- `confirm.request` SSE event — sent to the client with the policy's reason + tool input so the `<ConfirmPrompt>` component can render a diff (for Edit/Write) or a command block (for Bash).

This is a **structural** gate. The Agent SDK cannot execute the tool until the promise resolves. If the browser disconnects, the turn suspends until it reconnects (see [Session persistence](../operations/sessions.md)), or until the per-turn abort fires.

## What "whitelisted Bash" means

[`toolPolicy()`](../../sidecar/packages/tools/src/policy.ts) checks the `command` field against a regex list of known-safe patterns:

- Read-only git: `git status`, `git log`, `git diff`, `git show`, `git rev-parse …`
- Read-only filesystem: `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `file`
- Package manager inspection: `npm ls`, `pnpm list`, `yarn list`
- Build + test in the workspace: `npm run …`, `pnpm …`, `yarn …` (excluding `publish` / `push`)
- Typecheck + lint: `tsc`, `pnpm typecheck`, `eslint`, `biome check`
- Process inspection: `ps`, `lsof -i`, `netstat`

Anything else falls through to `confirm`. See [Tool policy](../security/tool-policy.md) for the full table.

## Hard-deny patterns

Non-negotiable. Even in `auto` mode, these never run:

- `rm -rf /` and variants targeting root or home
- `git push --force` to a protected branch (main, master, production)
- `git config --global` (writes to user's global config — scope violation)
- `curl … | sh` (arbitrary code execution)
- Anything reading/writing `.env*` files without explicit user intent in the message
- `dd of=/dev/…` and other disk-level destructive commands

The list lives in [`sidecar/packages/tools/src/policy.ts`](../../sidecar/packages/tools/src/policy.ts) as `HARD_DENY_PATTERNS`. Adding a pattern requires a decision — don't tune it silently.

## When to prefer which mode

**Auto** when:
- You trust the current conversation.
- You're doing exploratory or mechanical work (refactors, renames, adding tests).
- You want to eyeball the diff *in the chat stream* rather than at gate time (the diff viewer shows up in the tool-call card either way, just without the pause).

**Gated** when:
- MARVIN is working in sensitive code (auth, billing, migrations).
- You're about to do something you haven't validated with a plan first.
- You're running MARVIN unattended and want to be safe about it.

## Related

- [ADR-0004 — structural confirm gate via Agent SDK migration](../decisions/0004-structural-confirm-gate.md) — why we moved from the CLI to the Agent SDK.
- [Tool policy reference](../security/tool-policy.md) — the full auto / confirm / deny matrix.
- [`sdk-runner.ts`](../../sidecar/packages/runtime/src/sdk-runner.ts) — the gate implementation.
- [`sidecar/packages/tools/src/policy.ts`](../../sidecar/packages/tools/src/policy.ts) — the classification regexes.
