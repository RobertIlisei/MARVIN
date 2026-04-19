# Observability

What's instrumented today, what's planned, what's deliberately absent.

## What's instrumented today

### Per-turn logs on disk

Every turn writes to `~/.marvin/sessions/<projectId>/<marvinSessionId>.jsonl`. Every `cli.event` from the Agent SDK (assistant messages, tool calls, tool results) is captured verbatim. Plus `turn.user`, `turn.completed`, `turn.error`, and confirm lifecycle events when the gate fires.

This is the ground truth for "what did MARVIN do." Grep-able, replay-able, diff-able across sessions.

### Cost ledger

`~/.marvin/cost-tracker.json`. Append-on-turn. See [Cost tracking](./cost-tracking.md).

### UI state indicators

- **Brain state** — visible idle / thinking / tool / writing / error.
- **Status rail** — 1px animated hairline under the header; speed tracks MARVIN's current state.
- **Cost pill** — header, live.
- **Branch badge** — active project's git branch + dirty-count dot.
- **Model row in brain side panel** — live executor + advisor.

### Server-side stderr

Next.js dev server logs unhandled exceptions, Turbopack messages, SDK runtime errors. Shows up in the terminal running `pnpm dev`.

## What's deliberately absent

- **No analytics or telemetry.** Zero external calls besides Anthropic API. No "anonymous usage stats," no "crash reports." See [Data flow](../security/data-flow.md).
- **No log aggregation.** MARVIN doesn't ship logs anywhere. If you want long-horizon analysis, point your own tooling at `~/.marvin/sessions/`.
- **No per-request tracing.** Next.js dev mode is sufficient for debugging one user's local sessions. Distributed tracing would be overkill for a single-user local tool.

## What's planned (Phase 5 stretch, deferred)

**Honeycomb MCP integration for observability** — from PLAN.md:

> Phase 5 #2 (Honeycomb MCP) remains explicitly deferred until team setup is available.

The idea: register a `marvin-honeycomb` MCP server alongside `marvin-graph` and `marvin-playwright`. The executor could then query real production traces while debugging ("what's the P99 latency on /api/search since yesterday?") without leaving the conversation.

Blockers:

- Requires a Honeycomb account + API key. Per-user config surface that doesn't exist yet.
- Team-specific conventions (dataset names, fields) need configuration. Violates [isolation contract](../concepts/isolation-contract.md) if baked into MARVIN; belongs in `<workDir>/.marvin/` config.
- The `honeycomb-honeycomb-investigator` agent in the skills bundle is a useful reference for the shape, but it's a Claude Code plugin, not an MCP server.

No shipping ETA. Opens up if and when a user has a Honeycomb environment and wants to be the first to try.

## Debugging a turn

"MARVIN did something weird. How do I figure out why?"

1. **Read the JSONL.** `tail ~/.marvin/sessions/<projectId>/<marvinSessionId>.jsonl` shows the most recent events. Look for the `cli.event` entries around the point of weirdness.
2. **Check the tool policy verdict.** If a tool call was blocked or confirmed, the `confirm.request` event (when gated) or policy classification (in the `cli.event` metadata) shows why.
3. **Check cost ledger.** If the session's cost seems off, `cost-tracker.json` has per-turn breakdown.
4. **Check `/api/health`.** `ok: false` means the runtime state is wrong (no credentials, binary missing). Fix that before looking at higher-layer issues.
5. **Browser devtools** for client-side issues (hydration mismatches, `useChatStream` events not firing).
6. **Server stderr** for SDK-layer exceptions.

## Logging verbosity

No verbosity levels. Everything the SDK emits is captured in `cli.event`. Everything the server logs to stderr is whatever Next.js + the SDK chose to log. If you need quieter logs, grep; if you need louder ones, set `DEBUG=*` before `pnpm dev` (inherits into the Next.js process and the SDK's debug namespaces).

## Related

- [Sessions](./sessions.md) — what the JSONL transcript looks like.
- [Cost tracking](./cost-tracking.md)
- [Health checks](./health.md)
- [Data flow](../security/data-flow.md)
