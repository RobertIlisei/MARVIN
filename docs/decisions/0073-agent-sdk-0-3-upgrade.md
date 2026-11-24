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

## Addendum — 0.3.245 → 0.3.251 (2026-08-30)

Routine patch bump (peer `@anthropic-ai/sdk` 0.120 → 0.122). The type surface
diff is **purely additive** — nothing removed — with new fields around cost
and caching (`pricing`, `cache_ttl`, `estimated_cache_write_usd`, `costBasis`),
`context_tokens`, `ambient`, and `perTaskStopAffordance`.

Both pins **re-verified live** rather than assumed, because that is the
failure mode this ADR exists for — an SDK default moves and nothing errors:

```
model claude-haiku-4-5-20251001
todoFamily   ["TodoWrite"]        ← pin 1 holds (no TaskCreate/TaskUpdate)
graphTools   13, always loaded    ← pin 2 holds (not deferred behind ToolSearch)
tools        172                  (was 113 on 0.3.245)
```

Two things worth recording from the same run:

- `system/init` **still reports the subagent tool as `Task`**, while the
  `tool_use` blocks say `Agent`. Exactly the discrepancy
  [ADR-0079](./0079-subagent-tool-rename-and-rails.md) documents; the gate
  matches both, so this is noted, not a problem.
- The `rate_limit_event` now carries `unifiedWindows` through `runAgent` —
  the field the plan-usage block needs. That is the CLI fix from
  [ADR-0087](./0087-newest-claude-cli-and-reported-context-window.md), not the
  SDK bump, but this run is where it was confirmed end to end.


## Addendum — 0.3.251 → 0.3.278 (2026-09-21)

Patch bump (peer `@anthropic-ai/sdk` 0.122 → 0.127) in all three workspace
packages, one resolved copy. The type diff is additive, and **one default
moved**: `systemPrompt.snapshot`. With it on — the default, rolling out per
account — the CLI records the system prompt on a session's first request and
replays it verbatim on every later request and resume until compaction.

Measured live, not read off the `.d.ts`: two turns of one session, append
`CODEWORD: ALPHA` then `CODEWORD: BRAVO` on resume.

```
snapshot: false   T1 ALPHA   T2 BRAVO    ← per-turn append reaches the model
default           T1 ALPHA   T2 ALPHA    ← turn 2's append silently ignored
```

The default is already live on this account. MARVIN's append is not stable
across turns — turn 1 carries the full project context, later turns a short
"ongoing" block, and `modeGuidance(mode)` changes with the mode — so the
default would freeze turn 1's prompt, mode switches included, until the next
compaction. **Pin 3: `snapshot: false`** (`turnSystemPrompt` in
`sdk-runner.ts`, test `system-prompt-snapshot.test.ts`).

**The pin is transitional.** Rewriting the system prompt mid-session is itself
what Anthropic's Fable 5.1 guidance says to stop doing: it restarts the prompt
cache and, for accounts created on or after 2026-08-31, invalidates earlier
thinking blocks. The same probe showed what the old behaviour costs: a resumed
turn's append *replaces* turn 1's, so from turn 2 the model has had no ADR
titles, memory or backlog in context at all. ADR-0118 makes the append stable
for the whole session and moves per-turn deltas into the turn's
`<system-reminder>` suffix; that change removes this pin and lets the SDK
record the prompt.

Also measured on the same run: `canUseTool` now receives
`mcpServer: { name: "marvin-graph", source: "sdk" }` for MARVIN's in-process
tools — adopted by [ADR-0117](./0117-mcp-trust-by-provenance.md).

Deliberately **not** adopted, checked against the code rather than the release
notes: `reloadPlugins({ holdOnCacheImpact })` (MARVIN passes plugins
fresh on every `query()` and never calls it), the new
`SDKAssistantMessageError` codes (nothing switches on that enum), and
`thinkingTokens` (already inside `outputTokens`, so no cost change).
`getContextUsage({ detail: "summary" })` has no caller today; ADR-0118's
baseline guard is where it earns one.

