# ADR-0053 — Claude Code plugins in MARVIN: opt-in local-plugin loader

**Status:** Accepted — 2026-07-23
**Touches:** `sdk-runner.ts` (merge enabled plugins into the `plugins:` array;
merge plugin-declared MCP servers into `mcpServers`), `@marvin/tools/policy`
(generalize `mcpToolPolicy` — allowlist MARVIN's in-process servers, gate every
other MCP tool to `confirm`; no longer blanket-allow), a new
`plugin-loader.ts` in `@marvin/runtime` (discover installed plugins + read the
per-project enable list + synthesize `SdkPluginConfig[]`), a per-project
`<workDir>/.marvin/plugins.json` (mirrors `skills.json`), `personality.ts`
(note the plugin surface), `CLAUDE.md` (Plugins section). Builds on the plugin
mechanism proven by ADR-0024 (project-local skills as a synthetic plugin), the
external-MCP gating of [ADR-0045](./0045-playwright-mcp-gated.md), the subagent
read-only invariant ([ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md)),
and the skill-enablement layer of ADR-0037.

## Context

MARVIN runs the Claude Agent SDK in **isolation mode**: it never sets
`settingSources`, so per the SDK contract *"no filesystem settings are loaded"*
(`sdk.d.ts:1549`). That is deliberate — loading `~/.claude/settings.json`,
`.claude/settings.json`, and (via `'project'`) the project CLAUDE.md would bleed
foreign permissions, hooks, and context into MARVIN's carefully-built gate,
personality preset, and context injection.

The side effect: **plugins installed through the Claude Code `/plugin` UI do not
work in MARVIN.** Plugin *enablement* lives in the settings family, which
isolation mode doesn't read. A user who installs `honeycomb`, `claude-security`,
etc. via Claude Code sees none of their skills, MCP tools, or subagents inside a
MARVIN turn. Loose `SKILL.md` folders in `~/.claude/skills/` **do** load (the
`claude_code` preset walks that directory directly), which is why the vendored
skills work — but plugins are a different, unserved channel.

Two things block a clean fix:

1. **`settingSources` is the wrong lever.** Turning it on to pick up plugin
   enablement also loads settings permissions, foreign hooks, and CLAUDE.md —
   the exact isolation MARVIN chose to keep. Too broad, too many side effects.

2. **The gate blanket-allows unknown tools.** `classifyToolCall`
   (`sdk-runner.ts:591`) short-circuits any tool not in `KNOWN_TOOL_NAMES` to
   `allow`, and `mcpToolPolicy` (`policy.ts:278`) returns `null` (→ allow) for
   every MCP name except Playwright's. Safe today (the only other MCP servers
   are MARVIN's four read-only in-process ones), but the moment a plugin
   contributes tools they would **run ungated even in `gated` mode**. This is
   the same hole ADR-0045 closed for Playwright — but only for Playwright.

The SDK *does* expose a narrow, isolation-preserving lever: the `plugins:`
option (`sdk.d.ts:1427`) loads a plugin's *"custom commands, agents, skills,
and hooks"* via `{ type: 'local', path }` — **without** `settingSources`. MARVIN
already uses it (ADR-0024) for one synthetic plugin. Passing installed plugins
the same way loads their contributions surgically, with none of the settings
blast radius. (MCP servers are **not** loaded by that path — the SDK doc lists
commands/agents/skills/hooks only — so plugin MCP must be merged into
`mcpServers` separately.)

## Decision

Add an **opt-in, per-project** loader that makes installed Claude Code plugins
usable inside MARVIN through the SDK `plugins:` array, and **harden the gate** so
plugin-contributed tools are gated by default rather than blanket-allowed.

### 1. Discover from `~/.claude/plugins` (shared with Claude Code)

The loader reads `~/.claude/plugins/installed_plugins.json` — the same registry
the Claude Code `/plugin` UI writes. A plugin installed either place therefore
becomes *available* to MARVIN with no second install. This directly answers the
user's problem ("plugins I installed in Claude Code don't show up"). MARVIN's own
future installer (Phase 3) writes to the same dir.

### 2. Enablement is opt-in, per project

Availability ≠ active. A plugin loads into a turn only when listed in
`<workDir>/.marvin/plugins.json` (`{ enabled: [...] }`, mirroring ADR-0037's
`skills.json`). Default: **empty — nothing auto-loads.** No existing session
changes behaviour until a user opts a plugin in. This keeps the `claude_code`
preset's "load everything" bloat problem (ADR-0037) from recurring at the plugin
layer, and keeps Golden Rule 4 (no cross-project contamination) intact — plugin
activation is a property of the project's own `.marvin/`, committed with it.

### 3. Load via `plugins: [{ type: 'local', path }]`; merge plugin MCP separately

