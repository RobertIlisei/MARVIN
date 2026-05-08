# Health checks

One endpoint: `GET /api/health`. One snapshot of "can MARVIN take a turn right now."

## What it checks

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
  defaultModel: string;
  dataDir: string;
}
```

`ok: true` iff:

- `auth.mode !== "none"` — credentials detectable. See [Credentials](../security/credentials.md).
- `claudeBinary` resolvable — Claude CLI binary exists. Not *required* for the Agent SDK to work (the SDK is its own dependency), but MARVIN's CLI fallback path uses it, and its presence is a good signal that the host setup is sane.
- `dataDir` writable — MARVIN can write to `~/.marvin/` (or `MARVIN_DATA_DIR`).

## What `defaultModel` is

The value that `defaultModel()` in [`claude-cli.ts`](../../../sidecar/packages/runtime/src/claude-cli.ts) returns — `MARVIN_MODEL` env var, or else `claude-opus-4-7`.

**It is NOT the model any active turn is using.** A live turn's model is determined by the chat body's `model` / `advisorModel` fields, which the browser picker supplies. See [Advisor strategy → resolution order](../concepts/advisor-strategy.md#resolution-order).

Renamed from `model` → `defaultModel` on 2026-04-19 after user feedback that the old name implied "the live model." If you're scripting against this endpoint and reading the old `model` field, update to `defaultModel`.

## Typical outputs

**Happy path (API key set):**

```json
{
  "ok": true,
  "auth": { "mode": "api-key", "credentialHint": "env ANTHROPIC_API_KEY", "error": null },
  "claudeBinary": "/opt/homebrew/bin/claude",
  "binaryError": null,
  "defaultModel": "claude-opus-4-7",
  "dataDir": "/Users/you/.marvin"
}
```

**Happy path (macOS Keychain):**

```json
{
  "ok": true,
  "auth": {
    "mode": "host-credentials",
    "credentialHint": "~/.claude (CLI-managed · auto-detected)",
    "error": null
  },
  "claudeBinary": "/opt/homebrew/bin/claude",
  "binaryError": null,
  "defaultModel": "claude-opus-4-7",
  "dataDir": "/Users/you/.marvin"
}
```

`/api/models` on this machine will return fallback list — see [Credentials → macOS Keychain caveat](../security/credentials.md#macos-keychain-caveat).

**No credentials:**

```json
{
  "ok": false,
  "auth": { "mode": "none", "credentialHint": null, "error": null },
  "claudeBinary": "/opt/homebrew/bin/claude",
  "binaryError": null,
  "defaultModel": "claude-opus-4-7",
  "dataDir": "/Users/you/.marvin"
}
```

Fix: set `ANTHROPIC_API_KEY` or run `claude auth login`.

## What it does NOT check

- **Internet connectivity to Anthropic.** The endpoint doesn't round-trip to the API (no cost, no auth burn). If the internet is down, `/api/health` still reports `ok: true` — the failure shows up only when you try to send a turn.
- **Playwright availability.** Chromium install status isn't probed. If Playwright is missing, browser-automation turns (`npx playwright …` shell-outs) will fail at execution time — but `/api/health` won't flag it ahead of time.
- **Graph health.** Whether a project has `graphify-out/graph.json` isn't checked. That's per-project and varies.

## Monitoring

Because MARVIN is a local tool, there's no production health-check story. For local monitoring:

```bash
watch -n 5 'curl -s http://localhost:3030/api/health | jq ".ok"'
```

If you ever deploy MARVIN somewhere non-local (why?), point your uptime checker at `/api/health` and alert on `ok: false`.

## Related

- [Credentials](../security/credentials.md)
- [Env vars](../reference/env-vars.md)
- [HTTP API → Health](../reference/api.md#get-apihealth)
