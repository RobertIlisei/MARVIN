# HTTP API

All routes are Next.js route handlers under `apps/web/src/app/api/`. They run on `localhost:3030`. No auth layer — binding is localhost-only and treats every caller as the logged-in user.

Conventions:

- **Content-Type**: `application/json` unless noted (SSE streams use `text/event-stream`).
- **Errors**: `{ error: string }` with appropriate 4xx / 5xx status.
- **SSE events**: `event: <name>\ndata: <json>\n\n` framing.

## Chat

### `POST /api/chat`

Start a new turn. Streams the Agent SDK's events back as SSE.

**Request body:**

```json
{
  "message": "...",
  "cwd": "/absolute/path/to/project",
  "projectId": "optional-id",
  "marvinSessionId": "optional-uuid-for-continuing-a-session",
  "model": "claude-sonnet-4-6",
  "advisorModel": "claude-opus-4-7",
  "personality": "marvin",
  "permissionStrategy": "auto",
  "runtimeMode": "opus",
  "skipProjectContext": false
}
```

All fields except `message` are optional. Resolution for `model` / `advisorModel`: explicit body wins, then `resolveRuntimeMode(runtimeMode)`, then `defaultModel()` ([see advisor strategy](../concepts/advisor-strategy.md#resolution-order)).

**Response:** `text/event-stream` with events:

| Event | Payload | Fires when |
|---|---|---|
| `turn.started` | `{ turnId, model, advisorModel, marvinSessionId }` | Turn begins |
| `cli.event` | `{ event: <SDKMessage> }` | Every Agent SDK event — assistant content, tool calls, tool results |
| `confirm.request` | `{ turnId, toolUseId, toolName, input, reason }` | Gate intercepted an Edit / Write / Bash (gated mode only) |
| `turn.completed` | `{ sessionId, durationMs, costUsd, tokenUsage }` | Turn finished |
| `turn.error` | `{ error: string }` | Turn failed (exception, not a tool denial) |

SSE connection close does **not** cancel the turn — see [Sessions](../operations/sessions.md). Use `POST /api/chat/cancel` to abort explicitly.

### `POST /api/chat/cancel`

Abort an in-flight turn.

**Request body:** `{ marvinSessionId: string }`
**Response:** `{ ok: true }` or `{ ok: false, reason: "no active turn" }`

### `GET /api/chat/resume?marvinSessionId=…`

Reconnect an SSE stream to an already-running turn (e.g. after browser reload). Returns `204 No Content` when there's no live turn for that session — the client should fall back to the on-disk JSONL transcript.

## Confirm gate

### `POST /api/confirm`

Resolve a pending confirm card.

**Request body:** `{ turnId: string, toolCallId: string, decision: "allow" | "deny", denyMessage?: string }`
**Response:** `{ ok: true }` or `{ ok: false, reason: string }`

The server looks up the pending resolver in [`confirm-registry`](../../../packages/runtime/src/confirm-registry.ts) and resolves it — the SDK's `canUseTool` promise returns `{ behavior: decision, message: denyMessage }`.

## Projects

### `GET /api/projects`

List registered projects + active id.

**Response:** `{ projects: ProjectRecord[], active: string | null }` where

```ts
interface ProjectRecord {
  id: string;
  name: string;
  workDir: string;
  createdAt: string;
  lastUsedAt: string;
}
```

### `POST /api/projects`

Add a project.

**Request body:** `{ name: string, workDir: string }`
**Response:** `{ project: ProjectRecord }` or 400 with `{ error }` if path doesn't exist / isn't a directory.

### `DELETE /api/projects?id=…`

Remove a project from the registry. Does NOT delete any files.

**Response:** `{ ok: true }`

### `GET /api/projects/active`

Get the currently-selected project id.

**Response:** `{ active: string | null }`

### `PUT /api/projects/active`

Set the active project.

**Request body:** `{ id: string }`
**Response:** `{ active: string }`

### `GET /api/projects/verify?path=…`

Check whether a path would be a valid `workDir`. Called by the add-project dialog for live validation.

**Response:** `{ exists: boolean, isDirectory: boolean, readable: boolean, displayName: string | null }`

## Sessions

### `GET /api/sessions?projectId=…`

List saved session transcripts for a project, newest first.

**Response:**

```ts
{
  sessions: Array<{
    sessionId: string;
    firstUserTurn: string;  // truncated preview
    updatedAt: string;
    byteSize: number;
  }>
}
```

### `GET /api/sessions/[sessionId]?projectId=…`

Return the full JSONL transcript (parsed into an array).

**Response:** `{ record: SessionRecord }` where `SessionRecord.turns` is an array of `turn.user`, `cli.event`, `turn.completed`, `turn.error`, and `confirm.*` entries in timestamp order.

The chat-stream hook (`useChatStream.hydrateFromSession`) consumes this to rebuild the UI from history.

## Cost

### `GET /api/cost?projectId=…`

Aggregated spend for a project.

**Response:**

```ts
{
  today:    { costUsd, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, turns };
  week:     { /* same shape */ };
  lifetime: { /* same shape */ };
  daily:    Array<{ day: string /* YYYY-MM-DD */, costUsd, turns }>;  // last N active days
}
```

Returns zeroes for unknown `projectId` (safe default, not an error).

## Files

### `GET /api/files/tree?cwd=…&depth=…`

Project-scoped file tree walker.

**Response:** `{ root: string, tree: FsNode, truncated: boolean, count: number }`

- Default `depth: 6`, max `MAX_ENTRIES: 2000`.
- Ignores: `node_modules`, `.git`, `.next`, `venv`, `__pycache__`, `target`, `dist`, `build`, `coverage`, caches.

### `GET /api/files/content?cwd=…&path=…`

Read one file. Path must be inside `cwd` — `..` escapes are rejected.

**Response:** `{ path, size, binary, truncated, content }`

- 512 KB cap. Larger files return `truncated: true` with the first 512 KB.
- Binary detection via null-byte + non-printable heuristic. Binary files return `binary: true, content: ""`.

### `GET /api/files/status?cwd=…`

`git status --porcelain=v1` + current branch name, 5s per-call timeout.

**Response:** `{ isGit: boolean, branch: string | null, status: Record<absolutePath, porcelainCode> }`

Returns `{ isGit: false, status: {} }` outside a git work tree. Consumed by the file tree (dirty-file badges + branch pill) and the header's `<BranchBadge>`.

## Terminal

### `POST /api/terminal/run`

Spawn a shell command in the project `cwd`. Streams output as SSE.

**Request body:** `{ cwd: string, cmd: string }`

**SSE events:**

| Event | Payload |
|---|---|
| `started` | `{ cmd, startedAt }` |
| `stdout` | `{ data: string }` |
| `stderr` | `{ data: string }` |
| `exit` | `{ code: number \| null, signal: string \| null, durationMs: number }` |

- Spawns via `$SHELL -c`, so pipes, `&&`, env vars work.
- 10-minute cap. Request-abort kills the child.
- 8 KB `cmd` length cap.

Consumed by the embedded xterm.js terminal pane.

## Graph

### `POST /api/graph/query`

Query the active project's `graphify-out/graph.json`. Passthrough to [`@marvin/graphify-bridge`](../../../packages/graphify-bridge/).

**Request body:** `{ cwd: string, op: "summary" | "search" | "neighbors" | "path", args: {...} }`

Also accepts `GET /api/graph/query?cwd=…&op=…&q=…` for simple cases.

## Models

### `GET /api/models`

List available Claude models. Attempts Anthropic's `/v1/models` endpoint with whatever credentials are readable; falls back to a minimal static list when creds live in macOS Keychain.

**Response:**

```ts
{
  models: Array<{
    id: string;              // "claude-opus-4-7"
    displayName: string;     // "Claude Opus 4.7"
    tier: "opus" | "sonnet" | "haiku" | "other";
    createdAt: string | null;
    live: boolean;           // true if from the live API, false if from fallback
  }>;
  source: "anthropic-api" | "fallback";
  error: string | null;
  fetchedAt: string;
}
```

Consumed by the header's `<ModelPicker>`.

## Health

### `GET /api/health`

Runtime status + auth detection + defaults.

**Response:**

```ts
{
  ok: boolean;
  auth: {
    mode: "api-key" | "host-credentials" | "none";
    credentialHint: string | null;
    error: string | null;
  };
  claudeBinary: string | null;
  binaryError: string | null;
  defaultModel: string;       // `defaultModel()` return — the fallback, NOT the live model
  dataDir: string;            // resolved MARVIN_DATA_DIR, or default ~/.marvin/
}
```

**Note:** `defaultModel` is the fallback used only when `/api/chat` doesn't get an explicit model. It is **not** what any active turn is using. See [Health checks](../operations/health.md) for how to inspect the actual live model.

## Related

- [Session persistence](../operations/sessions.md) — how JSONL transcripts + resume work.
- [Confirm gate](../concepts/confirm-gate.md) — how `/api/confirm` integrates with the SDK's `canUseTool`.
- [Tool policy](../security/tool-policy.md) — what triggers a `confirm.request`.
