# ADR-0022 — Context-pressure observability + session-hygiene nudges

**Status:** Accepted
**Date:** 2026-05-06
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0017 — Phase 2 chat native](./0017-phase-2-chat-native.md),
[ADR-0021 — WebView removal](./0021-webview-removal-fully-native-swift.md)

## Context

The user has been running long-lived chat sessions (14+ turns, ~7.2 MB JSONL,
~145K cache_read tokens per inference step). Each Sonnet decision now takes
50–100 s where the same step on a fresh session takes 5–15 s. The bottleneck
is inference latency on cumulative cache reads, not anything in MARVIN's
runtime — the sidecar idles at 0 % CPU during the wait.

A read of Anthropic's official guidance (compaction docs, context-engineering
cookbook, Agent SDK type defs at v0.2.113) clarifies the design space:

1. **Server-side compaction is the recommended primary strategy** for long
   conversations — `compact_20260112` beta on the raw Messages API. Default
   trigger 150 K tokens, customizable instructions for what to preserve.
2. **For code agents specifically, `clear_tool_uses_20250919` is the larger
   lever than compaction.** The cookbook's research-agent example (96 % of
   context = file reads — almost exactly MARVIN's shape) shows clearing
   alone drops peak from 335 K → 173 K; compaction alone 335 K → 169 K;
   the combo lands at 100–150 K steady state.
3. **The Claude Agent SDK we use already runs compaction internally.**
   Confirmed by inspecting `@anthropic-ai/claude-agent-sdk@0.2.113` type
   definitions: there is no `contextManagement` knob in `Options`, but the
   SDK exposes `PreCompact` / `PostCompact` hook events and an
   `SDKStatus = 'compacting'` value. The SDK owns the policy; we observe.
4. **Anthropic's own Claude Code pattern is "session per logical task"** —
   `/compact` is a stopgap during one task, `/clear` between tasks.
   Auto-compact at 95 % capacity is a safety net, not the primary strategy.

What's broken in MARVIN today:

- The user has zero visibility into context pressure. They feel slowness but
  can't see *why*, and there's no signal to switch sessions.
- The "New" button in the chat header exists but isn't surfaced as the
  remediation for slowness — it reads as a destructive reset.
- The SDK-side compaction events fire silently; the user sees a 30-second
  pause during compaction with no explanation.
- `<workDir>/.marvin/memory.md` is the cross-session persistence layer
  Anthropic recommends, and MARVIN already injects it via
  `buildProjectContext`, but there's no UI signal that this is happening
  and no encouragement to write to it at scope-end.

What we cannot do at this layer:

- Configure compaction trigger thresholds — the Agent SDK doesn't expose
  the underlying `context_management` config. Reaching it would require
  rewriting the agent loop on the raw Messages API. Not worth the scope.
- Enable `clear_tool_uses_20250919` independently. Same constraint.

## Decision

We add **observability + nudges** at the layer the SDK exposes, rather than
attempting to control compaction policy ourselves. Four moves:

### 1. PreCompact / PostCompact hook subscription → UI status

Subscribe to the SDK's `PreCompact` and `PostCompact` hook events.
Surface them as transient UI state on a **parallel bridge field**, not
by overloading `marvinState`:

- Add `MarvinBridge.compactionPhase: "idle" | "compacting"`. Compaction
  can interleave with an in-flight tool turn (the SDK fires PreCompact
  inside an assistant turn), so `thinking` and `compacting` are not
  mutually exclusive — collapsing both onto `marvinState` would break
  the brain-profile state machine.
- On `PreCompact` → `compactionPhase = "compacting"` + a thin banner
  above the input ("Compacting earlier turns…"). Brain profile reads
  the new field as a modifier on top of the existing `marvinState`.
- On `PostCompact` → `compactionPhase = "idle"`, log a one-line
  message-list system row noting bytes freed (if the event payload
  exposes it).
- **Failure modes.** If PreCompact fires but PostCompact never does
  (turn errors mid-compaction, sidecar dies), `compactionPhase` would
  stick. Reset paths: clear in the sidecar's `runTurn` `finally`
  block; clear on `turn.error` SSE; clear on transport disconnect in
  the macOS app. Treat the field as turn-scoped — no carry-over.

Implementation: extend the existing `Options.hooks` dict alongside the
`PreToolUse` design hooks (commit `a4f633c`).

### 2. Context-pressure indicator in the bottom status bar

`AppStatusBar` gets a new segment showing live context usage for the
active turn. The metric we display is **resident context size** — the
tokens the model walks each turn, which is what drives latency. That is
`cache_read_input_tokens + input_tokens` from the latest assistant
cli.event's `usage`. We **do not add** `cache_creation_input_tokens` —
those are bytes the model is *writing* to cache for next turn, not
bytes it is reading this turn, so adding them double-counts on turns
that re-cache.

Hover tooltip splits the figure: `ctx 142K (driving latency) · 8K new
this turn (billable)`. Format in the bar: `ctx 142K` with a colour
ramp tuned for Sonnet 4.x's 200K window and the user's reported pain
point at ~145K:

