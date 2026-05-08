# Tool permission policy

Every tool call goes through [`toolPolicy()`](../../../sidecar/packages/tools/src/policy.ts). The policy classifies the call into one of three outcomes: auto-allow, confirm, or hard-deny. The [confirm gate](../concepts/confirm-gate.md) enforces the classification structurally via the Agent SDK's `canUseTool` callback.

## Three mutation channels

MARVIN has three state-mutation surfaces, not one. Each has its own classifier + confirm registry; the only primitive they share is the path sandbox.

1. **LLM tool channel** — MARVIN's `Edit`, `Write`, `Bash` tool calls, routed via `canUseTool` → `toolPolicy` → the turn-scoped [confirm registry](../../../sidecar/packages/runtime/src/confirm-registry.ts). This page primarily documents that channel. See [ADR-0004](../decisions/0004-structural-confirm-gate.md).
2. **User-initiated filesystem channel** — the file-tree UI's create / rename / move / delete / save / upload operations, routed through `/api/files/write/*` → `fsWritePolicy` → a session-scoped confirm-token registry. See [ADR-0008](../decisions/0008-user-initiated-write-channel.md) and [ADR-0009](../decisions/0009-file-uploads-from-os.md).
3. **User-initiated git channel** — the Source Control panel's stage / unstage / discard / commit / branch / push / pull / fetch operations, routed through `/api/git/*` → `gitWritePolicy` → a parallel session-scoped confirm registry. See [ADR-0012](../decisions/0012-source-control-mutation-channel.md) and [ADR-0013](../decisions/0013-git-remote-ops-and-credentials.md) (M5, pending).

The first two filesystem channels share the same ignore-list, hard-deny-segment list, and secret-file patterns — [`sidecar/packages/tools/src/fs-constants.ts`](../../../sidecar/packages/tools/src/fs-constants.ts) — so tightening one surface automatically tightens the other. The sandbox helper [`checkFsPath`](../../../sidecar/packages/runtime/src/fs-sandbox.ts) is shared by all three channels and is the only supported way to validate a caller-provided path before I/O.

Git ops don't share the fs constants (they operate on the git state machine, not file paths), but every `/api/git/*` route still anchors its `cwd` through `checkFsPath` before invoking [`runGit`](../../../sidecar/packages/git/src/exec.ts) — symlink escapes are a cross-channel concern.

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

The exact list lives in [`sidecar/packages/tools/src/policy.ts`](../../../sidecar/packages/tools/src/policy.ts) as `AUTO_ALLOW_BASH_PATTERNS`. To add a pattern, PR the policy file — don't inline expand in the call site.

**MCP tools:**

Any tool whose name starts with `mcp__` auto-allows. Today that's just `marvin-graph` (the in-process knowledge-graph server). MCP servers are trusted — they're registered at turn-start by [`sdk-runner.ts`](../../sidecar/packages/runtime/src/sdk-runner.ts), not arbitrary.

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

The list is in `sidecar/packages/tools/src/policy.ts` as `HARD_DENY_PATTERNS`. Adding one requires a decision — document in `docs/decisions/` if the pattern is controversial.

## User-initiated file ops

Classified by [`fsWritePolicy()`](../../../sidecar/packages/tools/src/fs-write-policy.ts). Same three outcomes (`auto` / `confirm` / `deny`) enforced at the route boundary: `confirm`-class ops return `409 needs-confirm` unless the request carries an `X-Marvin-Confirmed: <token>` header minted by `/api/files/write/confirm`.

| Op | Default class | Reason |
|---|---|---|
| `create-file` / `create-dir` | auto | Inside project, not deny-listed. |
| `write-file` (editor save) | auto up to 5 MB | Cap lives in `WRITE_SIZE_MAX_BYTES`; bigger → deny. |
| Write / create / rename touching `.env*`, `*.pem`, `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx` | confirm **danger** | Secret-file pattern; user may not realise the target. |
| `rename` where only case changes (`Foo.ts` → `foo.ts`) on case-insensitive volumes | confirm **warn** | APFS/HFS+ would otherwise silently no-op. |
| `move` between project dirs | auto | — |
| `delete-trash` | auto | Reversible via macOS Trash / Recycle Bin / XDG trash. |
| `delete-permanent` | confirm **danger** | Irreversible regardless of count. |
| Any op whose path contains a `HARD_DENY_DIR_SEGMENTS` entry (`.git`, `node_modules`, `.next`, …) | deny | Repo-corruption / dep-corruption risk. |
| Any delete whose paths include `cwd` itself | deny | Project-root guardrail. |
| Any path containing NUL bytes or > 1024 bytes | deny | Sandbox rejects before policy runs. |

The deny-list and secret-pattern sources are [`sidecar/packages/tools/src/fs-constants.ts`](../../../sidecar/packages/tools/src/fs-constants.ts) — shared with the LLM-initiated channel so tightening one flows into the other.

## User-initiated git ops

