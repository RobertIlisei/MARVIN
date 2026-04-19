# Tool permission policy

Every tool call goes through [`toolPolicy()`](../../../packages/tools/src/policy.ts). The policy classifies the call into one of three outcomes: auto-allow, confirm, or hard-deny. The [confirm gate](../concepts/confirm-gate.md) enforces the classification structurally via the Agent SDK's `canUseTool` callback.

## The three outcomes

### Auto-allow

Executes immediately. No user interaction.

**Read-only tools (always auto-allow):**

- `Read` — file read
- `Grep` — content search
- `Glob` — filename search
- `WebFetch` — HTTP GET
- `WebSearch` — search engine query

These can inspect anything inside the project but cannot change state.

**Whitelisted Bash commands (auto-allow):**

Bash calls are classified by regex-matching the `command` string. Matches get auto-allow; non-matches fall through to confirm.

| Pattern | Examples |
|---|---|
| Read-only git | `git status`, `git log`, `git diff`, `git show`, `git rev-parse HEAD`, `git branch -a` |
| Filesystem inspection | `ls`, `pwd`, `cat <path>`, `head <path>`, `tail <path>`, `wc`, `file`, `du`, `df` |
| Package inspection | `npm ls`, `pnpm list`, `yarn list`, `pip list`, `pip show` |
| Scripts | `npm run …`, `pnpm <script>`, `yarn <script>` (excluding `publish`) |
| Typecheck + lint | `tsc`, `tsc --noEmit`, `pnpm typecheck`, `eslint`, `biome check`, `prettier --check` |
| Process inspection | `ps`, `lsof -i`, `netstat -an`, `lsof -iTCP:<port>` |
| Env inspection (non-secret) | `printenv`, `env | grep -v KEY`, `echo $PATH` |

The exact list lives in [`packages/tools/src/policy.ts`](../../../packages/tools/src/policy.ts) as `AUTO_ALLOW_BASH_PATTERNS`. To add a pattern, PR the policy file — don't inline expand in the call site.

**MCP tools:**

Any tool whose name starts with `mcp__` auto-allows. This includes `marvin-graph` and `marvin-playwright`. MCP servers are trusted — they're registered at turn-start by [`sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts), not arbitrary.

### Confirm

Renders a confirm card inline in the tool-call block. MARVIN pauses until the user clicks allow or deny.

**Default confirm-triggers:**

- `Edit` — modifying a file (shows Monaco diff)
- `Write` — creating a file (shows Monaco diff against empty)
- `Bash` — any command not on the auto-allow list (shows `$ <command>` block)

The confirm card shows:

- **Reason** — why the policy classified it as confirm (e.g. "writes to a tracked file")
- **Preview** — the actual payload (diff, command, or raw input)
- **Allow / Deny** buttons. Deny accepts an optional note that the SDK passes back as the tool result, so MARVIN can explain why the operation was refused.

### Hard-deny

Blocks without prompting. Even in `auto` mode, these never run.

**Patterns that hard-deny:**

- `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf $HOME` and close variants — path-absolute mass deletion
- `git push --force` / `git push -f` targeting a protected branch (`main`, `master`, `production`, `release/*`) — exception: `git push --force` to a personal feature branch passes (falls through to confirm)
- `git reset --hard HEAD~<N>` where N > 3 — throwaway safeguard against large history rewrites
- `git config --global …` — scope violation; MARVIN shouldn't mutate user-global config
- `curl … | sh`, `curl … | bash`, `wget … | sh` — arbitrary code execution via pipe
- `dd of=/dev/…` — disk-level operations
- Reading or writing `.env`, `.env.local`, `.env.production`, `*.pem`, `id_rsa` without explicit user intent signal in the prompt (e.g., user says "read the .env")
- `sudo` prefixed commands — MARVIN is not a privileged agent
- `chmod -R … /` or similar permission recursion from root

Hard-denies return `{ behavior: "deny", message: "..." }` to the SDK. The executor sees the refusal as a tool_result and is expected to find an alternative path.

The list is in `packages/tools/src/policy.ts` as `HARD_DENY_PATTERNS`. Adding one requires a decision — document in `docs/decisions/` if the pattern is controversial.

## Mode interactions

| Permission mode | Auto-allow | Confirm | Hard-deny |
|---|---|---|---|
| `auto` (default) | runs | **runs** (no prompt) | blocked |
| `gated` | runs | prompts the user | blocked |

In `auto`, every classification except hard-deny executes — the policy is still applied, but the "confirm" outcome is implicit allow.

## Extending the policy

### Adding an auto-allow Bash pattern

Only if the pattern is **demonstrably read-only or side-effect-free in-project**. Rules of thumb:

- Reads: fine.
- Writes that are trivially reversible (creating a scratch file in `/tmp`): probably fine.
- Writes outside the project (`brew install`, `npm install -g`): not fine. These belong on the confirm path.
- Network writes (deploys, DB mutations): definitely not fine.

### Adding a hard-deny pattern

Appropriate when a class of commands:

- Would cause data loss that isn't recoverable in 60 seconds (e.g., `rm -rf` on user data)
- Affects shared resources (force-push to main)
- Escalates privileges (`sudo`, `chmod 777`)
- Exfiltrates secrets (piping `.env` files to `curl`)

New hard-denies should land with an ADR explaining the decision.

### Per-project policy override

Not currently supported. A project's `.marvin/config.json` could in principle carry a `bashAllowlist` that adds to the global one for that workDir only. Flagged as a potential extension in [Roadmap](../roadmap.md).

## Observability

In the JSONL session transcript, every tool call carries its policy classification as part of the `cli.event`:

```jsonl
{"type":"cli.event","at":"…","event":{"type":"tool_use","name":"Bash","input":{"command":"rm node_modules"},"policy":"confirm"}}
```

Grep the transcripts for `"policy":"hard-deny"` to see what MARVIN tried to run and got blocked.

## Related

- [Confirm gate](../concepts/confirm-gate.md) — how the policy outcomes are enforced structurally.
- [`packages/tools/src/policy.ts`](../../../packages/tools/src/policy.ts) — the authoritative implementation.
- [`sdk-runner.ts`](../../../packages/runtime/src/sdk-runner.ts) — where `canUseTool` is installed.
- [ADR-0004 — structural confirm gate](../decisions/0004-structural-confirm-gate.md) — why the gate moved from CLI flags into the SDK callback.