| Range | Colour | Hint on hover |
|---|---|---|
| < 40 K | tertiary | "Context healthy" |
| 40 K – 80 K | secondary | "Climbing — long sessions slow" |
| 80 K – 140 K | orange | "High — decisions getting slow" |
| ≥ 140 K | red | "Approaching limit — start a new session" |

The numbers are informational, not enforcement. The user sees the tax
growing in real time and decides when to switch sessions. The bands
are an initial guess based on the user's reported 50–100s decisions at
~145K — tune downward in week 1 of real usage if they prove too lax.

### 3. Session-hygiene nudge tied to the `Scope met:` close pattern

The personality's Phase 7 close is a deterministic marker emitted on
every real-work turn end. Two refinements over a naive regex on the
rendered text:

- **Detection.** Extend the personality close to emit a structured
  sentinel — an HTML comment `<!-- marvin:scope-met -->` immediately
  after the prose `**Scope met:**` block. Zero visual weight, but
  trivial to detect by exact substring match. This decouples the
  affordance from personality wording drift; if a future personality
  rewrite says "Scope satisfied:" the sentinel still fires.
- **Two affordances, not one.** When detected, render a chip strip
  below the latest message:
  - `Save to memory.md` — opens a one-line append composer
    pre-filled with a one-sentence summary of the scope (extracted
    from the `**Scope met:**` block). Writes to
    `<workDir>/.marvin/memory.md` via existing file write path.
  - `Start fresh next turn (⌘⇧N)` — calls `model.clear()`
    (preserves cwd / project; next user message lands on a fresh
    `marvinSessionId`).

`model.clear()` does not lose memory.md context — `buildProjectContext`
re-reads memory.md from disk on every first turn of a new session. The
"Save to memory.md" affordance exists because Scope-met without a
memory-write means the just-completed scope's learnings are gone after
clear; offering both buttons makes the persistence choice explicit.

We deliberately don't *auto*-clear on Scope-met; the user might want a
follow-up on the same scope. The nudge is opt-in click.

### 4. Verify + document memory.md continuity

`buildProjectContext` already injects `<workDir>/.marvin/memory.md` into
every system prompt. This satisfies Anthropic's "memory tool" recommendation
in spirit (file-backed cross-session persistence). Read-only audit:

- Confirm the injection still fires after the personality trim
  (commits `176496a` / `9b39645`).
- Add a one-line entry to the bottom-bar context indicator's hover text
  ("memory.md auto-loaded · click to view") so the user can see the
  layer is active.
- Document this in CLAUDE.md so future sessions don't re-derive it.

## Consequences

**Positive**
- User sees context pressure in real time and can self-manage session
  lifecycle. Steady-state latency drops (5–15 s decisions) when the user
  starts fresh sessions for new logical tasks.
- Compaction pauses become explicable rather than mysterious 30-second
  freezes. Reduces the "MARVIN is broken" perception during normal
  long-session behaviour.
- Aligns with Anthropic's official "session per logical task" pattern.
- All work stays at the SDK observability layer — no fork down to the raw
  Messages API, no shadow agent loop.

**Negative / trade-offs**
- The user-facing context indicator is informational only. We don't
  enforce — a user who ignores the indicator and keeps typing will still
  hit the slow steady state. Acceptable: matches Anthropic's own pattern
  in Claude Code (the `/compact` and `/clear` commands are user-driven).
- Adds ~3 new source files (a `compaction-bridge.ts` for hook → bridge
  state, a Swift `ContextIndicator.swift`, and a Swift `ScopeMetNudge.swift`).
  Modest surface, clearly scoped.
- Detection of `**Scope met:**` is regex-based and could miss edge cases
  (the model writes `Scope satisfied:` instead). We accept the false
  negatives — the nudge is opt-in convenience; worst case it doesn't
  appear and the user uses the existing New button.

**Follow-ups created**
- If after a few weeks of usage we still see steady-state pain on a
  single session, evaluate dropping below the Agent SDK to the raw
  Messages API for `clear_tool_uses_20250919`. Tracked as a roadmap
  candidate, not a commitment.
- The colour-ramp thresholds are a guess; tune them after a session of
  real usage data.

## Alternatives considered

- **Drop below the Agent SDK to use the raw Messages API directly**
  (giving us `context_management.edits`). Rejected: rewriting the entire
  agent loop, MCP server orchestration, hook system, and confirm registry
  is many ADRs of work and forks us off the SDK upgrade path. Anthropic
  ships SDK improvements monthly; staying on the SDK is the right
  long-term bet.
- **Auto-clear the session at every `Scope met:` close.** Rejected: too
  aggressive — the user often wants follow-up on the same scope. Surfacing
  the option is enough.
- **Fixed token-budget cap that hard-stops the turn.** Rejected: the SDK's
  own auto-compaction handles the safety floor, and a hard stop in the
  middle of a turn is worse UX than a slow turn that completes.
