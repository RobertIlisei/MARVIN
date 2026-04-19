# Credentials

MARVIN needs Claude API access to function. It supports three credential forms, auto-detected in priority order, with a `MARVIN_USE_HOST_CREDENTIALS` kill switch.

## Detection order

[`getAnthropicAuth()`](../../../packages/runtime/src/auth.ts) walks this list on every turn. First hit wins.

1. **Environment: `ANTHROPIC_API_KEY`.** Direct API key. Detected as `mode: "api-key"`.
2. **Environment: `CLAUDE_CODE_OAUTH_TOKEN`.** Alternate token form that some Claude Code installs store in the environment. Detected as `mode: "host-credentials"` with hint "env `CLAUDE_CODE_OAUTH_TOKEN`".
3. **Linux / Windows: `~/.claude/.credentials.json` or `~/.claude/auth.json`.** Cross-platform storage for the Claude CLI. Detected as `mode: "host-credentials"` with hint "`~/.claude` (CLI-managed · auto-detected)".
4. **macOS: recent activity in `~/Library/Application Support/claude-cli/history.jsonl`.** The CLI's actual credentials live in the macOS Keychain (see caveat below), but the history file proves a `claude auth login` ran. Detected as `mode: "host-credentials"`.
5. **Nothing.** Detected as `mode: "none"`. `/api/health` returns `ok: false`. MARVIN won't take turns until this is fixed.

## macOS Keychain caveat

On macOS, `claude auth login` stores the token in the Keychain. The token is NOT directly readable from Node.js (or any non-Apple-keychain-aware process). Consequences:

- MARVIN can **authenticate turns** through the Agent SDK because the SDK shells out to the Claude CLI, which *can* read its own Keychain entry.
- MARVIN **cannot list live models** via `/v1/models` because that's a direct HTTP call, not an SDK call. The [`/api/models`](../reference/api.md#get-apimodels) endpoint falls back to a static list and surfaces a warning: *"host-credentials token lives in the OS keychain and isn't readable by MARVIN; using fallback list."*

Two ways to get the live model list on macOS:

1. Set `ANTHROPIC_API_KEY` directly in your shell profile. MARVIN detects it first, reads it, uses it for the live `/v1/models` call.
2. Live with the fallback. It's a 4-model static list (Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5) — usable, just doesn't reflect any new models Anthropic ships.

## Disabling host-credential detection

Set `MARVIN_USE_HOST_CREDENTIALS=0`. MARVIN will only look at `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, never the filesystem. Useful when:

- Running on a machine with shared home directory + multiple users.
- Testing MARVIN's behavior without credentials.
- CI environments where the agent should fail loud rather than picking up stale tokens.

## Inspecting the current mode

```bash
curl -s http://localhost:3030/api/health | jq .auth
```

Returns:

```json
{
  "mode": "api-key" | "host-credentials" | "none",
  "credentialHint": "string describing which source was hit",
  "error": "non-null only if detection threw"
}
```

## What MARVIN never does with credentials

- **Never logs them.** Neither the raw key nor the OAuth token appear in session transcripts, cost-tracker entries, or any persisted file.
- **Never sends them to third parties.** Every credential use is a direct Anthropic API call. No analytics, no telemetry.
- **Never writes them.** MARVIN reads credentials; it doesn't create them. `claude auth login` is the only way to set up host credentials, and that happens through the Claude CLI.
- **Never mixes them across sessions.** Each turn re-runs `getAnthropicAuth()` — if the user rotates a key between turn N and N+1, turn N+1 picks up the new key immediately.

## Security-sensitive env handling

If an API key is set, it sits in `process.env.ANTHROPIC_API_KEY` for the lifetime of the Node process. Standard sec guidance applies:

- Don't commit `.env` files with keys. The `.gitignore` in the repo blocks `.env*` by default.
- Rotate keys on machine compromise.
- Consider using a shell-scoped secret manager (`pass`, `envchain`, 1Password CLI) to inject the key only for MARVIN's process rather than keeping it in `~/.zshrc`.

## Related

- [`auth.ts` source](../../../packages/runtime/src/auth.ts)
- [Env vars](../reference/env-vars.md)
- [Health checks](../operations/health.md)
- [Data flow](./data-flow.md) — what leaves your machine.
