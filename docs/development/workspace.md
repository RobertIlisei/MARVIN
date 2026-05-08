# Workspace layout

MARVIN is a pnpm monorepo with 1 macOS app, 1 sidecar (Next.js), and 7 sidecar-internal packages.

```
~/marvin/
├── macos/                              SwiftUI macOS app (Xcode / SPM)
│   ├── MARVIN/                         main app target
│   ├── MARVINLogic/                    pure-logic library
│   ├── MARVINTests/                    swift test target
│   ├── Package.swift                   SPM manifest
│   └── project.yml                     xcodegen manifest
├── sidecar/                            Next.js 16 · port 3030
│   ├── src/                            React UI + API routes
│   ├── packages/
│   │   ├── runtime/                    Agent SDK runner, auth, sessions, cost
│   │   ├── tools/                      Tool permission policy
│   │   ├── project-context/            Project docs / ADRs / memory injection
│   │   ├── graphify-bridge/            Knowledge-graph read + MCP server
│   │   ├── git-watch/                  Per-workDir commit detector
│   │   ├── git/                        Git execution + policy + porcelain parser
│   │   └── ui/                         shadcn primitives + `cn()` helper
│   ├── tests/                          end-to-end / cross-package tests
│   └── package.json
├── data/.marvin/                       (runtime-only, gitignored)
├── .claude/skills/                     Pinned Anthropic skills mirror
├── bin/marvin                          lifecycle script (start/stop/install-macos-app)
├── scripts/                            install / setup / sidecar-launcher
├── docs/                               (this directory)
├── graphify-out/                       MARVIN-on-MARVIN knowledge graph
├── README.md
├── CLAUDE.md                           project instructions for nested sessions
├── turbo.json                          turbo pipeline config
├── pnpm-workspace.yaml                 monorepo packages list
├── tsconfig.base.json                  TypeScript strict config
└── package.json
```

## Packages, by responsibility

### `sidecar/` — Next.js shell

The HTTP/SSE backend the SwiftUI app talks to (the original web UI shell was retired by [ADR-0021](../decisions/0021-webview-removal-fully-native-swift.md); the React surface remains for browser-based development and as the data layer the macOS app drives). Owns:

- **Pages + layout**: `src/app/page.tsx`, `src/app/layout.tsx` (includes the pre-paint theme bootstrap script).
- **API routes**: route handlers under `src/app/api/` — see [HTTP API](../reference/api.md).
- **Components**: `src/components/` — chat, brain, file tree, terminal, diff viewer, graph panel, preview pane, project picker, header controls.
- **Global CSS**: `src/app/globals.css` — theme cascade, component primitives (pill/kbd/eyebrow/timeline/status-rail), animations.

Depends on every `sidecar/packages/*`. Doesn't depend on anything else in the workspace.

### `sidecar/packages/runtime/`

The Agent SDK wrapper. Every chat turn goes through here.

| File | Responsibility |
|---|---|
| `sdk-runner.ts` | `runAgent()` — installs canUseTool, registers MCP servers, wires personality + context |
| `auth.ts` | `getAnthropicAuth()` — credential detection |
| `session.ts` | JSONL transcript append + replay |
| `cost-tracker.ts` | `~/.marvin/cost-tracker.json` append-on-turn, summaries |
| `projects.ts` | registry backed by `projects.json` + `active-project.json` |
| `models.ts` | `/v1/models` fetch + static fallback |
| `turn-registry.ts` | in-memory live-turn map (resume-safe) |
| `confirm-registry.ts` | pending-resolver map for `/api/confirm` |
| `claude-cli.ts` | `defaultModel()`, `discoverClaudeBinary()`, `timeoutMs()` |
| `personality.ts` | CORE_BEHAVIOR system prompt |
| `paths.ts` | `MARVIN_DATA_DIR` resolution |

Depends on `@anthropic-ai/claude-agent-sdk`, `@marvin/tools` (for policy), `@marvin/graphify-bridge` (for MCP server), no web deps. (Browser automation is no longer wired through an MCP server — see [browser tools in `personality.ts`](../../sidecar/packages/runtime/src/personality.ts) for the `npx playwright` shell-out pattern.)

### `sidecar/packages/tools/`

