# MARVIN — project instructions

This is MARVIN, the pair-programming AI assistant. See [PLAN.md](./PLAN.md) for
the authoritative delivery plan. Update it as you ship things.

## Golden rules for working in this repo

1. **Single assistant, not an agent team.** MARVIN is one Claude session in a
   user-MARVIN loop. Do not reintroduce multi-agent dispatch, role catalogs,
   pipeline rules, or Kanban-as-source-of-truth. That pattern lived in the
   tombstoned J.A.R.V.I.S repo (`~/command_center/J.A.R.V.I.S/`) and is what
   MARVIN is the pivot away from.
2. **Plan-first, execute-second, verify-third.** Every feature has an entry in
   PLAN.md before code lands. Mark entries as `[done]` and add a brief "what
   shipped" note when complete.
3. **Confirm-before-act for risky tools.** `Edit`, `Write`, and non-read-only
   `Bash` calls render an in-chat confirm card. Pure reads (`Read`, `Grep`,
   `Glob`, `WebFetch`, `WebSearch`) are auto-allowed.
4. **The user's project is a separate workspace.** MARVIN's own code lives
   here in `~/marvin/`. The user's active project (the thing MARVIN is
   helping build) lives in its own directory chosen by the user at session
   start. MARVIN holds no persistent knowledge of past projects between
   sessions — starting a new project means starting from zero. Never cross-
   contaminate one project's context with another.
5. **No truncation of project context.** If the project includes context
   documents (`PROJECT_STATUS.md`, `BUSINESS_OVERVIEW.md`, `README.md`, etc.),
   they are injected whole. No hardcoded 6 KB cap — that was a lesson
   learned the hard way.
6. **No hardcoded project knowledge.** MARVIN must not ship assumptions
   about any specific project (service names, realm ids, stack choices,
   workflow). Every such assumption goes into the user's project repository,
   not into MARVIN's source.

## Repo layout

```
apps/web/                    # Next.js 16, port 3030
packages/
  runtime/                   # Claude CLI wrapper + auth + session + personality
  tools/                     # Bash, Edit, Write, Read, Grep, Glob, WebFetch, WebSearch
  project-context/           # spec + infra-probes injection
  graphify-bridge/           # knowledge-graph read + refresh
  git-watch/                 # commit stream
  ui/                        # shadcn primitives + MARVIN chat bubble, diff, file tree
data/.marvin/                # transcripts, cost tracker, graph cache (gitignored)
```

## Key files to reference when building

Ports originate from `~/command_center/J.A.R.V.I.S/src/`:

| Target in `~/marvin/` | Source in J.A.R.V.I.S |
|---|---|
| `packages/runtime/src/claude-cli.ts` | `lib/gateway/runtimes/claude-cli-runtime.ts` |
| `packages/runtime/src/auth.ts` | `lib/gateway/auth-manager.ts` |
| `packages/runtime/src/paths.ts` | `lib/paths.ts` (rename to `getMarvinDataDir`) |
| `packages/project-context/src/index.ts` | `lib/project-context.ts` (drop `contextAwareAgents`) |
| `packages/project-context/src/infra-probes.ts` | `lib/orchestrator/infra-probes.ts` |
| `packages/graphify-bridge/src/watchdog.ts` | `lib/orchestrator/graphify-watchdog.ts` |
| `packages/graphify-bridge/src/refresh-docs.ts` | `app/api/orchestrator/graphify-docs-refresh/route.ts` |
| `packages/git-watch/src/index.ts` | `lib/orchestrator/git-watchdog.ts` (strip board autonomy) |

## Data directory

`MARVIN_DATA_DIR` env var, default `~/.marvin/`. Stores:
- `sessions/<projectId>/<sessionId>.jsonl` — conversation transcripts
- `cost-tracker.json` — daily/weekly/lifetime spend
- `projects.json` — registered projects (id, name, workDir)
- Graph caches per project live next to the project (`<workDir>/graphify-out/`).

## Personality

MARVIN's persona is a style layer, not a refusal layer. Dry wit ("A login page.
How thrilling."), always delivers. Toggle lives in user settings:
`personality: "marvin" | "neutral"`.

## Adding a new feature

1. Open `PLAN.md`, find the phase it belongs to. Add a bullet under the phase
   if it isn't already scoped.
2. Implement.
3. Update the bullet with a `[done YYYY-MM-DD]` marker and a one-line summary.
4. If you discover a follow-up while building, add it to the same phase (or
   the appropriate later phase) — don't let it live only in your head.
