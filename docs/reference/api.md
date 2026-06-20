# HTTP API

All routes are Next.js route handlers under `sidecar/src/app/api/`. They run on `localhost:3030`. No auth layer — binding is localhost-only and treats every caller as the logged-in user.

Conventions:

- **Content-Type**: `application/json` unless noted (SSE streams use `text/event-stream`).
- **Errors**: `{ error: string }` with appropriate 4xx / 5xx status.
- **SSE events**: `event: <name>\ndata: <json>\n\n` framing.
- **CSRF guard on every mutating route**: `POST` / `DELETE` / `PUT` / `PATCH` handlers require the header `X-Marvin-Client: 1`. Without it the route returns `403 csrf-guard` without executing. The header forces a CORS preflight so a drive-by tab at another origin cannot trigger the request. `GET` routes are not gated — cross-origin reads are blocked by SOP. Client code should use the `marvinFetch` wrapper in `sidecar/src/lib/csrf.ts`, which attaches the header automatically on mutating methods. ADR-0009 originally established this for multipart uploads; the universal enforcement is the generalisation.

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

### `GET /api/chat/announce?projectId=…`

Always-on SSE the client holds open for the whole time a project is loaded (ADR-0043). Emits `announce.attached` on connect, then a `turn.registered` `{ marvinSessionId, projectId, turnId, startedAt }` event for **every** turn registered in that project — including server-initiated ones (background-job completion, ADR-0038; timed wakeups, ADR-0031). An idle client that holds no live stream uses this to learn a turn it didn't start has begun and re-attach via `/api/chat/resume`, so the result renders without a session switch. A ~25 s heartbeat keeps the connection warm; read-only — it never starts/cancels/mutates a turn.

## Confirm gate

### `POST /api/confirm`

Resolve a pending confirm card.

**Request body:** `{ turnId: string, toolCallId: string, decision: "allow" | "deny", denyMessage?: string }`
**Response:** `{ ok: true }` or `{ ok: false, reason: string }`

The server looks up the pending resolver in [`confirm-registry`](../../../sidecar/packages/runtime/src/confirm-registry.ts) and resolves it — the SDK's `canUseTool` promise returns `{ behavior: decision, message: denyMessage }`.

For an **AskUserQuestion** decision (ADR-0040) the `allow` reply carries `updatedInput` (the `{ answers, questions }` the user chose) which becomes the tool result. Such confirms register with **no** auto-deny timeout — a decision waits for the human (fixed in v0.1.40; the 5-min default used to silently deny a slow decision).

## Backlog

The project backlog (ADR-0044) — actionable deferred work parked under `<workDir>/.marvin/backlog/`. All verbs delegate to the shared `backlog.ts` store, the same code the `marvin-backlog` MCP tool writes through. Mutating verbs are CSRF-guarded and validate `workDir` against the registered-project set.

### `GET /api/backlog?workDir=…&status=…`

List backlog items, optionally filtered by `status` (`open` | `doing` | `done` | `dismissed`). **Response:** `{ workDir, items: BacklogItem[] }`.

### `POST /api/backlog`

Add an item (manual UI add — the model path is the MCP tool). **Body:** `{ workDir, title, body?, severity? }`. **Response:** `{ ok: true, item, created }` or `400 { error }`.

### `PATCH /api/backlog/[id]`

Set an item's status (`done` / `dismissed` / `doing` / `open`). **Body:** `{ workDir, status, note? }`. **Response:** `{ ok: true, item }` or `404`.

### `POST /api/backlog/promote-issue`

Optional export — file an item as a GitHub issue via `gh` (needs an `origin` remote). The backlog stays the source of truth. **Body:** `{ workDir, id }`. **Response:** `{ ok: true, url }` or `409` (no remote) / `502` (gh failed).

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

## Audit

### `GET /api/audit/auto?cwd=…&limit=…`

Returns the tail of `<cwd>/.marvin/auto-audit.jsonl` — one entry per
auto-allowed mutating tool call (Edit / Write / Bash) under the
`auto` permission strategy. Surfaced in the Settings panel so users
can review what MARVIN actually ran without prompting them.

Read-only Read / Grep / Glob / WebFetch / WebSearch are deliberately
**not** logged — they have no audit value and would drown the file.
Hard-denied calls (the `BASH_HARD_DENY` regex set) are also absent
because they never reach the log path.

