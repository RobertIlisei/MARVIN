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

## Honeycomb telemetry (UI-configurable)

MARVIN ships a per-project **Honeycomb config surface** so the executor can query production traces while debugging without leaving the conversation — once you've wired your credentials through the UI.

### Configure in the UI

1. Click the **`honeycomb`** row in the brain side panel (right column). Opens the `HoneycombConfigDialog`.
2. Paste your Honeycomb API key. Set the environment name (typically `prod`) and optionally a default dataset.
3. Click **Test connection** to verify — MARVIN's `/api/honeycomb/test` route hits Honeycomb's `/1/auth` endpoint server-side and surfaces the team slug + environment name.
4. **Save.** The config lands at `<workDir>/.marvin/honeycomb.json` with `0600` permissions. The UI only ever sees a masked form (`hcbik_…abcd`) after the first save.

### Storage precedence

`packages/runtime/src/honeycomb-config.ts` resolves the active config in this order:

1. `HONEYCOMB_API_KEY` + `HONEYCOMB_ENVIRONMENT` env vars (plus optional `HONEYCOMB_DATASET`, `HONEYCOMB_API_URL`) — useful for CI.
2. `<workDir>/.marvin/honeycomb.json` — per-project, set via the UI.
3. `~/.marvin/honeycomb.json` — user-global fallback.

Env vars beat files; workdir beats global.

### Security invariants

- Raw API key only travels in a single `POST /api/honeycomb/config` body. Every `GET /api/honeycomb/config` returns `apiKeyMasked`, never the full key.
- File permissions are set to `0600` on write.
- `apiUrl` is validated against `https://*.honeycomb.io` — a misconfigured URL can't exfiltrate the key to an attacker-controlled host.
- The `/api/honeycomb/test` route makes the Honeycomb call server-side; the browser never sees the raw key.
- `.marvin/` is MARVIN's convention for gitignored project-local state. Don't commit that directory.

### What's *next* (not in v1)

- **`marvin-honeycomb` MCP server registration** — wire `packages/runtime/src/sdk-runner.ts` to spawn the Honeycomb MCP server when a config is present. Tools: `list_datasets`, `run_query`, `get_trace`, etc. Follow-up PR — the config surface lands first so you can pin credentials before the MCP tries to use them.
- **Skill wiring** — the `honeycomb-*` skills in `.claude/skills/` expect specific MCP tool names; the MCP PR aligns those.

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
