# Sessions — persistence + resume

Every MARVIN conversation is a **session**. Sessions have an id, a project, a transcript on disk, and a lifecycle that decouples from any single client connection (macOS app window or browser tab).

## Lifecycle

1. **Session starts** when the user sends the first message. The client generates a `marvinSessionId` (UUID) if not provided; the server accepts whatever the client sends.
2. **Turns append** to `~/.marvin/sessions/<projectId>/<marvinSessionId>.jsonl`. One event per line — `turn.user`, `cli.event`, `turn.completed`, `turn.error`.
3. **Session ends** when the user explicitly starts a new session (wordmark click / ⌘⇧N / "new session" button). The JSONL file stays — sessions are append-only and never auto-deleted.
4. **Resume** can happen any time by loading the JSONL back into the UI.

There is no "session closed" marker on disk. A session's end is implicit — it's just the last entry of the JSONL before the user moved on.

## The JSONL transcript

```jsonl
{"type":"turn.user","at":"2026-04-19T15:02:13.180Z","message":"add a logout button"}
{"type":"cli.event","at":"2026-04-19T15:02:14.020Z","event":{"type":"assistant","message":{...}}}
{"type":"cli.event","at":"2026-04-19T15:02:14.890Z","event":{"type":"tool_use","name":"Grep",...}}
{"type":"cli.event","at":"2026-04-19T15:02:15.410Z","event":{"type":"tool_result",...}}
{"type":"turn.completed","at":"2026-04-19T15:02:22.103Z","sessionId":"sess_abc","durationMs":8923,"costUsd":0.042,"tokenUsage":{...}}
{"type":"turn.user","at":"2026-04-19T15:03:01.440Z","message":"good, now wire it up to /api/logout"}
...
```

- **`type`** — the event kind. `turn.user` = user message arrived; `cli.event` = Agent SDK emitted an event; `turn.completed` = turn finished cleanly; `turn.error` = turn threw.
- **`at`** — ISO timestamp.
- **`event`** (for `cli.event`) — the raw `SDKMessage` from the Agent SDK, captured verbatim.
- **`sessionId`** (for `turn.completed`) — the *Claude* session id, distinct from `marvinSessionId`. Same Claude session id across the turns of one MARVIN session; a new Claude session id per MARVIN session.

JSONL is append-only. A single turn may contain many `cli.event` entries; a single MARVIN session typically contains 1-N turns.

## Decoupling turns from client connections

Closing the client mid-turn used to kill the Agent SDK run. No longer. [`turn-registry.ts`](../../sidecar/packages/runtime/src/turn-registry.ts) holds an in-memory map of live turns, keyed by `marvinSessionId`. Each entry has:

- The `AbortController` for the Agent SDK run.
- An `EventEmitter` the SSE endpoint pumps events to.
- An `ended: boolean` flag.

`/api/chat` detaches the SDK run from `req.signal`. Only an explicit `POST /api/chat/cancel` aborts. Closing the macOS app window (or a browser tab, in dev) just unsubscribes the HTTP listener — the turn continues in the background.

## Reconnecting to a live turn

`GET /api/chat/resume?marvinSessionId=…` lets a reconnecting client tail the same event bus:

- **Live turn exists** → server opens a new SSE stream against the registry's emitter. Client catches up with any buffered events + any new ones as they fire.
- **No live turn** → returns `204 No Content`. Client falls back to loading the on-disk JSONL via `GET /api/sessions/[sessionId]`.

The client's `useChatStream.attachLive()` runs on mount, silently trying to re-subscribe. Users reloading the client mid-turn don't need to do anything; MARVIN keeps going and the UI catches up.

## Hydrating from JSONL

`GET /api/sessions/[sessionId]?projectId=…` returns the full parsed transcript. `useChatStream.hydrateFromSession(record)` replays it into the UI:

1. Each `turn.user` becomes a user message.
2. Each `cli.event` (type `assistant`) becomes an assistant message.
3. Each `cli.event` (type `tool_use`) becomes a collapsible tool-call card.
4. Each `cli.event` (type `user` with `tool_result`) merges back into its corresponding tool-call card as the result.
5. `turn.completed` updates the stats (cost, tokens, duration).

The replay is a pure transform. No Agent SDK calls, no Anthropic calls, no cost. Just rebuilding UI state from a log.

## Session list

`GET /api/sessions?projectId=…` returns:

```ts
Array<{
  sessionId: string;
  firstUserTurn: string;   // preview, truncated
  updatedAt: string;
  byteSize: number;
}>
```

Newest first. Used by the project picker's sessions drawer.

## Storage cost

A typical chat turn produces 5-30 `cli.event` entries. A 20-turn session is ~0.5-5 MB of JSONL. Sessions accumulate indefinitely — no automatic rotation.

If you want to prune: `rm ~/.marvin/sessions/<projectId>/*.jsonl`. The registered projects list is untouched; MARVIN's next session starts fresh.

## Related

- [HTTP API → Chat](../reference/api.md#chat) — `/api/chat`, `/api/chat/cancel`, `/api/chat/resume`.
- [HTTP API → Sessions](../reference/api.md#sessions) — listing + hydrating.
- [Storage layout](../reference/storage.md)
- [`turn-registry.ts`](../../../sidecar/packages/runtime/src/turn-registry.ts)
- [`session.ts`](../../../sidecar/packages/runtime/src/session.ts)