- **Compaction telemetry to Honeycomb only, no UI indicator.** Rejected
  *as exclusive choice*: the user pays the latency cost in real time;
  they need to see the signal in the same surface where they feel the
  pain. We will, however, ship Honeycomb instrumentation **alongside**
  the UI (every other observability surface in MARVIN is wired to
  Honeycomb — keeping that consistent). Events: `compaction.pre`,
  `compaction.post` with `tokens_freed` attribute, `context.band`
  transitions (green/yellow/orange/red).
- **Thin shim that intercepts a subset of long-running turns through
  `clear_tool_uses` via JSONL post-processing or a custom
  system-prompt directive that the SDK respects.** Rejected for now:
  this is a smaller version of the raw-Messages-API rewrite, but it
  still requires reasoning about JSONL turn boundaries and SDK resume
  semantics, and the SDK does not document a directive surface for
  client-side context editing. Tracked as a roadmap candidate
  alongside the full rewrite — revisit if the observability+nudges
  path proves insufficient after a few weeks of real usage.

## Scope of Done

- [ ] Sidecar publishes `PreCompact` / `PostCompact` events on the SSE
  stream as `cli.event` envelopes (or a new dedicated SSE event type),
  carrying `phase: "compacting" | "compacted"` and any token-savings
  payload the SDK provides. `compactionPhase` resets in the `runTurn`
  `finally` block and on `turn.error`.
- [ ] `MarvinBridge.compactionPhase` accepts `"idle" | "compacting"` as
  a parallel field to `marvinState`. Brain profile reads it as a modifier
  (visible: chat shows a thin banner during compaction; brain animation
  shifts profile without losing the underlying `thinking` / `idle`
  state).
- [ ] `AppStatusBar` renders a context-pressure segment that reads
  `ctx <N>K` (= `cache_read_input_tokens + input_tokens` from the
  latest assistant cli.event), updates after every assistant
  cli.event, and applies the four-band colour ramp (40/80/140K). Hover
  tooltip splits the figure into "driving latency" vs "billable this
  turn".
- [ ] Personality emits the `<!-- marvin:scope-met -->` sentinel after
  the `**Scope met:**` block in Phase 7. When the latest assistant
  text contains the sentinel, the chat shows a chip strip with **two**
  affordances: `Save to memory.md` (opens a one-line append composer)
  and `Start fresh next turn (⌘⇧N)` (calls `model.clear()`).
- [ ] `buildProjectContext` memory.md injection verified working
  post-personality-trim; CLAUDE.md updated with one paragraph documenting
  the cross-session persistence flow.
- [ ] Honeycomb instrumentation: `compaction.pre`, `compaction.post`
  (with `tokens_freed`), `context.band` transition events emitted from
  the sidecar.
- [ ] Manual smoke test in dev: run a session past 80K tokens to
  observe band transition; force a long session to observe the
  `compacting` phase visibly. Both paths exercised before marking the
  ADR Accepted.
- [ ] Tests (named):
  1. `context-tokens.swift` — token-sum helper returns
     `cache_read + input` (and explicitly does NOT add
     `cache_creation`).
  2. `context-band.swift` — band classifier returns the correct
     enum at boundary values (39_999 / 40_000 / 80_000 / 140_000).
  3. `scope-met-detector.swift` — sentinel detection matches
     `<!-- marvin:scope-met -->`, ignores plain prose.
  4. `compaction-events.test.ts` (vitest) — sidecar SSE
     compaction-event parser produces correct envelopes from
     PreCompact / PostCompact hook payloads.
  5. `compaction-reset.test.ts` (vitest) — `compactionPhase` resets
     when `runTurn` errors after PreCompact but before PostCompact.
  6. `bridge-compaction.swift` — bridge state machine reaches
     `compactionPhase = "compacting"` on PreCompact SSE and resets
     on `turn.error`.

## Related

- Files this will touch:
  - `sidecar/src/app/api/chat/route.ts` — SSE compaction events
  - `sidecar/packages/runtime/src/sdk-runner.ts` — register hook callbacks
  - `macos/MARVIN/AppStatusBar.swift` — context indicator segment
  - `macos/MARVIN/Bridge.swift` — `marvinState = "compacting"` plumbing,
    cumulative cache-token field
  - `macos/MARVIN/ChatPreviewView.swift` — Scope-met nudge detection
  - `macos/MARVIN/ChatService.swift` — parse new SSE event type
  - `macos/MARVIN/BrainProfile.swift` — `compacting` profile (or alias)
  - `CLAUDE.md` — memory.md continuity paragraph
- Graphify nodes (after the next `/graphify .`): `AppStatusBar`,
  `MarvinBridge`, `ChatService.runTurn`, `runAgent` Options.hooks
- Supersedes / superseded by: none
- External references:
  - [Anthropic — Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
  - [Anthropic Cookbook — Context engineering](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
  - SDK type defs: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
    (search `PreCompactHookInput`, `SDKStatus`)