**Query params:**

- `cwd` (required) — absolute path to the project root. Sandboxed
  through `checkFsPath`; same rules as every other file route.
- `limit` — newest-N to return. Default `50`, hard cap `500`.

**Response:**

```ts
{
  entries: Array<{
    at: string;          // ISO-8601 timestamp
    tool: "Edit" | "Write" | "Bash";
    reason: string;      // why the gate auto-allowed (regex match label, etc.)
    descriptor: string;  // short, redacted descriptor — first 200 chars of the command / file path
    turnId: string;      // correlate to the chat transcript
    toolUseId: string;   // SDK tool-use id
  }>;  // newest-first
}
```

**Errors:**

- `400 missing-cwd` — `cwd` query param absent or empty.
- `400 <fs-sandbox error code>` — `cwd` failed `checkFsPath` (e.g.
  `cwd-not-absolute`, `not-found`, `not-a-directory`).

Implementation: [`sidecar/src/app/api/audit/auto/route.ts`](../../sidecar/src/app/api/audit/auto/route.ts);
the writer lives at [`sidecar/packages/runtime/src/auto-audit.ts`](../../sidecar/packages/runtime/src/auto-audit.ts).
See [ADR-0015](../decisions/0015-auto-mode-policy-floor-and-audit-log.md)
for the policy rationale.

## Files

All file routes share a single path sandbox: `checkFsPath` in [`sidecar/packages/runtime/src/fs-sandbox.ts`](../../sidecar/packages/runtime/src/fs-sandbox.ts). Paths outside `cwd`, symlinks (target or ancestor), paths containing NUL, and paths longer than 1024 bytes are rejected before I/O. See [ADR-0008](../decisions/0008-user-initiated-write-channel.md). The ignore list lives in [`sidecar/packages/tools/src/fs-constants.ts`](../../sidecar/packages/tools/src/fs-constants.ts) and is shared with the user-initiated write policy (M2).

### `GET /api/files/tree?cwd=…&depth=…`

Project-scoped file tree walker.

**Response:** `{ root: string, tree: FsNode, truncated: boolean, count: number }`

