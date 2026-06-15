# Storage layout

Everything MARVIN keeps, where, and why.

## Two buckets

- **User-scoped** — `~/.marvin/` (configurable via `MARVIN_DATA_DIR`). Cross-project plumbing. Never contains project content.
- **Per-project** — `<workDir>/…`. Lives inside the user's own repo, travels with `git`.

Plus browser `localStorage` for UI preferences.

## User-scoped: `~/.marvin/`

```
~/.marvin/
├── projects.json            registry of known projects
├── active-project.json      currently-selected project id
├── cost-tracker.json        append-on-turn spend ledger
├── attachments/             chat-attached files (per-project subdirs)
├── auth-config.json         (optional, 0600) UI-managed Anthropic auth — see /api/auth/config
├── honeycomb.json           (optional) global Honeycomb config — see /api/honeycomb/config
└── sessions/
    └── <projectId>/
        └── <sessionId>.jsonl   one event per line
```

### `projects.json`

```json
{
  "projects": [
    {
      "id": "users-you-code-marvin",
      "name": "MARVIN dev",
      "workDir": "/Users/you/code/marvin",
      "createdAt": "2026-04-17T20:54:52.839Z",
      "lastUsedAt": "2026-04-19T15:02:13.180Z"
    }
  ]
}
```

Managed by [`sidecar/packages/runtime/src/projects.ts`](../../../sidecar/packages/runtime/src/projects.ts). Edits: `/api/projects` POST/DELETE. IDs are derived from `workDir` via `slugifyWorkDir()` — stable across reinstalls if the path doesn't change.

### `active-project.json`

```json
{ "active": "users-you-code-marvin" }
```

Single-entry file. Written on `PUT /api/projects/active`.

### `attachments/`

Chat-attached files, organised under `<projectId>/`. Populated by `/api/files/write/upload` when the user drops a file into the chat input; referenced by SDKMessage tool-result blocks. Cleaned up when a session ends. Not user-editable.

### `honeycomb.json` (optional)

Global Honeycomb / OTLP config. Per-project config at `<workDir>/.marvin/honeycomb.json` takes precedence; env vars take precedence over that. Created via `POST /api/honeycomb/config`; deleted via `DELETE /api/honeycomb/config`. File mode is `0600`. Schema: `{ apiKey, apiUrl?, environment?, dataset? }`.

### `cost-tracker.json`

Append-on-turn ledger.

```json
{
  "entries": [
    {
      "at": "2026-04-18T07:31:24.589Z",
      "projectId": "users-you-code-marvin",
      "costUsd": 0.124451,
      "inputTokens": 6,
      "outputTokens": 7,
      "cacheCreationTokens": 18415,
      "cacheReadTokens": 17497
    }
  ]
}
```

Aggregated per-project by [`cost-tracker.ts`](../../../sidecar/packages/runtime/src/cost-tracker.ts) into today / 7d / lifetime summaries for `/api/cost`. Deleting this file resets the meter without breaking anything else.

### `sessions/<projectId>/<sessionId>.jsonl`

One JSON object per line. One file per MARVIN session.

```jsonl
{"type":"turn.user","at":"…","message":"…"}
{"type":"cli.event","at":"…","event":{…}}
{"type":"cli.event","at":"…","event":{…}}
{"type":"turn.completed","at":"…","sessionId":"…","durationMs":12345,"costUsd":0.04,"tokenUsage":{…}}
```

Consumed by:

- `GET /api/sessions` (list)
- `GET /api/sessions/[sessionId]` (hydrate into the UI)
- `useChatStream.hydrateFromSession()` on the client

Session transcripts accumulate forever. No automatic rotation or pruning. Delete any you don't want; MARVIN doesn't notice.

## Per-project: `<workDir>/`

```
<workDir>/
├── docs/adr/NNNN-*.md       Architecture Decision Records  (checked in)
├── .marvin/
│   ├── memory.md            durable-facts INDEX (ADR-0042)  (checked in)
│   ├── memory/<slug>.md     one file per durable fact       (checked in)
│   ├── plans/<slug>.md      saved Plan-mode plans           (checked in)
│   └── session-notes.md     Scope-met chip activity sink    (checked in)
└── graphify-out/            knowledge graph
    ├── graph.json                        checked in
    ├── knowledge/graph.json              checked in (ADR/doc/memory index)
    ├── graph.html                        checked in
    ├── GRAPH_REPORT.md                   checked in
    ├── manifest.json                     checked in
    ├── cost.json                         checked in (cumulative LLM cost)
    ├── cache/                            gitignored
    └── .graphify_python                  gitignored (interpreter pointer)
```

