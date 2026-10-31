# MCP servers

MARVIN registers two in-process MCP servers on every turn. Both are mounted by [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) via the Agent SDK's `mcpServers` option. Both are transparent to the user — tool calls against them appear in the chat stream as `mcp__<server>__<tool>`.

## `marvin-graph`

In-process stdio MCP server that exposes the active project's knowledge graph. Backed by [`sidecar/packages/graphify-bridge/src/mcp-server.ts`](../../../sidecar/packages/graphify-bridge/src/mcp-server.ts). Reads `<cwd>/graphify-out/graph.json` lazily on first tool call.

### Tools

#### `graph_summary`

Overview of the graph. No arguments.

**Returns:**

```ts
{
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  godNodes: Array<{ label: string; degree: number; sourceFile: string | null }>;
  topCommunities: Array<{ id: number; label: string; size: number; cohesion: number }>;
}
```

Use case: first-turn orientation. "What's in this codebase?"

#### `graph_search`

Fuzzy-search nodes by label.

**Arguments:** `{ query: string, limit?: number = 10 }`

**Returns:** `Array<{ id, label, sourceFile, sourceLocation, score }>`

Use case: "find anything related to `authentication`."

#### `graph_neighbors`

1-hop and 2-hop neighbors of a named node.

**Arguments:** `{ query: string, hops?: 1 | 2 = 1 }`

**Returns:**

```ts
{
  center: { id, label, sourceFile };
  neighbors: Array<{
    id, label, sourceFile,
    relation: string;           // "calls", "imports", etc.
    confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
    hops: 1 | 2;
  }>;
}
```

Use case: blast-radius enumeration in the impact-analysis phase.

#### `graph_path`

Shortest path between two nodes (undirected BFS within one graph).

**Arguments:** `{ from: string, to: string, relations?: string[], scope? }` — `relations` restricts the walk to those edge relations, e.g. `["calls", "imports", "imports_from", "method", "contains"]` for a path code actually takes; without it BFS may thread through a `references` string mention.

**Returns:** `Array<{ id, label, relation, confidence, sourceFile }>` — the chain, head to tail. Each hop carries the relation of the edge it *leaves* by (the last has none) and its file, so the path reads as a touchpoint list.

Use cases: "how does the chat input reach the Agent SDK?" — surface the intermediate hops. And Phase 5 planning (2026-09-07): the structural path from the entry symbol a change touches to the persistence symbol it reaches is milestone 1's touchpoint list — the tracer bullet through every layer.

### Notes

- If `<cwd>/graphify-out/graph.json` doesn't exist, every tool returns an empty result with a hint: "no graph found — run `/graphify .` in this project's root."
- The server is **per-turn**: a fresh instance is created every time `runAgent()` runs. It picks up graph updates between turns automatically.
- Graph queries write Q&A back into the graph on disk so future queries can cite them. See [Graphify — feedback loop](../concepts/graphify-integration.md).

## `marvin-supervise` (the supervisor session only)

The supervisor's only acting surface ([ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md)). Built by [`supervisor-mcp.ts`](../../../sidecar/packages/runtime/src/supervisor-mcp.ts) and mounted by [`supervisor-dispatch.ts`](../../../sidecar/packages/runtime/src/supervisor-dispatch.ts) in the supervisor's own SDK session — **never** in an executor turn: `sdk-runner.ts` does not register it, and `mcpToolPolicy` denies `mcp__marvin-supervise__*` in every turn it classifies. Inside the supervisor session it is admitted only when the SDK reports the in-process server (`mcpServer.source === "sdk"`, ADR-0117). `alwaysLoad: true`, because the supervisor's closed tool set has no `ToolSearch`.

