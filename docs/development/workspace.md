# Workspace layout

MARVIN is a pnpm monorepo with 1 app and 6 packages.

```
~/marvin/
├── apps/
│   └── web/                            Next.js 16 · port 3030
├── packages/
│   ├── runtime/                        Agent SDK runner, auth, sessions, cost
│   ├── tools/                          Tool permission policy
│   ├── project-context/                Project docs / ADRs / memory injection
│   ├── graphify-bridge/                Knowledge-graph read + MCP server
│   ├── git-watch/                      Per-workDir commit detector
│   └── ui/                             shadcn primitives + `cn()` helper
├── data/.marvin/                       (runtime-only, gitignored)
├── .claude/skills/                     Pinned Anthropic skills mirror
├── scripts/
│   └── install-skills.sh
├── docs/                               (this directory)
├── graphify-out/                       MARVIN-on-MARVIN knowledge graph
├── PLAN.md                             delivery plan + changelog
├── README.md
├── CLAUDE.md                           project instructions for nested sessions
├── turbo.json                          turbo pipeline config
├── pnpm-workspace.yaml                 monorepo packages list
├── tsconfig.base.json                  TypeScript strict config
└── package.json
```

## Packages, by responsibility

### `apps/web/` — Next.js shell

The user-facing surface. Owns:

- **Pages + layout**: `src/app/page.tsx`, `src/app/layout.tsx` (includes the pre-paint theme bootstrap script).
- **API routes**: 17 route handlers under `src/app/api/` — see [HTTP API](../reference/api.md).
- **Components**: `src/components/` — chat, brain, file tree, terminal, diff viewer, graph panel, preview pane, project picker, header controls.
- **Global CSS**: `src/app/globals.css` — theme cascade, component primitives (pill/kbd/eyebrow/timeline/status-rail), animations.

Depends on every `packages/*`. Doesn't depend on anything else in the workspace.

### `packages/runtime/`

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
| `playwright-mcp.ts` | `createPlaywrightMcpConfig()` — `marvin-playwright` stdio MCP |

Depends on `@anthropic-ai/claude-agent-sdk`, `@marvin/tools` (for policy), `@marvin/graphify-bridge` (for MCP server), no web deps.

### `packages/tools/`

Thin policy-only package. One file:

- `policy.ts` — `toolPolicy()` classifier, auto-allow Bash patterns, hard-deny patterns.

Zero framework deps. Pure function over tool name + input.

### `packages/project-context/`

What gets injected into the system prompt on the first message of each session.

| File | Responsibility |
|---|---|
| `index.ts` | `buildProjectContext()` — reads the `workDir`, stitches together docs + ADRs + memory + graph header |
| `workflow-health.ts` | Mode A/B/C audit detector for missing ADRs / memory / graph |
| `infra-probes.ts` | Project-agnostic probe primitives (opt-in per project) |

Depends on `@marvin/graphify-bridge` for the graph header read.

### `packages/graphify-bridge/`

Bridge to the graphify knowledge-graph skill.

| File | Responsibility |
|---|---|
| `index.ts` | Re-exports |
| `read-graph.ts` | `resolveNode()`, `getNeighbors()`, `shortestPath()` — BFS helpers |
| `mcp-server.ts` | `createGraphMcpServer()` — in-process MCP server for the Agent SDK |
| `watchdog.ts` | Debounced AST refresh (default 10 min) on file changes |
| `refresh-docs.ts` | Semantic re-extraction for docs/papers (LLM-backed) |

### `packages/git-watch/`

Per-workDir commit detector. Surfaces new commits inline in the chat stream. One file: `index.ts`. No MARVIN runtime dependencies beyond `node:child_process`.

### `packages/ui/`

Shared shadcn primitives (button, input, card, badge, separator, scroll-area, skeleton, dialog, sheet, tabs, select, tooltip, dropdown-menu, avatar, table) plus `cn()` helper in `utils.ts`.

Pure client-side React + Tailwind utilities. No runtime deps beyond React.

## Module boundaries

Rules enforced by structure (no import-linter rules yet, just convention):

- **`apps/web/` may import any `packages/*`**.
- **`packages/*` may import each other** by name, but avoid circular deps.
- **`packages/tools/` imports nothing else from the workspace.** It's pure.
- **`packages/runtime/` doesn't import `apps/web/`.** The browser doesn't exist as far as runtime is concerned.
- **No package imports `graphify-out/`** except `graphify-bridge` (it's the one that owns reading it).

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

1. Create `packages/<name>/` with its own `package.json`, `tsconfig.json`, `src/`.
2. Add to `pnpm-workspace.yaml` if not already covered by the glob.
3. `pnpm install` in the repo root to hydrate symlinks.
4. Import as `@marvin/<name>` from anywhere in the workspace.

## Related

- [Local setup](./local-setup.md)
- [Testing](./testing.md)
- [Contributing](./contributing.md)