- Default `depth: 6`, max `MAX_ENTRIES: 2000`.
- Ignores: the shared `IGNORE_DIR_NAMES` set — `node_modules`, `.git`, `.next`, `.turbo`, `venv`, `__pycache__`, `target`, `dist`, `build`, `coverage`, `.DS_Store`, caches, `vendor`.
- Symlinks are skipped during the walk (matches the sandbox's reject-by-default policy for read routes).

### `GET /api/files/content?cwd=…&path=…`

Read one file. Path must be inside `cwd`; symlinks are rejected.

**Response:** `{ path, size, mtime, maxSize, binary, truncated, content }`

- 4 MB cap (`maxSize`). Larger files return `truncated: true` with the first 4 MB of content — the editor mounts these read-only so the user can scan the prefix without risking a save that would overwrite the tail of the real file.
- Binary detection via null-byte + non-printable heuristic on the sampled prefix. Binary files return `binary: true, content: null`.
- `mtime` (`fs.stat.mtimeMs`) is the CAS token for subsequent `/api/files/write/save` requests.
- Error codes returned via `{ error: "<sandbox-error-code>" }`: `404 not-found`, `400 path-escapes-cwd | symlink-rejected | symlink-escapes-cwd | is-directory`, `500 io-error`.

### `GET /api/files/status?cwd=…`

`git status --porcelain=v1` + current branch name, 5s per-call timeout.

**Response:** `{ isGit: boolean, branch: string | null, status: Record<absolutePath, porcelainCode> }`

Returns `{ isGit: false, status: {} }` outside a git work tree *or* when the sandbox check on `cwd` fails. Consumed by the file tree (dirty-file badges + branch pill) and the header's `<BranchBadge>`.

### `GET /api/files/raw?cwd=…&path=…`

Stream the raw bytes of a sandbox'd file with a best-effort `Content-Type` header. Used by the binary-file preview (images, PDFs) embedded in the file viewer. Text files should use `/api/files/content` instead so the editor gets the binary + truncation metadata in JSON.

**Caps:** 10 MB. Larger payloads return `413 too-large` rather than streaming gigabytes through the handler.

### `GET /api/files/search?cwd=&q=&caseSensitive?=&wholeWord?=&useRegex?=&include?=`

Ripgrep-backed full-text search across the project. ripgrep honours `.gitignore` / `.ignore`, so results exclude `node_modules`, `dist`, etc. automatically. Optional `include` is a comma-separated glob list forwarded as `--glob` flags (e.g. `*.ts,*.tsx` or `src/**`).

**Response:** `{ results: [{ file, matches: [{ line, col, text }] }], truncated }`

**Caps:** 500 matching files, 50 matches per file, 10 s timeout.

Consumed by the macOS app's Find in Files sidebar tab (`FindInFilesView`) — see ADR-0021 milestone M2.

### `POST /api/files/reveal`

Reveal a file or directory in the OS file browser:

- macOS: `open -R <path>` (Finder)
- Linux: `xdg-open <parentDir>` (no portable "select" recipe; opens the parent directory as the pragmatic fallback)
- Windows: `explorer /select,<path>`

Not a write channel — doesn't mutate files — but it spawns a subprocess against a user-supplied path, so it still gates on `checkFsPath` and passes the canonical path as a positional argv entry (no shell interpolation).

**Request body:** `{ cwd: string, path: string }`
**Response:** `{ ok: true }` on success, `{ error: string }` otherwise.

## Files — write channel

User-initiated write endpoints under `/api/files/write/*`. Parallel to the LLM write channel (`canUseTool` + `toolPolicy`): paths go through the shared sandbox (`checkFsPath`), ops go through `fsWritePolicy`, and `confirm`-classified ops require an `X-Marvin-Confirmed: <token>` header minted by `/api/files/write/confirm`. See [ADR-0008](../decisions/0008-user-initiated-write-channel.md).

**Shared error codes** (all `POST` bodies are JSON; all responses are JSON):

| Status | Body shape | Meaning |
|---|---|---|
| `400` | `{ error: "<code>" }` | Bad request or sandbox rejection (`path-escapes-cwd`, `symlink-rejected`, `path-contains-null`, `path-too-long`, `is-directory`, `not-a-directory`). |
| `403` | `{ error: "policy-deny", reason }` | `fsWritePolicy` denied (deny-list segment, project-root, oversize). |
| `404` | `{ error: "not-found" \| "parent-not-found" }` | Required path missing. |
| `409` | `{ error: "needs-confirm", reason, severity, tokenError? }` | Policy returned `confirm` without a valid token. |
| `409` | `{ error: "exists" }` | Create / rename target already exists (no implicit overwrite). |
| `409` | `{ error: "stale", currentMtime, size }` | Save CAS: on-disk mtime differs from `expectedMtime`. |
| `409` | `{ error: "collisions", collisions: string[] }` | Move: at least one destination exists; whole batch aborted. |
| `500` | `{ error: "io-error", detail }` | Unexpected OS error. |

### `POST /api/files/write/confirm`

Mint a one-shot token for a `confirm`-classified op. Tokens are scoped to the exact op+cwd, expire in 60 s, and are consumed on first use.

**Request body:** `{ cwd: string, op: FsWriteOp }`

**Response (confirm required):** `{ needsConfirm: true, reason, severity: "warn"|"danger", token, expiresIn: 60 }`

**Response (policy auto-classified):** `{ needsConfirm: false, reason }` — caller can run the op directly without a token.

**Response (policy deny):** `403 { error: "policy-deny", reason }`.

### `POST /api/files/write/create`

Create a new file or empty directory.

**Request body:** `{ cwd, path, kind: "file"|"dir", content?: string, overwrite?: boolean }`

- `kind: "file"`: writes UTF-8 `content` (default `""`). Uses `wx` flag unless `overwrite: true`.
- `kind: "dir"`: `fs.mkdir` non-recursive; parents must exist.

**Response:** `{ ok: true, path }` or an error code above.

### `POST /api/files/write/save`

Save an edit to an existing file. Supports optimistic-concurrency via `expectedMtime`.

**Request body:** `{ cwd, path, content, expectedMtime?: number }`

- Caps content at 5 MB (`WRITE_SIZE_MAX_BYTES` in `fs-write-policy.ts`); larger payloads 403.
- On mtime mismatch returns `409 stale` with `currentMtime` so the UI can surface the conflict.

**Response:** `{ ok: true, path, mtime, size }`.

### `POST /api/files/write/rename`

Rename a file or directory. Case-only renames on APFS/HFS+ are a `confirm` class (the operation otherwise no-ops silently).

**Request body:** `{ cwd, from, to }` — `to` must not already exist unless it's a case-only collision that was confirmed.

**Response:** `{ ok: true, from, to }`.

### `POST /api/files/write/move`

Move one or more files/dirs into a destination directory. Batched for multi-select DnD. Pre-flights all collisions; aborts the whole batch on any collision.

**Request body:** `{ cwd, from: string[], to: string }`

**Response:** `{ ok: true, moved: Array<{ from, to }> }`.

### `POST /api/files/write/delete`

Delete one or more files/dirs.

**Request body:** `{ cwd, paths: string[], mode: "trash"|"permanent" }`

- `mode: "trash"` → routes through the `trash` npm package (macOS Trash / Windows Recycle Bin / XDG trash). Auto-classified (reversible).
- `mode: "permanent"` → `fs.rm({ recursive: true, force: false })`. Always `confirm danger`; always requires a fresh token.

**Response:** `{ ok: true, deleted: string[], mode }`.

### `POST /api/files/write/upload`

OS → tree file upload via multipart. Used by drag-and-drop from Finder onto the tree root or a directory. See [ADR-0009](../decisions/0009-file-uploads-from-os.md).

**Request** (`multipart/form-data`):

- `cwd` — project root (form field).
- `destDir` — destination directory path (form field).
- `file` — one or more file parts.
- **Required header: `X-Marvin-Client: 1`** — forces a CORS preflight so cross-origin drive-by POSTs are blocked by the browser before reaching the route. Without it the route returns `400 missing-x-marvin-client`. Non-negotiable; see ADR-0009.

**Caps:** 50 files per batch · 10 MB per file · 50 MB total batch.

**Response:** `{ ok: true, uploaded: Array<{ name, path, bytes }>, skipped: Array<{ name, reason }>, destDir }`.

Over-cap or policy-rejected files appear in `skipped[]` with a human-readable reason; the rest of the batch still lands. Secret-bearing files (`.env*`, keys) are skipped rather than prompted — users who want to upload one should drag it alone or paste via New File + save.

## Source control

Git is MARVIN's **third mutation channel** — parallel to the LLM tool channel and the user-initiated filesystem channel. Every mutating route runs `checkFsPath(cwd)` → `gitWritePolicy(op)` → (on `confirm` class) require `X-Marvin-Confirmed: <token>` minted by `/api/git/confirm`. See [ADR-0012](../decisions/0012-source-control-mutation-channel.md).

Every git invocation goes through [`runGit`](../../sidecar/packages/git/src/exec.ts) (`execFile` with `shell: false`); user-supplied refs / paths / remotes pass through [`argv-guards`](../../sidecar/packages/git/src/argv-guards.ts) before appending to argv; commit messages travel via stdin, never argv.

**Read routes:**

### `GET /api/git/status?cwd=…`

Branch metadata + per-file status, parsed from `git status --porcelain=v2 --branch -z`.

Success: `{ enabled: true, branch: { oid, name, upstream, ahead, behind }, files: Array<{ path, indexStatus, workingStatus, entryType, renamedFrom, ordinary }> }`.

`enabled: false, reason: "not-a-git-repo"` when the path isn't inside a git worktree. `oid`, `name`, `upstream`, `ahead`, `behind` are all nullable (`null` for initial repos, detached HEAD, no upstream). `entryType` is one of `ordinary | rename-copy | unmerged | untracked | ignored`. `indexStatus` / `workingStatus` are single-char porcelain-v2 codes (`M A D R C U T .`).

**Caching:** responses carry a weak `ETag` derived from the raw porcelain bytes. Clients that send `If-None-Match: <etag>` receive a `304 Not Modified` with an empty body when nothing structural has changed — the 2 s panel poll uses this to avoid re-parsing / re-rendering on an idle tree. Note: porcelain v2 is content-agnostic on the working tree, so unstaged content changes within a file that's already in the list don't invalidate the ETag; the panel picks them up when the file's bucket changes (stage / unstage / save-to-disk transitions).

### `GET /api/git/diff?cwd=&path=&mode=working|staged|head`

Per-file diff. Default `mode=working`. 2 MB cap on response body; larger returns `truncated: true` with empty `diff`.

Success: `{ path, mode, diff: string, binary: boolean, truncated: boolean }`.

Binary files return `binary: true` with `diff: ""`. Path is rejected with `400 invalid-pathspec` if it fails `isSafePathspec` (leading `-`, NUL, magic `:` prefix).

### `GET /api/git/branch?cwd=…`

Success: `{ enabled: true, current: string | null, locals: Array<{ name, isCurrent, upstream, ahead, behind }>, remotes: string[] }`.

Formatted from `git for-each-ref` using `%00`-separated field strings so branch names containing `|` / tabs / unicode parse cleanly.

### `GET /api/git/log?cwd=&limit=50&path?=`

Recent commits. Default `limit=50`, hard cap 500. Optional `path` filters to commits touching that file.

Success: `{ enabled: true, commits: Array<{ sha, shortSha, author, email, date, subject }> }`.

Initial repos (no commits yet) return `commits: []` rather than an error.

**Mutation routes:**

Every mutation route goes through `checkFsPath(cwd)` → `gitWritePolicy(op)`. If the policy returns `confirm`, the route returns `409 needs-confirm` with `{ severity, reason, op }`; the client round-trips to `/api/git/confirm` for a token and replays the original request with `X-Marvin-Confirmed: <token>`. Tokens are one-shot and validate the op structurally — the stored op must match the executing op or the replay is rejected with `409 token-rejected`.

### `POST /api/git/stage` — `{ cwd, paths: string[] }`

`git add -- <paths>`. Every path passes `isSafePathspec` (rejects leading `-`, pathspec-magic `:`, NUL, oversize). Auto-class.

Success: `{ ok: true, staged: number }`.

### `POST /api/git/unstage` — `{ cwd, paths: string[] }`

`git restore --staged -- <paths>`. Working tree unchanged. Auto-class.

Success: `{ ok: true, unstaged: number }`.

### `POST /api/git/discard` — `{ cwd, paths: string[], mode: "working" | "staged" }`

- `mode: "staged"` — `git restore --staged` (auto). Same effect as unstage.
- `mode: "working"` — `git restore` (confirm **warn**). Resets working tree to index; edits are gone.

Success: `{ ok: true, discarded: number, mode }`.

### `POST /api/git/commit` — `{ cwd, message, amend?: boolean }`

Message travels via stdin (`git commit -F -`). Never via argv. `isSafeCommitMessage` rejects empty / NUL / > 16 KB. The route detects `hasPushedHead` by `rev-parse @{u}` + `merge-base --is-ancestor HEAD @{u}`; amend with `hasPushedHead: true` is `confirm danger`.

Amending with no new message passes `--no-edit` so git keeps the existing message.

Success: `{ ok: true, amend, hasPushedHead }`. `409 nothing-to-commit` when the index is empty and `--amend` wasn't set.

### `POST /api/git/branch/create` — `{ cwd, name, from?: string }`

`git branch <name> <from>`. `from` defaults to `HEAD`. `name` and `from` (unless `HEAD`) must pass `isSafeRef`. Auto-class.

Success: `{ ok: true, name, from }`. `409 branch-exists` when the branch is already present.

### `POST /api/git/branch/switch` — `{ cwd, name }`

`git switch <name>`. The route probes `git status --porcelain`; non-empty output denies as `policy-deny` with reason "working tree is dirty". v1 does not stash-on-switch.

Success: `{ ok: true, name }`. `404 branch-not-found` when the target doesn't exist.

### `POST /api/git/branch/delete` — `{ cwd, name, force?: boolean }`

`git branch -d <name>` (or `-D` when `force: true` or when the branch is unmerged). The route probes `git symbolic-ref HEAD` + `git branch --merged` to populate the policy op. Current branch is hard-denied; unmerged is `confirm danger`.

Success: `{ ok: true, name, merged, forced }`.

### `POST /api/git/confirm` — `{ cwd, op }`

Mints a one-shot token for a `confirm`-class op. Returns `{ token, expiresIn: 60, severity, reason }`. Rejects with `400 policy-auto` when the op doesn't actually need confirming, and `403 policy-deny` when the op is always-denied.

**Remote routes (ADR-0013):**

Credentials are inherited from the user's git configuration — MARVIN never stores, proxies, or prompts. `GIT_TERMINAL_PROMPT=0` turns any interactive credential prompt into immediate stderr. See [`sidecar/src/lib/git-remote-errors.ts`](../../sidecar/src/lib/git-remote-errors.ts) for the stderr classifier.

### `POST /api/git/fetch` — `{ cwd, remote?: string }`

`git fetch <remote>`. Default `remote = "origin"`. Auto-class.

Success: `{ ok: true, remote, note }` (`note` is the trimmed progress output on stderr).

### `POST /api/git/pull` — `{ cwd, strategy: "ff-only" | "rebase" | "merge" }`

- `ff-only` (auto): `git pull --ff-only`. Fails cleanly on divergence.
- `rebase` (confirm warn): `git pull --rebase`.
- `merge` (confirm warn): `git pull --no-rebase --no-ff`.

Refuses on a dirty working tree with `409 dirty-working-tree`.

Success: `{ ok: true, strategy, note }`.

### `POST /api/git/push` — `{ cwd, remote?, branch?, forceWithLease?: boolean }`

Default `remote = "origin"`, `branch = <current>`, `forceWithLease = false`. Plain `--force` is never available — the policy layer hard-denies it from every channel. `--force-with-lease` is `confirm danger`. A regular push when upstream is ahead is `confirm warn`.

Success: `{ ok: true, remote, branch, forced, note }`.

**Remote error taxonomy** (returned from all three routes on failure):

| HTTP | `error` | Meaning | `remedy` |
|---|---|---|---|
| 502 | `auth-publickey` | SSH key rejected | check your SSH key is loaded and authorised |
| 502 | `auth-failed` | HTTPS auth failed or no credentials | configure a git credential helper |
| 502 | `network` | Could not resolve host / timeout / refused | check network connectivity |
| 409 | `non-fast-forward` | Push rejected, upstream has commits you don't | pull first or push --force-with-lease |
| 409 | `no-upstream` | No upstream configured | `git push -u <remote> <branch>` in the terminal |
| 409 | `merge-conflict` | Pull produced conflicts | resolve in editor, stage, commit (or `git merge --abort`) |
| 409 | `dirty-working-tree` | Pull refused — tree not clean | commit or discard changes first |
| 409 | `detached-head` | Push refused — not on a branch | check out a branch before pushing |
| 502 | `no-remote` | Remote URL not reachable | check `git remote -v` |
| 502 | `git-failed` | Unclassified git error | inspect stderr |

Every remote-error response includes `stderr` (raw git output) and `remedy` (one-line hint) alongside `error`.

**Errors:**

| HTTP | Error | Meaning |
|---|---|---|
| 400 | `not-a-git-repo` | `.git/` not found at or above `cwd`. |
| 400 | `invalid-ref` / `invalid-remote` / `invalid-pathspec` | Argv-guard rejected the input. |
| 403 | `policy-deny` | `gitWritePolicy` returned `deny`. Body carries `{ reason }`. |
| 409 | `needs-confirm` | `gitWritePolicy` returned `confirm`. Body carries `{ severity, reason, op }`. Client mints a token via `/confirm` then retries with `X-Marvin-Confirmed`. |
| 409 | `token-mismatch` | Token was minted for a different op or cwd. |
| 409 | `token-expired` | Token older than 60 s. |
| 502 | `git-exit-nonzero` | git exited non-zero; body carries `{ exitCode, stderr }`. |
| 504 | `git-timeout` | Operation exceeded 10 s (60 s cap). |

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

Query the active project's `graphify-out/graph.json`. Passthrough to [`@marvin/graphify-bridge`](../../sidecar/packages/graphify-bridge/).

**Request body:** `{ cwd: string, op: "summary" | "search" | "neighbors" | "path", args: {...} }`

### `GET /api/graph/query?cwd=&op=&q=&hops?=&from?=&to?=&limit?=`

Same passthrough, exposed as a GET so simple queries (search-by-label, single-node neighbors) can be hit without a body. The query-string form is what the macOS app's Symbol Search (⌘⇧T, ADR-0021 milestone M3) uses.

### `GET /api/graph/html?cwd=…`

Returns the project's pre-rendered `graphify-out/graph.html` as raw HTML for an `<iframe>` mount. Cached for 60 s; the graph itself is regenerated by `/graphify . --update`, not per-turn.

The HTML is served with a strict CSP (sandbox attribute + `frame-src 'self'` only) because the `graph.html` file lives inside the user's repo and a malicious PR could in principle land injected JS that hits MARVIN's same-origin API. See the route source for the full layered mitigation.

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

## Authentication

UI-managed Anthropic credential mode for the Settings panel ("Authentication" section). The choice persists at `~/.marvin/auth-config.json` (file mode `0600`) and overrides every env-var path; see [Credentials](../security/credentials.md) for the full resolution chain. The raw key only travels in the `POST` body; every `GET` returns a redacted form (last-4 only).

### `GET /api/auth/config`

Returns the current config and the resolver's effective decision.

**Response:**

```ts
{
  config: {
    mode: "cli" | "api-key" | null;        // null = no file (default)
    keyHint: string | null;                 // "…wxyz" when api-key + key
    savedAt: string | null;                 // ISO timestamp of last write
    path: string;                           // absolute path of the config file
  };
  file: {
    exists: boolean;
    mode: number | null;                    // POSIX permission bits (0o600 expected)
  };
  effective: {                              // what getAnthropicAuth() will return
    mode: "host-credentials" | "api-key" | "oauth" | "none";
    credentialHint: string | null;
    error: string | null;
  };
}
```

### `POST /api/auth/config`

Persist a mode change (and optional key).

**Request body:**

```ts
{
  mode: "cli" | "api-key";
  apiKey?: string;       // required when mode === "api-key"; trimmed
}
```

**Response:** same shape as the `GET` payload, reflecting the new state.

**Errors:**

| Status | Body | Meaning |
|---|---|---|
| `400` | `{ "error": "mode must be 'cli' or 'api-key'" }` | Missing or unknown mode |
| `400` | `{ "error": "apiKey is required when mode is api-key" }` | mode=api-key without a key |
| `413` | `{ "error": "body too large" }` | `Content-Length` over 8 KB |

### `DELETE /api/auth/config`

Remove the config file. Resolution falls back to the env-var chain, then host credentials.

**Response:** same shape as `GET`, plus `removed: boolean` (false when the file didn't exist).

## Honeycomb (telemetry)

Per-project Honeycomb configuration for OpenTelemetry export. The raw API key only travels in a `POST` body; every `GET` returns the redacted form. Files are written with `0600` permissions to `<cwd>/.marvin/honeycomb.json`. Resolution precedence (highest first): `HONEYCOMB_*` env vars, per-`cwd` file, global `~/.marvin/honeycomb.json`. See [`honeycomb-config.ts`](../../sidecar/packages/runtime/src/honeycomb-config.ts) for the storage layout.

### `GET /api/honeycomb/config?cwd=…`

Masked status for the UI — answers "is Honeycomb configured for this project, and where is the config coming from?" without leaking the key.

**Response:** `{ status: "env" | "workdir" | "global" | "none", apiUrl, environment, dataset, keyHint }` where `keyHint` is the last 4 chars of the key.

### `POST /api/honeycomb/config`

Write `<cwd>/.marvin/honeycomb.json`.

**Request body:** `{ cwd: string, apiKey: string, apiUrl?: string, environment?: string, dataset?: string }`
**Response:** `{ ok: true }` on success.

### `DELETE /api/honeycomb/config?cwd=…`

Remove the per-project config file. Global config (and env vars) are unaffected.

**Response:** `{ ok: true }`.

### `POST /api/honeycomb/test`

Verify a Honeycomb config by hitting Honeycomb's `/1/auth` endpoint. Returns the team slug + environment so the UI can confirm the user keyed in the right credentials without leaving MARVIN.

Two modes:

- **Saved:** `{ cwd }` — resolves config via env → workdir → global precedence. `404` if nothing is configured.
- **Ad-hoc:** `{ cwd, apiKey, apiUrl?, environment? }` — tests the provided credentials without writing anything.

**Region fallback:** if the first attempt 401s on the default US cluster, the route retries the EU cluster (`api.eu1.honeycomb.io`). On EU success the response includes `regionFallback: true` and `suggestedApiUrl` so the UI can offer a one-click fix. Most Honeycomb 401s are region mismatches, not bad keys.

## Related

- [Session persistence](../operations/sessions.md) — how JSONL transcripts + resume work.
- [Confirm gate](../concepts/confirm-gate.md) — how `/api/confirm` integrates with the SDK's `canUseTool`.
- [Tool policy](../security/tool-policy.md) — what triggers a `confirm.request`.