**Correction (same day).** An earlier version of this addendum dismissed
`omitClaudeMd` because "MARVIN sets no `settingSources`, so no CLAUDE.md is
loaded". That reads the option backwards: **omitted means all sources load**
(the SDK's own doc, unchanged since 0.3.251); only `[]` is isolation. The
baseline probe (`sidecar/scripts/context-baseline.ts`) on agri-saas-platform
shows the project `CLAUDE.md` (4,569 tokens), Claude Code's per-project auto
memory `MEMORY.md` (5,256) and `~/.claude/CLAUDE.md` in every MARVIN turn, 121
listed skills, and 10 agents from the user's Claude Code plugins. What MARVIN
should load is a decision for its own ADR, not a line in this addendum.


## Addendum — 0.3.278 → 0.3.280 (2026-09-23)

Not a considered upgrade: a **forced** one. The bundled CLI is version-locked
against the model, and the API enforces it server-side.

```
API Error: 400 Claude Code 2.1.278 does not support this model;
version 2.1.280 or newer is required.
```

`@anthropic-ai/claude-agent-sdk@0.3.N` bundles Claude Code CLI `2.1.N` — the
two version lines move together (`manifest.json` in the package reports
`"version": "2.1.280"`). So a model released against a newer CLI rejects every
request from an older SDK, and the only fix is the SDK bump. All three
workspace packages moved; the `^0.3.278` ranges already permitted it, and only
`pnpm-lock.yaml` was holding the old resolution.

**Why it presented as a dead session rather than a failed turn.** The model in
the session was `claude-opus-5-5`, which CLI 2.1.278 does not know. One
unknown model, two symptoms:

1. **The window was assumed.** An unknown model gets the default 200K, so the
   CLI set `autoCompactThreshold: 167000` (observed in the transcript's
   `marvin.context.baseline` events) and declared a 412K session to be at
   206 % — forcing a compaction that a correctly-sized window would never have
   asked for.
2. **The compaction request was rejected.** Compaction is itself an API call,
   so it hit the same version check the turn did. The session could not
   shrink itself, and the retry loop had no exit.

So the compaction failure was not a second fault next to the version error —
it *was* the version error, reached by a path the version error had also
created. Nothing about compaction changed in this release.

The lesson for the next bump: **a version-locked dependency's failure mode is
not always the feature it gates.** The visible message named compaction; the
cause was a model table two patch versions stale.

**Observed in passing, not fixed here.** MARVIN's own `contextWindowFor`
(`models.ts`) has the same shape of gap: the Anthropic `/v1/models` API does
not report window size, so any model without a `[1m]`/`-1m` marker in its id
falls to the 200K default. The same transcript shows `maxTokens` reported as
1,000,000 on some turns and 200,000 on others within one session. This only
drives MARVIN's display and colour bands — the CLI's own threshold is what
triggers compaction — so it did not cause this incident. Worth its own change.

Type diff is additive; no pin moved. Verified: full suite 1,475 tests / 104
files green, `tsc --noEmit` clean on `@marvin/runtime`.


## Addendum — 0.3.280 → 0.3.286 (2026-10-01)

A considered upgrade this time, six releases, read change by change against
the code. Bundled CLI **2.1.286** (`manifest.json`).

**Verified live, not from `system/init` alone** (the ADR-0079 lesson): a
`query()` on `claude-sonnet-5-5` with MARVIN's flags reports `TodoWrite` in
its tools (`Task`, `TaskStop` alongside — `Task` is the subagent tool), so
the plan-spine pins hold. A deliberately missing `plugins` entry came back in
`plugin_errors` as `{plugin: "inline[0]", type: "path-not-found", path}`.

**Adopted.**
- `system/informational` (0.3.283): warnings and notices the CLI used to drop —
  a hook's block reason, slash-command output. The chat drops every `system`
  event by design; `SystemNotice` (`MARVINLogic`) lets `notice`, `suggestion`
  and `warning` through as a quiet row (`info` is transcript-only by the SDK's
  own contract).
- `system/init.plugin_errors` (0.3.283): a staged plugin (ADR-0053) that did
  not load. MARVIN mounts plugins as `--plugin-dir` entries, so an error
  carries `inline[N]` plus the path; the row names the path's last segment.
  `init` repeats every turn, so an identical notice already on screen is not
  added again. Telemetry: `plugin.load_error`.
- Fixes MARVIN benefits from with no code change: a follow-up turn woken by a
  finished background agent no longer has stdin closed under it ("Stream
  closed" in hooks, `canUseTool` and SDK MCP calls — 0.3.284); foreground
  subagents get the task-tracking tools named in `allowedTools` (0.3.286); an
  SDK MCP server with one unconvertible tool schema lists the others instead
  of none (0.3.286); in-process MCP handshakes run inside the SDK and
  `initialize` is answered before background start-up (0.3.281).

**Checked, no change needed.**
- *Omitted `permissionMode` now defers to settings, possibly auto mode*
  (0.3.286). MARVIN passes `permissionMode: "default"` explicitly
  (`sdk-runner.ts`); the gate stays the only approver.
- *Bash `timeout` now bounds `run_in_background`* (0.3.285). MARVIN denies
  `run_in_background` at the gate and tracks long work through
  `run_background_job` (ADR-0038).
- *Priority `now` messages join a running turn* (0.3.286). MARVIN does not
  send priority messages.

**Not adopted, deliberately.** `prewarm()` / `SpareProcess` (alpha — a spare
CLI per project is real memory on a machine that already runs several tabs;
revisit when it leaves alpha and a measured turn-start cost justifies it);
the `/core` entry point (Next's standalone tracer bundles the full package
either way); `forkSession`, `getSessionMessages`, `getSubagentMessages`,
`toggleMcpServer`, Ultracode settings, marketplace policy, Artifact
`read.title` — MARVIN calls none of them.


## Addendum — graphify 0.9.73 → 0.9.118 (2026-11-24)

Prepared, not switched. The installed tool is still 0.9.73; this records what
the bridge needs for 0.9.118, what it costs, and the order to switch in.

**Why.** On agri-saas-platform (20k scanned files, Java and TypeScript) every
tab ran `graphify update` per turn. 0.9.73 held ~14 of 18 cores for 30 to 60 s
each time, and a tab's `graphify-out` was 2.2 to 2.6 GB.

**Measured** on a throwaway checkout of that project, 6 workers, both versions
with `GRAPHIFY_NO_AUTO_REFRESH=1`, `/usr/bin/time -l`, the project's own
`.graphifyignore`. "0.9.118 plain" is a `uv pip install graphifyy==0.9.118`;
"+grammars" adds `tree-sitter-sql` and `tree-sitter-hcl` (the `sql` and
`terraform` extras), which the project's 1,075 `.sql` and 8 `.hcl` files need.

| Run | 0.9.73 | 0.9.118 plain | 0.9.118 + grammars |
|---|---|---|---|
| `graphify . --code-only`, cold | 130 s, 2.6 GB, graph.json 294 MB; 109,711 nodes, 453,576 edges, 2,276 communities | 124 s, 1.4 GB, 264 MB; 113,341 / 467,113 / 2,316 | not run |
| first `update` after that build | 233 s, 5.6 GB | 138 s, 4.8 GB (full rebuild, no build state yet) | 130 s, 3.2 GB (adds SQL nodes: 116,786 / 471,800 / 2,975) |
| `update`, 15 Java + 5 TS files touched | 244 s, 6.9 GB, 265 CPU s | 109 s, 4.3 GB, 111 CPU s | 51 s, 3.1 GB, 53 CPU s |
| `update`, nothing changed | 277 s, 7.2 GB | 42 s, 2.5 GB | 14 s, 150 MB |
| tab seeded as MARVIN does (graph, manifest, cache), first `update` | not run | not run | 110 s, 6.3 GB; seeding the whole `graphify-out` instead: 97 s, 5.7 GB; then 20 files touched: 41 s, 3.7 GB |
| 0.9.73-built `graphify-out` upgraded in place, first `update` | n/a | n/a | 223 s, 8.8 GB, 155,209 nodes; then nothing changed: 11 s, 152 MB |

A tab's `graphify-out` after the same steps is about 290 MB on 0.9.118
(graph.json 259 MB, cache 12 MB) against 1.2 GB on 0.9.73 (cache 480 MB, a
356 MB dated snapshot). 0.9.90 moved the hub-fallback community names out of
`.graphify_labels.json`, so they no longer count as curated and no dated
snapshot is taken; three rebuilds on 0.9.118 made none.

**What the tool already does, so MARVIN adds no skip.** 0.9.96 exits early when
nothing changed, 0.9.102 re-extracts only changed files, and 0.9.115 reports an
oversized JSON file as skipped so the early exit still holds. The early exit
did not hold on the plain install: a file whose grammar is missing never gets a
manifest row, so 1,075 `.sql` files were "changed" on every run (42 s, 2.5 GB
against 14 s, 150 MB). The fix is the extras, not a MARVIN-side gate. MARVIN
already skips a worktree whose HEAD and `git status` are unchanged
(`treeFingerprint`) and a project whose HEAD has not moved.

**Breaks found, and what changed.**
- `graphify query`, `explain`, `path`, `affected` and `benchmark` import
  `anyio` in 0.9.118 (`serve.py:14`), which only the `mcp` extra installs; 0.9.73
  did not. On a plain install `graph_query`, `graph_explain` and `graph_benchmark`
  died with a Python traceback. `graphifyExtrasHint` names the reinstall, and the
  missing-binary hint now says `graphifyy[mcp]`.
- A bare name that matches several nodes exits 3 with the candidate ids on
  stdout (0.9.93; `query` was a fuzzy search on 0.9.73). `graph_query` kept only
  the exit message and dropped the ids; it now uses the same stdout-keeping error
  text as `graph_explain`.
- The extraction cache writes caller ids as `$graphify-root$_<slug>` (0.9.80)
  where graph.json keeps `<slug>`. Only the cache fallback of `graph_affected`
  reads them, which is used when graph.json has no located `calls` edges. The
  placeholder is stripped so the ids still resolve to graph nodes.
- graphify sizes its extraction pool at one worker per core in both versions.
  `graphifyEnv` now sets `GRAPHIFY_MAX_WORKERS` to half the cores, between 2 and
  6 (6 on this machine); a value already in the environment wins.

**Checked, no change needed.** `call-index` (`calls` edges, `source_file`,
`source_location`, labels), `graph_affected` on salted Java overload ids,
`summarizeGraph` and `community_name`, `graph_change_impact`, `graph_path` with
`relations`, `discoverAreas`, `searchGraph`, `seedWorktreeGraph` (graph,
manifest, cache seed as well as the whole directory), the per-turn refresh,
the Swift readers of graph.json (`SymbolSearchSheet`, `ProjectToolsPanel`; every
node still has a string `id`, `label` and `source_file`), `scripts/build-
knowledge-graph.py` (it imports `graphify.cluster` and `graphify.detect`; the
two graphs it wrote were identical in node, edge and community counts),
`export obsidian` and `callflow-html`, `god-nodes --json`, `diagnose multigraph`,
`save-result` and `reflect` with their flags. The bridge tests pass against both
installs (`GRAPHIFY_BIN` pins the binary).

**Behaviour changes to know about.**
- graph.json carries `graph: {schema_version, graphify_version}` and is one
  line of compact JSON; nodes gain a `metadata` block (arity, signature).
- Each Java overload has its own node (0.9.112), so `.fact()` went from 21 to
  225 call sites; labels are unchanged, ids of overloads gain a six-hex salt.
- A graph built with `--code-only` stays code-only across `update` (0.9.101).
  On 0.9.73 the first `update` after a code-only build added the Markdown files
  (38,455 document nodes here); a 0.9.73-built graph upgraded in place keeps them.
- The tool prints a "skill is from graphify 0.9.73" warning on every command
  until `graphify install --platform claude` / `agents` is run. MARVIN's
  `GRAPHIFY_NO_AUTO_REFRESH=1` stops it rewriting the skills; the warning is on
  stderr and the graph tools ignore it on success.
- `graphify update` has no rebuild timeout (`GRAPHIFY_REBUILD_TIMEOUT`, default
  600 s, bounds only `--watch`).

**Noticed, not changed.** The call index keys a Java or class method by its
label, which starts with a dot (`.bindAndActivate()`), so `graph_affected
bindAndActivate` finds nothing on 0.9.73 and 0.9.118 alike; only the dotted
spelling matches, and TypeScript functions are unaffected. The per-worktree
refresh does not lower its priority the way the project watchdog does.

**Switch-over, in this order.** Each step can be undone on its own.
1. Merge this branch and rebuild the app (`/rebuild-app`). It works on 0.9.73
   and 0.9.118, so this can happen first and alone.
2. With no refresh running (`pgrep -fl "graphify update"` shows none), keep a
   copy of the project graph outside the project: `cp -cR <project>/graphify-out
   ~/graphify-out-0.9.73-backup` (an APFS clone, no space until rewritten).
3. `uv tool install --force "graphifyy[mcp,sql,terraform]==0.9.118"`. Drop `sql`
   and `terraform` for a project without those files. `graphify --version`
   must print 0.9.118; MARVIN picks the newest binary it finds on its next
   spawn, no restart needed. Run `graphify install --platform claude` and
   `--platform agents` in a terminal to refresh the skills and silence the
   warning, or leave it to the Skills pane.
4. Rebuild the project graph once, by hand, while no tab refreshes:
   `cd <project> && GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_MAX_WORKERS=6 graphify
   update .` Expect 3 to 4 minutes and about 9 GB of memory at peak. Optionally
   delete the old dated folders (`graphify-out/2026-*`, about 350 MB each).
5. Tab graphs: every existing tab graph is a full rebuild on its next turn (the
   cache epoch changed), serialised per project by MARVIN. To avoid that, delete
   `<project>/.marvin/worktrees/*/graphify-out` for the idle tabs; each reseeds
   from the new project graph on its next turn.
6. Verify: `graphify query "<a symbol>" --graph graphify-out/graph.json` exits 0,
   `graph_summary`, `graph_affected getApiAccessToken`, `graph_query` and
   `graph_change_impact` answer in a MARVIN tab. Re-run `graphify label` only if
   the community names matter; the knowledge graph (`bin/marvin knowledge-graph
   .`) is unaffected.

**Roll back.** `uv tool install --force graphifyy==0.9.73` (the receipt of the
current install). Measured: 0.9.73 answers `query` on a 0.9.118 graph.json, and
its `update` over a 0.9.118-built `graphify-out` ran to exit 0 in 268 s at 7.6 GB
(a full rebuild; it added the Markdown nodes back, 151,619 in all). To go back
without that rebuild, restore the step 2 copy. No MARVIN change needs reverting.

**Not verified.** The real upgrade on the live project (a project with a
curated `.graphify_labels.json` may keep taking a daily snapshot); the first
`update` on a machine with fewer cores or less memory than this one;
`extract --postgres` (no database to run it against; the flag is unchanged in
`--help`); the macOS app against a 0.9.118-built graph beyond decoding the JSON
types its two readers declare.