For each enabled plugin, `sdk-runner.ts` appends
`{ type: 'local', path: <plugin cache dir> }` to the `plugins:` array (alongside
the ADR-0024 project-local plugin). Plugin-declared MCP servers (from the
plugin's `.claude-plugin/plugin.json` `mcpServers` field / bundled `.mcp.json`)
are read by the loader and merged into `options.mcpServers` under a
plugin-namespaced key.

**v1 contribution scope: skills + MCP + commands.** Plugin **hooks** and plugin
**subagents** are deferred:
- **Hooks** can rewrite/block tool flow inside a MARVIN turn — too large a blast
  radius to admit unreviewed. v1 does not load them (the loader points the SDK
  at the plugin dir; a follow-up decides hook handling — filter, sandbox, or
  trust-list).
- **Subagents** touch Golden Rule 1 (no multi-agent dispatch). The subagent
  read-only invariant (§4) means they *cannot mutate* even if loaded, but
  admitting a plugin's whole agent catalog is a separate decision deferred to a
  follow-up ADR.

### 4. Harden the gate: allowlist MARVIN's servers, gate the rest

Generalize `mcpToolPolicy` (`policy.ts`). Today it owns only the Playwright
prefix and returns `null` for everything else (→ blanket-allow). Change it to:

- **MARVIN's in-process servers** (`mcp__marvin-graph__`, `mcp__marvin-memory__`,
  `mcp__marvin-backlog__`, `mcp__marvin-control__`) → `null` → blanket-allow
  (unchanged; these are trusted and read-only).
- **Playwright** → existing auto/deny/confirm ladder (unchanged).
- **Every other `mcp__*` tool** (i.e. plugin-contributed) → `confirm` by
  default. State-changing / unknown-egress by assumption; the user confirms in
  `gated` mode, and the subagent read-only invariant (any `agentID` +
  non-`allow` → hard-deny) applies automatically since `confirm ≠ allow`.

This is strictly a **tightening**: the only external MCP server registered today
is Playwright (already handled), so no current behaviour regresses — but the
blanket-allow hole for *future* external MCP (plugins and beyond) is closed at
the source, not per-server.

## Consequences

- **Positive.** Installed plugins become usable in MARVIN with no
  `settingSources` and no settings/hook/CLAUDE.md bleed. The gate change closes a
  standing blanket-allow hole for all external MCP. Opt-in + per-project keeps
  context lean and projects isolated. Shared discovery means the Claude Code
  `/plugin` UI doubles as MARVIN's install path until Phase 3 ships.
- **Negative / cost.** Plugin skills, once enabled, count against the context the
  preset loads — the enablement gate (opt-in) is the mitigation, same as
  ADR-0037. Plugin MCP servers spawn subprocesses per turn (same weight caveat as
  Playwright). Hooks/subagents remain unavailable in v1 — a deliberate scope cut,
  not an oversight.
- **Follow-ups.** Phase 2: a Plugins pane (macOS + sidecar) mirroring the Skills
  pane. Phase 3: extend `skill-installer.ts`'s marketplace path to install full
  plugins from a URL. Separate ADR for admitting plugin hooks and/or subagents.

## Scope of Done

- [x] A plugin listed in `.marvin/plugins.json` has its skills callable in a
      MARVIN turn (loader wires it into the SDK `plugins:` array); a plugin not
      listed loads nothing — opt-in proven by `readEnabledPlugins` tests.
- [x] A plugin-contributed MCP tool routes through `confirm` in gated mode
      (asserted in `policy.test.ts` + `can-use-tool-dispatch.test.ts`) — never
      blanket-allowed; a sub-agent's plugin MCP call hard-denies.
- [x] MARVIN's own in-process MCP tools still blanket-allow (no regression in the
      graph/memory/backlog/control path — asserted).
- [x] A session with no `.marvin/plugins.json` behaves exactly as before
      (loader returns EMPTY; full suite green — 454 tests).
- [x] `CLAUDE.md` + `personality.ts` describe the plugin surface and the opt-in.

**Phase 2 landed (backend + UI):** `/api/plugins` GET/POST +
`listInstalledPlugins` / `setEnabledPlugins`; a macOS **Plugins pane**
(`PluginsPane.swift`, a `LeftPane` tab mirroring `SkillsPane`) — per-plugin
enable toggle + contribution chips (skills/commands/MCP loaded; agents/hooks
shown as `·off`).

**Phase 3 landed (install inside MARVIN):** `plugin-installer.ts` +
`/api/plugins/install` clone a marketplace/plugin repo, copy the chosen plugin
into `~/.claude/plugins/cache/…`, and register it in `installed_plugins.json`
(shared discovery with the Claude Code `/plugin` UI). Marketplace URLs return a
pick-list; bare plugin repos install directly. Clone+copy only — nothing runs at
install. The Plugins pane's "Install" sheet drives it. Registry-merge +
name-derivation are unit-tested (`plugin-installer.test.ts`); the git-clone path
is network-bound and covered manually.

**Phase 3 addendum — marketplace catalog browse.** The pane initially listed
only *installed* plugins; the Claude Code `/plugin` browser also shows each
known marketplace's full catalog (~270 plugins in the official one). Added
`listMarketplaceCatalog()` / `buildCatalog()` (reads the LOCAL marketplace
clones under `~/.claude/plugins/marketplaces/` — no network) + `installFromKnownMarketplace()`
(relative-source plugins copy straight from the clone; external sources
shallow-clone), surfaced as GET `/api/plugins` `catalog` + an "Available from
marketplaces" searchable section with one-click install. `buildCatalog` is
unit-tested (installed-marking by bare name, ordering).

**Deferred:** the plugin **hooks/agents** follow-up ADR (still stripped in v1).
