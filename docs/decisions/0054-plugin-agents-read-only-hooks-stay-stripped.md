# ADR-0054 — Plugin subagents: admitted read-only; plugin hooks stay stripped

**Status:** Accepted — 2026-07-23
**Touches:** `plugin-loader.ts` (stop stripping `agents/` from the staged copy;
keep stripping `hooks/` + the manifest `hooks` field), `PluginsPane.swift`
(agents chip flips from `· off` to loaded), `personality.ts` (Project-plugins
prompt note), `CLAUDE.md` (plugins section + Golden Rule 1 cross-ref),
[ADR-0053](./0053-plugins-as-local-plugin-loader.md) (resolves its deferred
question). Enforcement rests on the existing subagent read-only invariant
([ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md)) and the
`Task`-dispatch policy (`@marvin/tools/policy`).

## Context

ADR-0053 v1 loads a plugin's skills, slash commands, and (gated) MCP servers,
but **strips `agents/` and `hooks/`** from the staged copy pending this ADR.
That cut was safe but expensive in practice: for the plugins users actually
install, the agents ARE the product —

- `claude-security`: 1 skill, **7 agents** (scan/verify/patch pipeline)
- `code-modernization`: **8 agents** (analysts, critics, migrators)
- `honeycomb`: 9 skills + **2 agents** (investigator, instrumentation-advisor)

Enabling those plugins in MARVIN today yields their skills and leaves their
main value stripped.

The tension is **Golden Rule 1**: MARVIN is a single assistant; multi-agent
*implementation* dispatch is the failure mode the rule exists to prevent
(sequential-work degradation, error amplification). The three sanctioned
carve-outs (advisor, scout, dynamic workflows) share one enforced invariant:
**a subagent cannot mutate the workspace** — `classifyToolCall` hard-denies
any tool call carrying an SDK `agentID` whose base decision isn't `allow`
(`sdk-runner.ts` — confirm never silently becomes allow for a subagent).
Golden Rule 1 also states: *any new subagent type requires a new ADR*. This is
that ADR for plugin-shipped agents as a **class**.

Hooks are a different animal: a plugin `PreToolUse`/`PostToolUse` hook runs
arbitrary commands that can observe, rewrite, or block EVERY tool call in the
turn — inside MARVIN's own gate pipeline. That is not a read-only surface and
has no equivalent mechanical containment.

## Decision

### 1. Plugin agents load, as read-only advisors by mechanism

`plugin-loader.ts` stops stripping `agents/`; the staged copy carries the
plugin's agent definitions and the SDK registers them. Containment is
mechanical, not prose, and two-layered:

- **Dispatch is gated.** Plugin agent names are NOT added to
  `SANCTIONED_SUBAGENT_TYPES` — a `Task` call with an unknown
  `subagent_type` classifies `confirm` (policy.ts), so in `gated` mode the
  user sees and approves every plugin-agent dispatch; in `auto` mode it
  proceeds under the standing auto-mode bypass like every other confirm-class
  call. No new policy machinery, no per-plugin allowlist to drift.
- **Spawned agents cannot mutate.** Every tool call from the spawned agent
  carries its SDK `agentID`, and the ADR-0030 invariant collapses the ladder:
  read-only/whitelisted tools run; Write / Edit / NotebookEdit / mutating
  Bash / confirm-class MCP are **hard-denied**. A plugin "patch-generator"
  agent can therefore analyse and *propose* — its report returns to the main
  loop, which remains the only place mutations happen.

This is the same shape as the scout/advisor carve-outs: bounded, read-only,
parenthetical helpers feeding the single main loop. Golden Rule 1's ban on
parallel *implementation* stands — a plugin agent that tries to implement
hits the deny wall on its first write.

**Consequence accepted:** agents whose designed value includes writing (e.g.
claude-security's patch-generator) run degraded in MARVIN — they can read,
reason, and report; the main loop applies changes. That's the correct
degradation direction; the alternative (per-plugin write grants) reopens the
exact failure Golden Rule 1 exists to prevent.

### 2. Plugin hooks remain stripped — indefinitely, not "pending"

`hooks/` and the manifest `hooks` field stay out of the staged copy. A hook
is arbitrary code interposed on MARVIN's tool flow: it can rewrite tool
inputs, block the gate's decisions, or exfiltrate call payloads, and the
subagent invariant offers zero leverage over it (hooks run in the main turn,
not under an `agentID`). There is no read-only version of "interpose on every
tool call". If a concrete plugin someday justifies it, that's a new ADR with
a per-plugin trust grant and a sandbox story; this ADR deliberately does not
leave a "pending" door open.

### 3. Supersedes the bespoke Honeycomb-MCP roadmap item

The roadmap's deferred "Honeycomb MCP integration" (a hand-built
`marvin-honeycomb` server) is superseded by this path: the honeycomb plugin
already ships the skills + agents, its MCP server arrives confirm-gated via
ADR-0053, and team-specific config stays in the user's `~/.claude` /
`<workDir>/.marvin` — the isolation contract holds with no MARVIN-side
Honeycomb code at all.

## Consequences

- **Positive.** claude-security / code-modernization / honeycomb become
  genuinely useful inside MARVIN; no new trust surface (both enforcement
  layers already existed and are already tested); the Plugins pane chip flips
  `N agents · off` → `N agents` truthfully.
- **Negative.** Write-capable plugin agents run in propose-only mode
  (accepted above). Plugin agent *quality* is uncurated — a bad agent wastes
  a dispatch, but can't damage the workspace.
- **Unchanged.** Hooks stripped; MCP confirm-gated; opt-in per project;
  nothing loads for projects with no `plugins.json`.

## Scope of Done

- [x] Staged plugin copies retain `agents/` (hooks still stripped + manifest
      `hooks` field removed) — staging unit test.
- [x] A plugin-agent `Task` dispatch classifies `confirm` (unknown type) and
      a mutating call under an `agentID` hard-denies — covered by existing
      policy/dispatch tests; add an explicit plugin-flavoured case.
- [x] Plugins pane shows agents as loaded (no `· off`), hooks unchanged.
- [x] `personality.ts` + `CLAUDE.md` updated; roadmap Honeycomb item marked
      superseded.
- [x] Full suite + typecheck green; app rebuilt.
