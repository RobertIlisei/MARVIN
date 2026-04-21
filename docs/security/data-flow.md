# Data flow

What leaves your machine when MARVIN runs. Short answer: only API calls to Anthropic.

## Network boundaries

```
  your browser ─── HTTP/SSE ──▶ Next.js on localhost:3030  (same machine)
                                         │
                                         ├── fs reads/writes    (same machine)
                                         ├── git invocations    (same machine)
                                         ├── shell commands     (same machine, your user)
                                         ├── marvin-playwright  (same machine, optional)
                                         │
                                         └─── HTTPS ───▶ api.anthropic.com
```

- **Browser ↔ Next.js**: same machine, loopback only. Nothing leaves the box.
- **Next.js ↔ filesystem / git / shell**: same machine, your user, your permissions.
- **Next.js ↔ Anthropic API**: the one external boundary. HTTPS, standard TLS. Request payloads are whatever the Agent SDK sends — prompts, tool calls, tool results.

## What's in the Anthropic payload

Every chat turn sends:

- **System prompt** — MARVIN's `personality.ts` CORE_BEHAVIOR, plus the project context block built by `buildProjectContext()` on the first message.
- **Conversation history** — all prior user + assistant messages in the current session.
- **Tool call payloads** — when MARVIN calls `Edit(file_path, old_string, new_string)`, the payload includes those strings verbatim.
- **Tool results** — the outputs of `Read`, `Grep`, `Bash`, etc. flow back into the model context, which means they flow back in subsequent turns too.

What this means in practice:

- **If you grep for an API key** in a tool call, that API key is now in your Anthropic session history.
- **If MARVIN reads a `.env` file**, the contents are in the session. The hard-deny policy blocks most `.env` reads without explicit intent, but it's not airtight — if the user's message literally says "read the .env", MARVIN will oblige.
- **Tool results are part of the billable context.** That's why [cost tracking](../operations/cost-tracking.md) separates `inputTokens` from `cacheReadTokens` — the reads are cache-hit-friendly once they're in history.

## What does NOT go to Anthropic

- **Session transcripts** after they're written to `~/.marvin/sessions/`. The JSONL is for your own replay + debugging.
- **Cost tracker ledger.** Aggregate only. Never uploaded anywhere.
- **Registered projects list.** `projects.json` is local.
- **`localStorage` UI preferences.** Theme, personality, permission strategy, executor/advisor picks — all local.
- **Files that MARVIN *hasn't been asked to read*.** MARVIN's not pre-indexing your disk.

## What does NOT go anywhere at all

- **No analytics.** No page views, no session timings, no feature-usage pings.
- **No telemetry.** No crash reporting.
- **No MARVIN servers.** There is no "MARVIN HQ" that accumulates your data. The project has no backend of its own.

If you block `api.anthropic.com` in your firewall, MARVIN fails loud (every turn errors). If you block anything else, nothing breaks — there's nothing else outbound.

## What about MCP servers?

- **`marvin-graph`**: in-process. Reads `<workDir>/graphify-out/graph.json` on your disk. No network.
- **`marvin-playwright`** (optional): drives a local Chromium. The browser *itself* makes HTTP requests (to whatever URL MARVIN navigates to — usually `http://localhost:3000` or your dev server). MARVIN doesn't route that traffic through itself, but those pages can of course reach the internet.

## What about the graphify knowledge graph?

Graphify is a **local** tool. Graph construction for code uses deterministic AST extraction (no network). Graph construction for docs/papers uses LLM calls — those go to Anthropic, same channel as MARVIN's own turns.

MARVIN runs graphify on your project when you run `/graphify .` in that project's directory. The graph itself ends up in `<workDir>/graphify-out/` — on your disk, checked into git if you want it there.

## Sensitive data handling

Rules of thumb:

- **Secrets in code** (API keys, tokens, `.env` content) — if MARVIN reads them, they're in the Anthropic session. Hard-deny covers common cases; if you work with secrets, use `.env*` files (gitignored + hard-denied by default) and reference them via `process.env.*` in code MARVIN can see safely.
- **PII in data files** — same rule. If MARVIN reads a CSV with customer records, that data flows through Anthropic. For production datasets, do the work offline or use a scratch fixture.
- **IP-sensitive codebases** — depends on your organization's policy on Anthropic. MARVIN is Anthropic-flavored at its core; you cannot use MARVIN without sending content to api.anthropic.com.

## Git credentials are inherited, never handled

The Source Control panel's push / pull / fetch routes ([ADR-0013](../decisions/0013-git-remote-ops-and-credentials.md)) spawn `git` with the user's env and `GIT_TERMINAL_PROMPT=0`. Credential helpers configured in the user's `~/.gitconfig` (osxkeychain, gh auth, 1password-cli) answer out-of-band; SSH keys are served by the user's ssh-agent via the inherited `SSH_AUTH_SOCK`. MARVIN itself never:

- stores credentials (no PATs, SSH keys, or tokens in MARVIN's data dir);
- prompts for credentials in the UI (no password dialog, no "paste token here" field);
- proxies credentials (no writing to `child.stdin` on remote routes; `commit -F -` is the only stdin-using git path);
- rewrites remote URLs to carry credentials (`https://user:token@host/...` is never constructed — if a remote URL already has creds, that's the user's own config, not something MARVIN introduces).

If a remote op fails because no credential helper is configured, `git` exits with readable stderr; MARVIN's `RemoteErrorBanner` classifies it (`auth-publickey`, `auth-failed`, `no-upstream`, …) and shows a one-line remedy. The fix is always in the user's shell — configure a credential helper, load an SSH key, set an upstream. None of those fixes touch MARVIN.

See [ADR-0013](../decisions/0013-git-remote-ops-and-credentials.md) for why this is the right trade-off — the shapes we considered (in-app prompt, PAT in settings) would reclassify MARVIN as a credential manager, with different supply-chain and threat-model obligations.

## Related

- [Credentials](./credentials.md) — auth flow.
- [Tool policy](./tool-policy.md) — what MARVIN auto-allows vs confirms vs hard-denies.
- [Storage layout](../reference/storage.md) — where local data lives.
- [Anthropic's data retention policy](https://www.anthropic.com/legal/consumer-terms) — the relevant external contract.