`.marvin/memory.md` is a one-line-per-fact index; details live in
`.marvin/memory/`. It's written only through the `remember` tool — see
[ADRs + memory](../concepts/memory-and-adrs.md) and
[ADR-0042](../decisions/0042-memory-as-durable-facts.md).

See [ADRs + memory](../concepts/memory-and-adrs.md) for the ADR + memory layers. See [Graphify integration](../concepts/graphify-integration.md) for the graph layer.

The three `.gitignore` entries MARVIN expects to see in a user project:

```
graphify-out/cache/
graphify-out/.graphify_python
.marvin/  # optional — if the user wants memory local-only
```

If the user wants `.marvin/memory.md` to travel with the code (recommended, see [isolation contract](../concepts/isolation-contract.md)), they should NOT gitignore `.marvin/`.

## Browser `localStorage`

Everything the UI needs to remember across reloads. Used for things that don't need to round-trip the server.

| Key | Type | Default | Source |
|---|---|---|---|
| `marvin-theme` | `"dark" \| "light"` | absent (→ light) | [`theme-toggle.tsx`](../../../sidecar/src/components/settings/theme-toggle.tsx) |
| `marvin.permissionStrategy` | `"auto" \| "gated"` | `"auto"` | `<PermissionToggle>` |
| `marvin.personality` | `"marvin" \| "neutral"` | `"marvin"` | `<PersonalityToggle>` |
| `marvin.runtimeMode` | `"opus" \| "advisor"` (legacy) | `"opus"` | older `<RuntimeModeToggle>` |
| `marvin.executorModel` | model id | unset | `<ModelPicker>` |
| `marvin.advisorModel` | model id | unset | `<ModelPicker>` |
| `marvin.previewUrl.<projectId>` | URL string | unset | `<PreviewPane>` |
| `marvin.term.history` | `string[]` (cap 100) | `[]` | xterm history |
| `panel:marvin-shell` | panel sizes | set by lib | `react-resizable-panels` autosave |

All writes are guarded with try/catch — if `localStorage` throws (quota, disabled), the UI degrades to in-memory.

## What gets checked in vs gitignored

**Gitignored** (in MARVIN's own repo):

```
node_modules/
.next/
.turbo/
dist/
*.tsbuildinfo
data/.marvin/            ← MARVIN's runtime data never lives in the repo
.env*
graphify-out/            ← per-project regenerable graph artefacts
.DS_Store
.vscode/
.idea/
*.log
.claude/settings.local.json
macos/.build/            ← Swift SPM build cache
macos/build-spm/         ← SPM-mirror .app stage
```

**Checked in** (surprising but intentional): the entire `.claude/skills/` bundle. Per [Quickstart](../getting-started/quickstart.md), `scripts/install-skills.sh` copies from this bundle into `~/.claude/skills/`. The install is idempotent and only falls back to a GitHub fetch when a skill is missing from the pinned bundle.

## Resetting / uninstalling

| Goal | How |
|---|---|
| Clear session transcripts | `rm -rf ~/.marvin/sessions/` |
| Reset cost ledger | `rm ~/.marvin/cost-tracker.json` |
| Remove a project | `DELETE /api/projects?id=…` (files stay; registry only) |
| Full reset | `rm -rf ~/.marvin/` (MARVIN recreates on boot; UI prefs survive in `localStorage`) |
| Full wipe (including UI prefs) | above, plus `localStorage.clear()` in the browser devtools |

## Related

- [ADRs + memory](../concepts/memory-and-adrs.md) — per-project state.
- [Isolation contract](../concepts/isolation-contract.md) — why user + project data are separated.
- [Sessions](../operations/sessions.md) — how the JSONL transcripts get written and replayed.
- [Cost tracking](../operations/cost-tracking.md) — how the ledger is summarized.
