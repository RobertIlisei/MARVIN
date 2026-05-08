# Environment variables

All env vars are optional. MARVIN runs on any machine with sensible defaults.

### Credentials + model

The Settings panel ("Authentication" section) writes a UI-managed override to `~/.marvin/auth-config.json` (`0600`). When that file is present, it wins over every variable below. See [Credentials](../security/credentials.md) for the full resolution order and [`/api/auth/config`](./api.md#authentication) for the surface that manages it.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Direct Anthropic API key. Used unless `~/.marvin/auth-config.json` says otherwise. |
| `MARVIN_USE_HOST_CREDENTIALS` | `1` (auto) | Allow `getAnthropicAuth()` to auto-detect a prior `claude auth login`. Set to `0` to disable. Has no effect when `auth-config.json` exists. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Alternate credential form — some setups store the Claude CLI's token here. Auto-detected. |
| `MARVIN_MODEL` | `claude-opus-4-7` | Default model for `/api/chat` when no explicit `model` is sent. |
| `MARVIN_CLAUDE_BIN` | — | Absolute path to a specific Claude CLI binary. Overrides the `claude` resolver. |

### Runtime + paths

| Variable | Default | Meaning |
|---|---|---|
| `MARVIN_DATA_DIR` | `~/.marvin/` | Where sessions, cost tracker, projects registry, and attachments live. |
| `MARVIN_TIMEOUT_MS` | — | Per-turn timeout for the Agent SDK. Unset = no additional ceiling. |
| `MARVIN_RESULT_WATCHDOG_MS` | `5000` | How long after the SDK emits `result` before the runtime declares the turn dead. |
| `MARVIN_CONFIRM_TIMEOUT_MS` | `300000` (5 min) | Auto-deny window for a pending confirm card. `0` / negative / NaN disables. |
| `MARVIN_DESIGN_HOOKS` | `enforce` | Pre-tool design-rule enforcement level: `enforce` (deny on rule hit) / `measure` (log only) / `off`. |
| `MARVIN_TREE_MAX_DEPTH` | `10` | File-tree walker depth ceiling. Raise for absurdly deep monorepos; a non-Infinity ceiling is also a backstop against a broken `.gitignore`. |
| `MARVIN_TREE_MAX_ENTRIES` | `20000` | File-tree walker total-entry ceiling. |
| `SHELL` | user's login shell | Used by `/api/terminal/run` to spawn child processes (pipes + `&&` support). |
| `PORT` | `3030` | Next.js dev/start port. The whole project assumes 3030; changing is untested. |

### Graphify integration

| Variable | Default | Meaning |
|---|---|---|
| `GRAPHIFY_BIN` | `graphify` (PATH lookup) | Override the graphify CLI binary path. |
| `GRAPHIFY_REFRESH_MIN_INTERVAL_MS` | `600000` (10 min) | Debounce window for the AST-only refresh that fires when HEAD advances. |

### Find in Files

| Variable | Default | Meaning |
|---|---|---|
| `RG_PATH` | `rg` (PATH lookup) | Override the ripgrep binary path used by `/api/files/search`. |

### Honeycomb / OpenTelemetry

Per-project Honeycomb config can also live in `<cwd>/.marvin/honeycomb.json` (see [`/api/honeycomb/config`](./api.md#honeycomb-telemetry)). Env vars take precedence.

| Variable | Default | Meaning |
|---|---|---|
| `HONEYCOMB_API_KEY` | — | Honeycomb ingest key. |
| `HONEYCOMB_API_URL` | `https://api.honeycomb.io` | API host. Override to e.g. `https://api.eu1.honeycomb.io` for EU. |
| `HONEYCOMB_DATASET` | `marvin` | Dataset name. |
| `HONEYCOMB_ENVIRONMENT` | — | Environment name (Honeycomb classic). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | derived from `HONEYCOMB_API_URL` | Standard OTLP exporter endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | derived from `HONEYCOMB_API_KEY` | Standard OTLP headers (`x-honeycomb-team=…`). |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | OTLP wire format. |
| `OTEL_LOGS_EXPORTER` | `none` | OTel logs exporter — disabled by default. |
| `OTEL_METRICS_EXPORTER` | `none` | OTel metrics exporter — disabled by default. |
| `OTEL_RESOURCE_ATTRIBUTES` | derived | Resource attributes appended to spans (`service.name`, `service.version`, …). |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` when Honeycomb is configured | Forwarded to the Claude Agent SDK so its own telemetry joins the same trace. |

## Notes

- **Credentials**: if *both* `ANTHROPIC_API_KEY` and host credentials are present, the API key wins. See [Credentials](../security/credentials.md) for the full detection order.
- **Data dir**: MARVIN will auto-create subdirectories it needs (`sessions/<projectId>/`). You can safely delete `~/.marvin/` — on next boot MARVIN will recreate an empty structure. You'll lose registered projects, cost history, and session transcripts.
- **Playwright**: when a turn needs a browser, MARVIN shells out via `Bash` to `npx playwright`. Run `npx playwright install chromium` once per machine before that path is exercised.
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
