# ADR-0108 — Posture is per session, not per app

- **Status:** Accepted — implemented 2026-09-09
- **Date:** 2026-09-09
- **Related:** [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (one worktree per tab; the session meta that already records a posture), [ADR-0036](./0036-ask-agent-plan-modes.md) (Ask · Agent · Plan), [ADR-0033](./0033-advisor-registered-agent-per-role-effort.md) (advisor effort), [ADR-0021](./0021-webview-removal-fully-native-swift.md) (NativePrefs owns the pref family), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (two sessions, one tree)

## Context

The user, on 2026-09-09:

> *"i believe the agent mode: Plan / Agent / Ask are not session separated, i
> mean if i put agent on Plan in 1 session, the rest of the sessions will have
> the same mode"*

They are right, and it was not only the autonomy mode. Seven controls were
single app-wide values:

| Control | Where it was stored |
|---|---|
| Autonomy mode (Ask · Agent · Plan) | `marvin.mode` |
| Executor model | `marvin.model.executor` |
| Advisor model | `marvin.model.advisor` |
| Executor effort | `marvin.thinkingMode` |
| Advisor effort | `marvin.advisorThinkingMode` |
| Personality | `marvin.personality` |
| Permission gate (auto / gated) | `marvin.permissionStrategy` |

Each was one `UserDefaults` key, one field on the `MarvinBridge` singleton, and
one setter on `NativePrefs`. `ChatModeToolbar` and `ChatAgentsFooter` rendered
the singleton's value and wrote it back, so switching a tab to Plan switched
every open tab to Plan — visibly, since the other tabs' pickers re-rendered
with the new value — and the *next turn any of them sent* ran under it.

This was harmless when there was one chat surface. ADR-0107 made a new tab its
own git worktree by default, which is precisely the arrangement where the
controls must diverge: a tab planning a refactor in an isolated checkout wants
Plan and Opus at `max`; the tab answering questions about the codebase next to
it wants Ask and something cheap. Under one global they cannot both exist.

**The sidecar already had this right.** `SessionPosture` in `session-meta.ts`
records exactly these fields per session, written on every turn start so a
server-initiated resume can rebuild the turn under the posture it ran with. The
client was the half that had not caught up: it sent a posture per turn, the
server filed it per session, and then the client threw its own copy away.

## Decision

**A session's posture is per session. The app-wide values become the defaults a
new tab starts from.**

Three pieces:

1. **`SessionPosture` + `SessionPostureStore`** (`MARVINLogic/SessionPosture.swift`)
   — pure value types. The store is MRU-ordered and capped at 200 entries, so
   the eviction policy *is* the ordering rather than a second structure that can
   disagree with the first. Persisted as one JSON pref, `marvin.sessionPostures`;
   a corrupt or absent value decodes as empty rather than bricking a launch.

2. **`NativePrefs` keeps the seven scalar fields as DEFAULTS.** Every setter now
   writes the *active session's* posture and moves the matching default, so a
   change is scoped to the tab that made it and the next new tab inherits it.
   `posture(for:)` falls back to the defaults, which is what every session that
   predates this ADR gets.

3. **`MarvinBridge`'s posture fields describe the tab on screen.** They are the
   projection the views already read, so `ChatModeToolbar`, `ChatAgentsFooter`,
   `TopBarPopovers` and `AppStatusBar` needed no changes at all — they became
   session-aware by virtue of what the bridge now holds. `setActiveMarvinSession`
   applies the arriving session's posture, in the bridge rather than at the four
   call sites, because a tab switch that forgot to re-read the posture would
   silently run the next turn under the tab it just left.

**Hydration comes from the server's record.** `SessionWatchRow` gains `posture`,
read from the meta it already loads, so the cold-start snapshot the client
already fetches restores every open tab's posture in the same request — no
extra round-trip and no new route. A local record always outranks the server's:
the server's is history, the local one is what the user last chose here.

**Playwright stays app-wide.** The MCP browser server (ADR-0045) is in the
sidecar's posture record but is a machine-level opt-in, not a per-tab choice,
and it has no control on the chat toolbar. It keeps its single pref.

### Why the defaults are last-used rather than fixed

A fresh tab could start at a fixed Agent / auto / default-model posture instead.
Inheriting was chosen because the alternative fights the common case: a user who
has settled on Opus at `high` opens tabs all day and would have to re-pick every
time. The failure mode inheritance risks — opening a tab that is silently in Ask
and wondering why nothing is being written — is visible in the toolbar, which
shows the mode on every tab, and the value carried over is one the user
themselves chose moments earlier.

## Consequences

- Two tabs can run different models, efforts, voices, modes and gates at once.
- A tab restored after a relaunch comes back in the posture it was left in,
  from the local store, or from the sidecar's meta if this install never drove
  it.
- The About panel and the Skills pane's model row now show the selected
  session's model rather than a global. That is a behaviour change; it is also
  the correct answer to "what will the next turn use".
- The posture store is capped, so a user with hundreds of historical tabs keeps
  the 200 most recently touched. An evicted session falls back to the defaults
  on the client and to its server meta on the next snapshot.
- Nothing about the wire changed for the turn itself. The chat route already
  accepted all seven fields per request; it now receives per-tab values instead
  of seven copies of the same one.

## Scope of Done

- [x] `SessionPostureStore` resolves a session's posture, keeps sessions
      independent, promotes on write without duplicating, caps at 200 evicting
      the oldest, refuses an empty id, and round-trips through JSON with a
      corrupt value decoding as empty.
- [x] `SessionPostureWire.resolved(against:)` fills missing fields from the
      defaults, treats an empty model string as "not chosen", and leaves the
      two advisor fields nil rather than inheriting them.
- [x] A turn POSTs `posture(for:)` the sending tab, including the permission
      gate — which used to be read straight from `UserDefaults` to dodge
      `NativePrefs` staleness, a dodge the per-session record removes the need
      for.
- [x] `setActiveMarvinSession` applies the arriving session's posture, so the
      toolbar and the next turn agree with each other on every tab switch.
- [x] `GET /api/sessions/watch` carries each row's stored posture, and the
      client seeds only tabs it has no local record for.
- [x] `swift build` clean; 800 Swift assertions green.
