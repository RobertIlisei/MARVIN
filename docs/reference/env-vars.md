# Environment variables

All env vars are optional. MARVIN runs on any machine with sensible defaults.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Direct Anthropic API key. When set, wins over host-credentials. |
| `MARVIN_USE_HOST_CREDENTIALS` | `1` (auto) | Allow `getAnthropicAuth()` to auto-detect a prior `claude auth login`. Set to `0` to disable. |
| `MARVIN_DATA_DIR` | `~/.marvin/` | Where sessions, cost tracker, projects registry, and user config live. |
| `MARVIN_MODEL` | `claude-opus-4-7` | Default model for `/api/chat` when no explicit `model` is sent. |
| `MARVIN_TIMEOUT_MS` | — | Per-turn timeout for the Agent SDK. Unset = no additional ceiling. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Alternate credential form — some setups store the Claude CLI's token here. Auto-detected. |
| `SHELL` | user's login shell | Used by `/api/terminal/run` to spawn child processes (pipes + `&&` support). |
| `PORT` | `3030` | Next.js dev/start port. The whole project assumes 3030; changing is untested. |

## Notes

- **Credentials**: if *both* `ANTHROPIC_API_KEY` and host credentials are present, the API key wins. See [Credentials](../security/credentials.md) for the full detection order.
- **Data dir**: MARVIN will auto-create subdirectories it needs (`sessions/<projectId>/`). You can safely delete `~/.marvin/` — on next boot MARVIN will recreate an empty structure. You'll lose registered projects, cost history, and session transcripts.
- **Playwright**: MARVIN no longer registers a Playwright MCP server (it leaked subprocesses on long sessions). When a turn needs a browser, MARVIN shells out via `Bash` — run `npx playwright install chromium` once per machine before that path is exercised.
- **Port 3030**: hardcoded in `sidecar/package.json` scripts and in `/api/health` display. Not currently configurable via env.

## Per-session (not env)

Not env vars, but worth mentioning — these are per-request fields on `/api/chat` that the browser persists to `localStorage`:

| localStorage key | Meaning | Default |
|---|---|---|
| `marvin-theme` | `"dark"` or `"light"`, absence = system preference | unset (→ light) |
| `marvin.permissionStrategy` | `"auto"` or `"gated"` | `"auto"` |
| `marvin.personality` | `"marvin"` or `"neutral"` | `"marvin"` |
| `marvin.runtimeMode` | legacy binary `"opus"` / `"advisor"` toggle | `"opus"` |
| `marvin.executorModel` | explicit executor pick (wins over runtimeMode) | unset |
| `marvin.advisorModel` | explicit advisor pick | unset |
| `marvin.previewUrl.<projectId>` | per-project preview URL for the iframe pane | unset |
| `marvin.term.history` | xterm command history, capped at 100 entries | `[]` |

See [Storage layout](./storage.md) for the full picture.

## Related

- [Credentials](../security/credentials.md) — auth detection detail.
- [Storage layout](./storage.md) — file + localStorage catalog.
- [`sidecar/packages/runtime/src/claude-cli.ts`](../../../sidecar/packages/runtime/src/claude-cli.ts) — `defaultModel()` + `timeoutMs()`.