Thin policy-only package. One file:

- `policy.ts` — `toolPolicy()` classifier, auto-allow Bash patterns, hard-deny patterns.

Zero framework deps. Pure function over tool name + input.

### `sidecar/packages/project-context/`

What gets injected into the system prompt on the first message of each session.

| File | Responsibility |
|---|---|
| `index.ts` | `buildProjectContext()` — reads the `workDir`, stitches together docs + ADRs + memory + graph header |
| `workflow-health.ts` | Mode A/B/C audit detector for missing ADRs / memory / graph |
| `infra-probes.ts` | Project-agnostic probe primitives (opt-in per project) |

Depends on `@marvin/graphify-bridge` for the graph header read.

### `sidecar/packages/graphify-bridge/`

Bridge to the graphify knowledge-graph skill.

| File | Responsibility |
|---|---|
| `index.ts` | Re-exports |
| `read-graph.ts` | `resolveNode()`, `getNeighbors()`, `shortestPath()` — BFS helpers |
| `mcp-server.ts` | `createGraphMcpServer()` — in-process MCP server for the Agent SDK |
| `watchdog.ts` | Debounced AST refresh (default 10 min) on file changes |
| `refresh-docs.ts` | Semantic re-extraction for docs/papers (LLM-backed) |

### `sidecar/packages/git-watch/`

Per-workDir commit detector. Surfaces new commits inline in the chat stream. One file: `index.ts`. No MARVIN runtime dependencies beyond `node:child_process`.

### `sidecar/packages/git/`

Everything git-related that's NOT commit detection — the execution layer, argv guardrails, write-policy classifier, and porcelain v2 parser shared by every `/api/git/*` route.

| File | Responsibility |
|---|---|
| `exec.ts` | `runGit()` — single point of git invocation; sets `GIT_TERMINAL_PROMPT=0`, captures stderr classifier-ready |
| `argv-guards.ts` | argv allowlist; rejects flags MARVIN must never let through |
| `git-write-policy.ts` | `gitWritePolicy()` — auto / confirm / deny per op kind |
| `git-write-confirm-registry.ts` | session-scoped one-shot tokens for confirmed git mutations |
| `parse-porcelain-v2.ts` | structured parser for `git status --porcelain=v2` |

### `sidecar/packages/ui/`

Shared shadcn primitives (button, input, card, badge, separator, scroll-area, skeleton, dialog, sheet, tabs, select, tooltip, dropdown-menu, avatar, table) plus `cn()` helper in `utils.ts`.

Pure client-side React + Tailwind utilities. No runtime deps beyond React.

## Module boundaries

Rules enforced by structure (no import-linter rules yet, just convention):

- **`sidecar/src/` may import any `sidecar/packages/*`**.
- **`sidecar/packages/*` may import each other** by name, but avoid circular deps.
- **`sidecar/packages/tools/` imports nothing else from the workspace.** It's pure.
- **`sidecar/packages/runtime/` doesn't import `sidecar/src/`.** The browser doesn't exist as far as runtime is concerned.
- **No package imports `graphify-out/`** except `graphify-bridge` (it's the one that owns reading it).
- **`macos/` doesn't import anything from `sidecar/`.** The Swift app talks to the sidecar over HTTP/SSE on `localhost:3030` — no shared TS/Swift code, no codegen pipeline.

## Turbo pipeline

```json
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev":       { "cache": false, "persistent": true },
    "typecheck": { "dependsOn": ["^build"] },
    "clean":     { "cache": false }
  }
}
```

`^build` = "build all deps first." Needed for typecheck because the packages emit `.d.ts` files that downstream TS compilation reads.

No `lint` task — `next lint` was removed in Next 16 and MARVIN doesn't currently ship ESLint. See [Testing](./testing.md).

## Adding a new package

1. Create `sidecar/packages/<name>/` with its own `package.json`, `tsconfig.json`, `src/`.
2. The `sidecar/packages/*` glob in `pnpm-workspace.yaml` already covers it.
3. `pnpm install` in the repo root to hydrate symlinks.
4. Import as `@marvin/<name>` from anywhere in the workspace.

## Related

- [Local setup](./local-setup.md)
- [Testing](./testing.md)
- [Contributing](./contributing.md)
