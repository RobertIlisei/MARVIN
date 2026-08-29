# ADR-0073 — Agent SDK 0.2.113 → 0.3.245, behaviour-neutral by construction

- **Status:** Accepted
- **Date:** 2026-08-25
- **Related:** [ADR-0068](./0068-plan-dedupe-provenance-and-negative-claims.md) addendum 4 (the plan bug that surfaced this),
  [ADR-0049](./0049-plan-step-join-key-and-rollup.md) (the `[N]` tag contract this preserves),
  [ADR-0055](./0055-checkback-promise-auto-arm-guard.md) (why `marvin-control` must never be deferred)

## Context

Investigating a corrupted plan (ADR-0068 add. 4) led to the official Agent SDK
docs, which said `TodoWrite` — the tool MARVIN's entire plan spine reconciles
against — is deprecated and, on the models MARVIN runs, **absent by default**:

> On TypeScript Agent SDK 0.3.233 and later … the following tools aren't
> available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5 … unless you opt in:
> `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`.

MARVIN was on **0.2.113** — behind the end of the 0.2 line (0.2.141), 92
releases into 0.3, and predating `TodoWrite`'s own deprecation notice
(0.2.136). Every Sonnet 5 session was on the legacy contract by accident.

## What changes between 0.2.113 and 0.3.245 — checked against MARVIN's code

| Change (version) | Effect on MARVIN | Action |
|---|---|---|
| Task tools replace `TodoWrite` on Opus 4.8+/Sonnet 5+ (0.3.142) | Plan spine (ADR-0046/0049/0052/0068) receives nothing; every plan freezes at `pending` | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` + `CLAUDE_CODE_ENABLE_TASKS=0` in `turnEnv` — opt the family in, select the snapshot tool |
| MCP tools **deferred behind ToolSearch** unless `alwaysLoad` (0.3) | `graph_*` absent from the turn-1 prompt; design hooks hard-deny Read/Grep/Glob until a graph call → graphify-first deadlocks the turn. `schedule_wakeup` behind a discovery step = an unarmed promise (ADR-0055) | `alwaysLoad: true` on all five in-process servers |
| MCP servers connect in the background (0.2.142) | Turn could start before `marvin-graph` registers | `alwaysLoad` also blocks startup until connected (documented side effect) |
| `options.env` replaces the subprocess env (0.3) | Would strip PATH/auth from the CLI | Already safe: both `env:` sites spread `process.env` |
| `canUseTool` returns `PermissionResult \| null`; context gains required `requestId` | Production gates never return null — type-only; tests needed `must()` + `requestId` | Test file updated |
| Subagent depth cap 5 → 1 (0.3.217) | Advisor / scout / plugin agents spawn from the main session — fine | Watch: dynamic workflows (ADR-0030) if a stage ever spawns from a subagent |
| v2 session API removed (0.3.142) | Not used — `query()` + `resume` throughout | None |
| Peer `@anthropic-ai/sdk` ≥ 0.93 | Was 0.80/0.81; only `refresh-docs.ts` imports it | Bumped to 0.120 |
| `graphify-bridge` pinned its own `^0.2.113` | Two SDK copies in one process — `createSdkMcpServer` from one, `query` from the other | Aligned to 0.3.245 |

> **Correction (2026-08-29, [ADR-0079](./0079-subagent-tool-rename-and-rails.md)):**
> the subagent-tool half of the paragraph below is **wrong**. It was read off
> `system/init`, which still advertises the old name. The `tool_use` blocks the
> gate actually sees carry `Agent` — Claude Code renamed the tool in v2.1.63,
> and five of MARVIN's guards silently stopped matching. The `TodoWrite` half
> stands. Verify a tool-name contract against a `tool_use` block from a real
> transcript, never against `system/init`.

**Verified live**, not inferred: a 0.3.245 session on `claude-sonnet-5` with the
two env flags reports **113 tools, subagent tool `Task`, todo family
`TodoWrite` only** — the wire name MARVIN's gate matches on
(`sdk-runner.ts` / `policy.ts`) is unchanged, and the plan spine gets exactly
the tool it expects.

## Decision

Upgrade now, **behaviour-neutral by construction**: every 0.3 default that
would change what MARVIN does is pinned back to the 0.2 behaviour explicitly,
with the reason at each pin. Nothing in the plan spine, the gate, or the MCP
surface changes semantics in this ADR.

Explicitly **not** done here: migrating the plan spine from `TodoWrite`
snapshots to id-based `TaskCreate`/`TaskUpdate`. That is the change that
retires the ADR-0068 bug class (server-assigned ids are the stable join key
`[N]` tags synthesise), and it is worth its own ADR precisely because it is
*not* neutral. Doing it in the same change as a two-minor-version upgrade
would make any regression unattributable.

## Scope of Done

- [x] `@anthropic-ai/claude-agent-sdk` 0.3.245 in all three workspace packages; `@anthropic-ai/sdk` 0.120.
- [x] `TodoWrite` opted back in via env; five in-process servers `alwaysLoad`.
- [x] Live `system/init` probe: `Task` + `TodoWrite` present on Sonnet 5.
- [x] 8/8 typecheck, 782 tests, 257 Swift assertions.

## Consequences

**Two env flags now define MARVIN's task-tracking contract.** Remove either and
the plan spine goes silent without an error. They are set in `turnEnv` with a
comment pointing here; the Task-id migration ADR should delete them.

**`alwaysLoad` costs prompt tokens.** Five servers' tool schemas are in every
turn-1 prompt rather than behind ToolSearch. That is the pre-0.3 state, so no
regression — but it is now a choice, and per-server `alwaysLoad` can be
relaxed for `marvin-obsidian` if context pressure ever warrants it.

**Free wins left on the table**, deliberately: `tool_result_meta.non_execution_kind`
(0.3.216) could replace text-parsing in the confirm gate; `system/permission_denied`
events (0.3.162) surface auto-denials MARVIN currently drops. Both are
improvements, not neutrality, so they wait.
