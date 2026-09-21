# ADR-0118 — One system prompt per session, deltas ride the turn, and settings isolation that is real

- **Status:** Accepted — implemented 2026-09-21 (Milestone 1 of the context-budget plan; Milestones 2–4 pending)
- **Date:** 2026-09-21
- **Related:** [ADR-0073](./0073-agent-sdk-0-3-upgrade.md) (SDK pins; its 0.3.278 addendum introduced the transitional `snapshot: false` pin this ADR removes), [ADR-0041](./0041-project-graph-lifecycle-and-context-budget.md) (context budget), [ADR-0036](./0036-ask-agent-plan-modes.md) (modes), [ADR-0108](./0108-per-session-posture.md) (per-session posture), [ADR-0053](./0053-plugins-as-local-plugin-loader.md) / [ADR-0054](./0054-plugin-agents-read-only-hooks-stay-stripped.md) (plugins), [ADR-0042](./0042-memory-as-durable-facts.md) (MARVIN's memory)

## Context

The user, after a fresh tab died: *"a new session with 'Shared' workspace should
be a fresh one completely."* It was fresh — one user turn, a new SDK session —
and it still thrashed: session `bf45b11e` on agri-saas-platform sent **142,596
tokens** on its first request, auto-compacted six times in eleven minutes, and
ended on the SDK's "Autocompact is thrashing". Compaction frees messages; the
fixed load is everything else.

Measuring it (`sidecar/scripts/context-baseline.ts`, the SDK's own
`getContextUsage`) found three problems that had nothing to do with size alone.

**1. The system prompt changed between turn 1 and turn 2.** Turn 1's append
carried the full project context; later turns a short "ongoing" block; and
`modeGuidance(mode)` was concatenated into it. A two-turn probe showed what a
resumed turn does with a different append: it *replaces* turn 1's. So from turn
2 on, the model had no ADR titles, memory, backlog or project `CLAUDE.md` from
MARVIN at all, and every turn-1 → turn-2 switch broke the prompt cache. On
Claude Fable 5.1, a changed system prompt also invalidates earlier thinking
blocks (400 or dropped blocks for accounts created on or after 2026-08-31).
Anthropic's guidance for that model: keep the prefix stable, send per-turn
reminders in the turn.

**2. "Isolation mode" was never on.** CLAUDE.md, ADR-0053 and `plugin-loader.ts`
all said MARVIN runs "without `settingSources`" and therefore loads no Claude
Code settings. The SDK's documented default is the opposite: *omitted, all
sources load; only `[]` isolates*. Every MARVIN turn on agri-saas-platform
carried the project `CLAUDE.md` (4,569 tokens, which `buildProjectContext`
already injects), Claude Code's own per-project auto memory `MEMORY.md` (5,256),
121 skills, and — against ADR-0054's "hooks are never loaded" — the user's
Claude Code plugins: 10 plugin agents observed, three plugins that ship hooks.

**3. The window.** On SDK 0.3.278, `claude-fable-5-1` runs with a 1,000,000
token window (compaction at 967K). The thrashing session ran on 0.3.251 with
200K. The upgrade alone would have prevented this incident; it does not make a
71 %-of-200K baseline right.

## Decision

1. **One append per session.** `buildTurnSystemPrompt` always builds the full
   context (it no longer takes `firstMessage`), so turn N's append equals turn
   1's while the underlying files are unchanged. `turnSystemPrompt` sets
   `snapshot: true`: the SDK records the prompt on the first request and
   replays it until compaction, which is also when a changed memory or backlog
   reaches it. This removes ADR-0073's transitional pin 3.
2. **Deltas ride the turn.** `turnReminders` builds the `<system-reminder>`
   suffix: orientation, **mode**, session tree, active plan. The mode is stated
   on every turn, Agent included, because an Agent turn after a Plan turn would
   otherwise see only the stale `Mode: PLAN` reminder in history.
3. **Settings isolation.** `settingSources: ["user"]` — `user` alone keeps
   `~/.claude/skills/` loading under bare names, which `personality.ts` and the
   ship-review gate depend on; `[]` would drop them. The flag layer turns every
   plugin the user enabled in Claude Code off (`userPluginsOff`); MARVIN's own
   per-project plugins arrive as staged local copies and were verified to
   survive the override. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` stops Claude
   Code's per-project memory — `user` does not control it. The three one-shot
   side queries (session auditor, practice-rule drafter, skill discoverer) had
   the same gap and need no skills at all: they get `settingSources: []` and
   auto memory off.
4. **Measure every turn.** After `system/init`, one `getContextUsage` call
   emits `runagent.context_baseline` telemetry and a `marvin.context.baseline`
   system event (the app renders no system rows).

## Consequences

- agri-saas-platform, fresh tab, same posture: **151,927 → 139,761 tokens**.
  Gone: the duplicate project `CLAUDE.md`, its 5.7K `instructions` attachment,
  Claude Code's auto memory, the user's Claude Code plugin agents. What
  remains is Milestones 2–4's work: ~59K of MARVIN append (29.5K base prompt,
  28K project context), 119 listed skills (agri enables 9 plugins through the
  Plugins pane — the user's choice), ~10K of MCP schemas.
- A personality switch mid-session now takes effect at the next compaction or
  in a new tab: personality is part of the recorded prompt. Mode switches take
  effect immediately (verified live: PLAN → AGENT on a resumed turn, project
  codeword still visible).
- Memory, backlog and ADR changes made during a session reach the recorded
  prompt at the next compaction, not the next turn. The tool results that
  made them are already in the conversation.
- The user's `~/.claude/settings.json` still loads (skills need it): its
  `CLAUDE.md` (103 tokens), permissions and any hooks the user writes there.
  Those are the user's own; the risk was the plugins and the project's files.
  A project's `.claude/settings.json` and `.claude/skills/` no longer load —
  MARVIN's project skills live in `.marvin/skills/` (ADR-0024).
- Probed and refuted on the way: project `permissions.allow` rules do not skip
  `canUseTool` — the gate was consulted and its deny held.
- The SDK's `skills` allowlist was measured and **not** adopted: listing 5 of
  51 skills cut the listing by 1.8K but loaded 6.6K more tool schemas.

## Scope of Done

- [x] `buildTurnSystemPrompt` builds the full context every turn; both callers updated
- [x] `turnSystemPrompt` records the prompt (`snapshot: true`); `turnReminders`
      carries the mode on every turn; tests
- [x] `settingSources: ["user"]`, `userPluginsOff()` in the flag layer, auto
      memory off; tests for the override
- [x] Side queries (auditor, practice draft, skill discoverer) fully isolated
- [x] Per-turn baseline telemetry + `sidecar/scripts/context-baseline.ts`
- [x] Live: two-turn probe (mode switch + project context on resume);
      baseline 151,927 → 139,761 on agri-saas-platform
- [ ] Milestone 2 — project context by index (needs the Golden Rule 5 decision)
- [ ] Milestone 3 — base prompt ≤ 8K tokens
- [ ] Milestone 4 — defer non-graph MCP servers; baseline-over-50 % warning
