# ADR-0117 — An in-process MCP server is trusted by the SDK's word, not by its name

- **Status:** Accepted — implemented 2026-09-21
- **Date:** 2026-09-21
- **Related:** [ADR-0053](./0053-plugins-as-local-plugin-loader.md) (plugin MCP tools confirm by default), [ADR-0045](./0045-playwright-mcp-gated.md) (the Playwright ladder), [ADR-0089](./0089-obsidian-trust-with-a-consent-exception.md) (a trusted server can still hold a tool that confirms), [ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md) (the subagent read-only invariant), [ADR-0073](./0073-agent-sdk-0-3-upgrade.md) (the 0.3.278 addendum that surfaced the field)

## Context

`mcpToolPolicy` blanket-allows MARVIN's five in-process servers —
`marvin-graph`, `-memory`, `-backlog`, `-control`, `-obsidian` — by matching
the tool name prefix `mcp__marvin-*__`. Everything else under `mcp__*` goes
through a ladder: Playwright's, or `confirm` for any unknown server (ADR-0053).

The name is a convention. It holds because of how MARVIN is configured today,
not because anything guarantees it: a tool name is `mcp__<server key>__<tool>`,
and the key is whatever the configuration that defined the server chose.

Agent SDK 0.3.278 gives `canUseTool` a second field for MCP calls:
`mcpServer: { name, source }`. `source` says where the server's definition
came from — `sdk` for an in-process server the host registered, otherwise a
configuration scope (`plugin`, `user`, `project`, `local`, `dynamic`,
`managed`, …). The SDK's own documentation: *"only the host can register one,
so a configured server of the same name never reads `sdk`. Key trust on
`source`, not on the name or the tool-name prefix."* Verified live on a real
turn: a call to MARVIN's graph server arrives as
`{ name: "marvin-graph", source: "sdk" }`.

**What this is not.** It does not close a hole anyone can reach today. MARVIN
runs the SDK without `settingSources`, so no `.mcp.json` or settings-file
server loads, and a plugin's MCP tools are namespaced `mcp__plugin_<plugin>_…`
by the CLI, so a plugin cannot mint an `mcp__marvin-graph__` name. The value is
that the allow no longer depends on either of those staying true.

## Decision

1. `mcpToolPolicy(name, provenance?)` keeps the blanket allow (`null`) for a
   MARVIN-prefixed tool unless the SDK reports **a source other than `sdk`**;
   then it returns `confirm`. `source` is an open set: an unknown value is
   untrusted, never read as `sdk`.
2. **Missing provenance keeps the name-based allow — deliberately not
   fail-closed.** The main loop's calls carry the field (verified live). A
   subagent's could not be shown to: a probe dispatching a subagent that
   called an in-process tool never reached `canUseTool` at all, so the field's
   presence on that path is unobserved. Subagents made 382 MARVIN-MCP calls
   through the gate in the sidecar log (302 of them `graph_search`), and the
   subagent invariant turns a `confirm` into a deny — failing closed would
   have hard-denied every scout's graph tools on a guess. Every missing
   provenance on a MARVIN name logs `gate.mcp_provenance_missing` with its
   `agentID`, so the log will say whether the fallback is ever used; when it
   has shown none, tighten this to fail closed.
3. Both `canUseTool` closures pass `mcpServer` through `classifyToolCall`. A
   refused twin logs `gate.mcp_provenance` telemetry and gets its own reason
   string naming the reported source.
4. Unchanged: the Playwright ladder (keyed on name — MARVIN configures that
   server itself, and its tools confirm or deny on their own merits), the
   plugin default of `confirm`, `obsidian_init`'s confirm, and the subagent
   invariant, which turns any `confirm` from an `agentID` call into a deny.

## Consequences

- The allow rests on a fact only the host can make true instead of on a
  naming convention plus two configuration choices.
- If a future CLI stopped sending `mcpServer`, nothing breaks and the
  `gate.mcp_provenance_missing` count rises — the protection degrades to what
  it was before this ADR, visibly, rather than taking scouts down.
- The protection is only as strong as the reported source: a spoofed name
  that also arrived *without* provenance would still be allowed. That is the
  gap point 2 leaves open until the log shows the field is always present.
- The policy now has a second input. Every existing test that exercised a
  MARVIN tool passes the provenance the live SDK sends.

## Scope of Done

- [x] `mcpToolPolicy` keys the in-process allow on `source === "sdk"`;
      `isTrustedMcpName` and `McpProvenance` exported from `@marvin/tools/policy`
- [x] `classifyToolCall` takes `mcpServer`; both `canUseTool` closures pass it
- [x] Tests: sdk source allows; seven non-sdk sources confirm; missing
      provenance allows (main loop and subagent); a plugin-sourced MARVIN
      name from a subagent is denied; Playwright and plugin ladders unchanged
- [x] Live: `mcpServer` observed on a real 0.3.278 main-loop turn before the
      gate depended on it
- [ ] Not done: the field's presence on subagent calls — read it off
      `gate.mcp_provenance_missing` after real sessions, then decide on
      fail-closed
