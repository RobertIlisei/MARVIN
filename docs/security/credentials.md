# Credentials

MARVIN needs an **API key** to function. Two providers are supported, chosen in the macOS app under Settings → Authentication:

| Provider | Key | Billed to |
|---|---|---|
| **Anthropic** | an API key from the [Claude Console](https://platform.claude.com/) | your Anthropic Console account |
| **OpenRouter** | an [OpenRouter](https://openrouter.ai) API key | your OpenRouter credits |

With OpenRouter, MARVIN points the Claude CLI at a local proxy (`/api/proxy/openrouter`) that forwards Anthropic-format requests to OpenRouter's Anthropic-compatible endpoint, and every model id is OpenRouter's (`anthropic/claude-sonnet-4.5`, …) — see [ADR-0096](../decisions/0096-provider-aware-model-resolution.md). Claude models through OpenRouter are the supported configuration; other models are reachable but Anthropic does not support routing Claude Code to non-Claude models, and OpenRouter warns they may not work.

## Not supported: a Claude.ai subscription login

MARVIN is built on the Claude Agent SDK. Anthropic's authentication and credential-use policy ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), February 2026) states that OAuth sign-in with a Free, Pro, Max, Team or Enterprise plan is intended exclusively for Claude Code and Anthropic's own applications, that products built on the Agent SDK must use API key authentication, and that third-party developers may not route requests through Free, Pro or Max credentials on behalf of their users or intermediate Claude.ai session tokens. Anthropic enforces this server-side.

So `claude login` is not a credential for MARVIN. Use an API key. Older versions of these docs described auto-detecting a Claude CLI login; that detection still exists in the code as a legacy path, is undocumented here, and is not supported — set `MARVIN_USE_HOST_CREDENTIALS=0` if you want to make sure it never triggers.

## Resolution order

[`getAnthropicAuth()`](../../sidecar/packages/runtime/src/auth.ts) runs on every turn. First hit wins.

1. **Settings → Authentication**, persisted at `~/.marvin/auth-config.json` (file mode `0600`) with `provider: "anthropic" | "openrouter"` and the key. The raw key is **never** returned by `GET /api/auth/config` — only a last-four hint. API: [`/api/auth/config`](../reference/api.md#authentication).
2. **Environment: `ANTHROPIC_API_KEY`.** An Anthropic Console key. Detected as `mode: "api-key"`.
3. **Nothing.** `mode: "none"`; `/api/health` returns `ok: false` and MARVIN won't take turns until a key is set.

## Inspecting the current mode

```bash
curl -s http://localhost:3030/api/health | jq .auth
```

```json
{
  "mode": "api-key" | "none",
  "credentialHint": "…4f2a",
  "error": null
}
```

## What MARVIN never does with credentials

- **Never logs them.** The raw key appears in no session transcript, cost-tracker entry, or persisted file.
- **Never sends them to third parties.** An Anthropic key goes only to Anthropic; an OpenRouter key goes only to OpenRouter. No analytics, no telemetry.
- **Never mixes them across sessions.** Each turn re-runs `getAnthropicAuth()`; rotate a key between turn N and N+1 and turn N+1 uses the new one.

## Security-sensitive env handling

If the key comes from the environment it sits in `process.env.ANTHROPIC_API_KEY` for the lifetime of the Node process. Standard guidance applies:

- Don't commit `.env` files with keys. The repo's `.gitignore` blocks `.env*`.
- Rotate keys on machine compromise.
- Prefer Settings → Authentication (a `0600` file) or a shell-scoped secret manager (`pass`, `envchain`, 1Password CLI) over `~/.zshrc`.

## Related

- [`auth.ts` source](../../sidecar/packages/runtime/src/auth.ts)
- [Env vars](../reference/env-vars.md)
- [Health checks](../operations/health.md)
- [Data flow](./data-flow.md) — what leaves your machine.