Classified by [`gitWritePolicy()`](../../../sidecar/packages/git/src/git-write-policy.ts). Same three outcomes enforced at the route boundary: `confirm`-class ops return `409 needs-confirm` unless the request carries an `X-Marvin-Confirmed: <token>` header minted by `/api/git/confirm`.

| Op | Default class | Reason |
|---|---|---|
| `stage` / `unstage` | auto | Reversible by the inverse op. |
| `commit` (non-amend, non-empty message) | auto | Reversible via `git reset HEAD@{1}`. |
| `commit --amend` when HEAD is local-only | auto | Local reflog recovers the prior commit. |
| `commit --amend` when HEAD has been pushed | confirm **danger** | Rewrites shared history on the upstream. |
| `discard --staged` | auto | Changes remain in the working tree. |
| `discard` (working-tree) | confirm **warn** | Edits are gone after; recovery only via reflog if the working copy was once in the index. |
| `branch-create` with a valid ref name | auto | Creating a branch is cheap and reversible. |
| `branch-switch` on a clean tree | auto | Working tree is safe. |
| `branch-switch` with a dirty tree | deny | Commit or discard first; v1 does not stash-on-switch. |
| `branch-delete` of current branch | deny | Git refuses; our message is clearer. |
| `branch-delete` of merged branch | auto | Data reachable via other refs. |
| `branch-delete` of unmerged branch (`-D`) | confirm **danger** | Commits become unreachable without a reflog lookup. |
| `push` regular, upstream behind | auto | Fast-forward push. |
| `push` regular, upstream ahead by N > 0 | confirm **warn** | Git rejects non-fast-forward; we surface a clearer message before the round-trip. |
| `push --force-with-lease` | confirm **danger** | Rewrites the remote branch if the lease matches. |
| `push --force` (plain) | **deny** | Always. The terminal is where you do this, not the panel. |
| `pull --ff-only` | auto | Fails cleanly on divergence. |
| `pull --rebase` / `pull --merge` | confirm **warn** | Rewrites local history or creates a merge commit. |
| `fetch` | auto | Read-only on local refs. |
| Any op whose `ref` / `remote` fails the argv-guards whitelist | deny | Injection vector. |
| Any `cwd` failing `checkFsPath` | deny (at the sandbox layer) | — |

The authoritative source is [`sidecar/packages/git/src/git-write-policy.ts`](../../../sidecar/packages/git/src/git-write-policy.ts); the classifier is pure and unit-tested.

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

## Subagent tool constraints

MARVIN spawns two sanctioned subagent types via the Agent SDK's `agents` option (see [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts)). Each carries its own SDK-level tool constraint — the parent's `canUseTool` gate does not reach subagent turns, so the `agents[*].disallowedTools` field is the structural backstop.

| Subagent | ADR | Disallowed tools | MCP servers | Model |
|---|---|---|---|---|
| `scout` (read-only research) | [ADR-0014](../decisions/0014-scout-subagents-read-only.md) | `Edit`, `Write`, `Bash`, `NotebookEdit` | `marvin-graph` only (no Playwright) | `inherit` (parent tier) |
| `advisor` (Opus second opinion) | [ADR-0007](../decisions/0007-advisor-as-subagent-pattern.md) | None (advisor runs as `general-purpose` subagent) | Parent's full set | `opus` hint |

Why the scout denylist is load-bearing: the scout's operating-model promise ("read-only research, parent owns all writes") must be enforced structurally, not just via prompt. A misrouted brief that accidentally asks the scout to edit would otherwise succeed — the SDK refuses the tool call before the model can emit it. Loosening the denylist requires an ADR amendment.

## Observability

In the JSONL session transcript, every tool call carries its policy classification as part of the `cli.event`:

```jsonl
{"type":"cli.event","at":"…","event":{"type":"tool_use","name":"Bash","input":{"command":"rm node_modules"},"policy":"confirm"}}
```

Grep the transcripts for `"policy":"hard-deny"` to see what MARVIN tried to run and got blocked.

## Related

- [Confirm gate](../concepts/confirm-gate.md) — how the policy outcomes are enforced structurally.
- [`sidecar/packages/tools/src/policy.ts`](../../../sidecar/packages/tools/src/policy.ts) — the authoritative implementation.
- [`sdk-runner.ts`](../../../sidecar/packages/runtime/src/sdk-runner.ts) — where `canUseTool` is installed.
- [ADR-0004 — structural confirm gate](../decisions/0004-structural-confirm-gate.md) — why the gate moved from CLI flags into the SDK callback.
- [ADR-0008 — User-initiated write channel](../decisions/0008-user-initiated-write-channel.md) — the second mutation channel.
- [ADR-0012 — Source-control mutation channel](../decisions/0012-source-control-mutation-channel.md) — the third mutation channel.
- [ADR-0014 — Read-only scout subagents](../decisions/0014-scout-subagents-read-only.md) — SDK-level enforcement of the scout's read-only contract.