Tools. In shadow mode nothing is performed. From milestone 4 a verb **performs** once the user switches its category to autonomous (`POST /api/supervisor` `autonomy`): `answer` (questions), `send` and `cancel` (nudges), `set_posture` (posture, narrowing only), and from milestone 5 `confirm` (confirms — the gated strategy's ordinary card only, in an `answer-confirms` tab). Every **escalation** becomes an item in the user's inbox (`GET /api/supervisor/inbox`) that shows the raw act — tool, input, digest, a server-built summary — with the supervisor's recommendation beside it; the line and the item name each other (`inboxItemId` / `ledgerId`). The performing services are injected (`VerbDeps.perform`), so `supervisor-mcp.ts` still imports nothing that resolves a confirm, starts a turn or changes a posture. An act's ledger line is named before it is performed, so the transcript can cite it; a perform that fails is ledgered as a refusal.

| Tool | What it does |
|---|---|
| `sessions` | The tabs the user delegated, with their pending questions and confirms (each with its raising rule), plan progress and last turn. Supervisor sessions are never listed. From milestone 7.2 an open tab the user did not delegate is listed as `{ marvinSessionId, title, delegation: "off" }` and nothing more (ADR-0128 §4), so a reply can say it is not delegated. |
| *grounds* | Milestone 7.1 adds `message:<id>#<quote>` (ADR-0128 §2): the quote (≥ 12 characters, two words) must appear verbatim in a message the **user** wrote; a reply never resolves. **Strong** only in the wake that message started, **weak** in any other. A message arriving mid-wake turns every later act in that wake into an escalation (`reasonCode: "message-hold"`). |
| `read` | One delegated tab's pending question, transcript tail, plan, or the supervisor's ledger for it. Tab content is wrapped as untrusted data. |
| `answer` | An answer to a pending `AskUserQuestion` (chosen labels / "Other" text) with `grounds`, or an `escalate`. Evaluated by the policy (delegation, grounds with provenance, the question heuristic, rate limits, the per-wake breaker, and — milestone 3 — a secret-shaped "Other" text) and ledgered with the target and the proposed labels, for pairing. Autonomous: answered through `answerQuestion` with `answeredBy: "supervisor"` — the transcript records the grounds and ledger id, the tab's model reads each value marked as the supervisor's, and the turn becomes supervisor-touched. A heuristic-flagged, ungrounded or weak-only question is never answered. |
| `set_posture` | Milestone 2. A proposed change to a tab's posture with `grounds`. A narrowing is a proposal; any widening — Plan → Agent included — escalates. Needs `answer-questions` delegation. Autonomous: applied through the posture service as `actor: "supervisor"` (which re-checks the direction against the stored posture). In shadow mode nothing changes. |
| `send` | Milestone 3. A proposed `nudge` or `instruction` to a tab, with `grounds`. Needs `answer-questions`. Refused for a tab the user stopped, one waiting on its own job or wakeup, a shared-checkout tab while another session works there, and secret-shaped text; a third nudge at one plan step without spine progress escalates (counted from the ledger's `planSignature`). Refused for a tab whose scope is met (`scopeMetAt`, milestone 4). Autonomous: sent through `sendAsSupervisor`. In shadow mode nothing is sent. |
| `cancel` | Milestone 3. A proposed cancel of a tab's running turn, with a `reason` and `grounds`. Needs `answer-questions` and a live turn. Autonomous: the turn is cancelled. In shadow mode nothing is cancelled. |
| `confirm` | Milestone 3. A proposed allow / deny on an ordinary permission confirm, with `grounds`. Needs `answer-confirms`. A confirm in a supervisor-touched turn is refused (only the user answers it, ADR-0127 §5); a containment or money confirm, one whose act is on the §4 list, or one any rule other than `gated` raised, escalates; a question belongs to `answer`. Autonomous (milestone 5): resolved through `resolveConfirm` with `answeredBy: "supervisor"` and the original input — the turn becomes supervisor-touched (`by: "confirm"`). In shadow mode nothing is answered. |
| `worktrees` | Milestone 5. `list` and `preview` (a `git merge-tree` dry run against the current branch) read live. `sweep` is **performed** in shadow too: it reclaims exactly what `worktree_sweep` does — empty or merged, clean, never an open tab's `session` tree — which is not discarding (§4 item 3) and what every tab close already does. `merge`, `merge-all`, `prepare-mr` and `drop` always escalate, with the preview on the item; an open tab's own tree is refused. |
| `close_session` | Milestone 5. A proposed close of a delegated, idle tab — `keep`, `merge` or `discard` — always escalated. A `keep` of a scope-met tab is keyed on its `scopeMetAt`, so it is raised once per close. |
| `review_scope` | Milestone 5. The answer to the scope-met wake (§2 trigger 4): `ready` proposes closing the tab with its branch kept; `missing` proposes sending the tab what is missing. Both escalate — reopening scope is the user's (§4 item 6). Refused for a tab with no scope-met claim. |
| `new_session` | Milestone 5 (§4 item 7). Proposes ONE tab, only on a user request: `requestId` must be the id of a message the user wrote to the supervisor (`POST /api/supervisor/message`), unused by another open or opened proposal. A `tree` other than `worktree` is refused. The item shows the first message, the base ref and sha, the posture and which dimensions are wider than the user's latest tab; the verb never opens a tab. Milestone 7.3: the tab is followed for the user — `follow: "merge-ready"` only when they asked for the merge too (otherwise `scope-met`) — and the item carries the delegation it gets on the accept (`answer-questions`, lowerable on the card). For a `merge-ready` follow, `review_scope` `ready` also raises the `worktrees merge` card for the tab's branch with the follow's origin; for `scope-met` it ends the follow. |
| `reply` | Milestone 5. The supervisor's answer in its conversation with the user. Authorises nothing; a secret-shaped reply is refused. From milestone 7.1 (ADR-0128 §5) it exists only in a wake a user message started: anywhere else it is refused (`reasonCode: "no-conversation"`) and nothing reaches the conversation. A reply is ledgered (`kind: "message"`, `verb: "reply"`) and stored with its `wakeId` and `origin`. Milestone 7.2: `items` (≤ 10) names the inbox items this wake raised for the user's request; the server keeps only those whose `origin` is this wake's messages, and each renders under the reply as the card the user clicks. In a message wake, `answer`, `send` and `confirm` on a tab above its delegation (at `observe` or higher) escalate as `delegation-observe` instead of refusing, and any act verb whose category is in shadow escalates as `shadow` instead of proposing. Milestone 7.3 (ADR-0128 §5): in a wake one of a followed tab's existing triggers started, `reply` with `followId` is that follow's **report** (`kind: "report"`, ledgered `verb: "report"` with `origin: { kind: "follow", followId }`); its `items` keep only those with that follow's origin. `refs` (≤ 10, `{ kind: tab \| ledger \| item, id }`) are resolved by the server and dropped when they do not resolve. Milestone 7.4: the Supervisor tab renders the reply's text with every link removed (a URL stays inert text), each `items` id as the inbox card itself, and each resolved `ref` as the reply's only links; the verb is unchanged. |
| `follow` | Milestone 7.3 (ADR-0128 §5). `{ marvinSessionId, until: scope-met \| merge-ready, grounds }` — a record, not authority. Needs a `message:` ground to a user message from the last 24 hours, a tab delegated at `observe` or higher, and room under the per-project cap of 5 (at the cap it is refused, listing the open follows). A tab has one open follow; asking again updates `until`. Adds no wake trigger and no read authority. |
| `unfollow` | Milestone 7.3. `{ marvinSessionId }` — ends the tab's open follow; no more reports on it. |

Because the executor never holds this server, `personality.ts` carries no "prefer `marvin-supervise`" line (step 5 below does not apply); the supervisor's own prompt is `supervisor-prompt.ts`.

## Browser automation

The Playwright CLI (default) is not an MCP — MARVIN shells out via `Bash` (`npx playwright` is on PATH) for one-shot captures + full `npx playwright test` suites. See [browser tools in `personality.ts`](../../sidecar/packages/runtime/src/personality.ts).

**Opt-in Playwright MCP (ADR-0045).** An external stdio server (`npx @playwright/mcp@latest`, key `playwright` ⇒ `mcp__playwright__browser_*`) for interactive, stateful browsing. **Off by default**; enabled per-turn via the `playwrightEnabled` setting (header Setup popover / macOS Settings ▸ Browser). Unlike the in-process servers above (blanket-allowed), it is **gated** in `classifyToolCall`: observation auto, interaction/navigation confirm, `browser_run_code_unsafe` denied, and the ADR-0030 subagent invariant restricts sub-agents to the observational tools.

One-time setup on a fresh machine:

```bash
npx playwright install chromium
```

Browser binaries aren't shipped via npm; you must install them before MARVIN can drive a browser.

## Adding a new MCP server

To ship a new `marvin-*` MCP:

1. Create a module in `sidecar/packages/runtime/src/` that exports an `McpServerConfig` — prefer in-process servers (like `marvin-graph`) over stdio children, which can leak subprocesses on long sessions.
2. Wire it into [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) in the `mcpServers` object.
3. Document the tools in this file.
4. Write an ADR if the server is material.
5. Update `personality.ts` `CORE_BEHAVIOR` to tell the executor when to prefer it.

## Related

- [Graphify integration](../concepts/graphify-integration.md) — how the knowledge graph feeds MARVIN's reasoning.
- [Tool policy](../security/tool-policy.md) — MCP tools auto-allow; that rule lives in the policy.
- [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) — MCP registration implementation.
- [`sidecar/packages/graphify-bridge/src/mcp-server.ts`](../../../sidecar/packages/graphify-bridge/src/mcp-server.ts) — `marvin-graph` source.
