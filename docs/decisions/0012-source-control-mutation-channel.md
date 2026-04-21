# ADR-0012 — Source-control mutation channel

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN exposes `git` to users in exactly two places today:

1. The user can ask MARVIN in chat and MARVIN shells to `git` via its `Bash` tool ([ADR-0004 confirm gate](./0004-structural-confirm-gate.md), [`toolPolicy`](../../packages/tools/src/policy.ts)).
2. [`packages/git-watch`](../../packages/git-watch/src/index.ts) polls `git log` to surface new commits inline — read-only, one call per project.

Neither is a source-control UI. IDEs (VSCode, Cursor, JetBrains, Zed) ship a dedicated panel: status, per-file diff, stage/unstage/discard, commit, branch list + switch, push / pull. The user has asked for the same affordance inside MARVIN.

That's a **third mutation channel**, disjoint from the two that already exist:

- **LLM tool channel** — `Edit` / `Write` / `Bash`, turn-scoped `canUseTool`, [ADR-0004](./0004-structural-confirm-gate.md).
- **User-initiated filesystem channel** — `/api/files/write/*`, session-scoped confirm registry, [ADR-0008](./0008-user-initiated-write-channel.md).
- **User-initiated git channel (this ADR)** — `/api/git/*`, its own session-scoped confirm registry.

Git ops don't compose with either prior channel. A `git commit` isn't a file write (no `path`, no `bytes`), it's a state-machine transition on the index + HEAD. Reusing `fsWritePolicy` would require dragging git semantics into its discriminated union; reusing the LLM confirm gate has the same turn-scoped / session-scoped mismatch ADR-0008 rejected.

At the same time, every fix that lands for the file-write channel should flow into the git channel wherever they share primitives. The shared primitive is the **sandbox** — `git` invocations must stay inside the project `cwd`, exactly as filesystem writes must. Everything else (classifier, registry, route surface) is a parallel sibling.

A separate concern: git is an especially sharp tool to shell to. A branch name like `--upload-pack=/bin/sh` is RCE territory even with `execFile` + `shell: false`, because `git` itself parses the argv and honours that flag. Any user-supplied ref / path / remote that becomes an argv element has to pass a whitelist first.

## Decision

Add a third mutation channel with five primitives, all in a new package `packages/git/` (`@marvin/git`).

1. **`packages/git/src/exec.ts` — `runGit(cwd, argv, opts)`** — the only place in MARVIN that shells to `git`. `spawn` with `shell: false`, `stdio: ["pipe", "pipe", "pipe"]`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. 10 s default timeout (60 s cap). 2 MB cap on each of stdout/stderr. stdin is driven by the caller (used by `commit -F -` so messages never travel via argv).
2. **`packages/git/src/argv-guards.ts`** — regex whitelists for every shape that enters argv:
   - `isSafeRef(name)` — `[A-Za-z0-9._/-]+`, 1..250 chars, no leading `-`/`.`, no trailing `/`, no `..` / `@{` / `//`, no `.lock` suffix.
   - `isSafePathspec(p)` — no leading `-`, no leading `:` (pathspec magic), no NUL, ≤ 1024 bytes.
   - `isSafeRemote(name)` — `[A-Za-z0-9][A-Za-z0-9._-]*`, ≤ 100 chars.
   - `isSafeCommitMessage(msg)` — non-empty after trim, no NUL, ≤ 16 KB.
   - `containsForbiddenFlag(argv)` — rejects `-c`, `-C`, `--exec-path`, `--git-dir`, `--work-tree`, `--upload-pack`, `--receive-pack`, `--config-env`, `--super-prefix` (with or without `=value`). `runGit` runs this as a last-line check so a missed guard at a route can't turn into an RCE.
3. **`packages/git/src/parse-porcelain-v2.ts`** — parser for `git status --porcelain=v2 --branch -z`. NUL-delimited records, rename entries consume an extra field for the original path. Returns `{ branch, files }`; callers never touch raw porcelain.
4. **`packages/git/src/git-write-policy.ts` — `gitWritePolicy(op)`** — pure classifier, same `auto | confirm | deny` shape as `policy.ts` and `fs-write-policy.ts`. Input space is the `GitOp` union (stage / unstage / discard / commit / branch-create / branch-switch / branch-delete / push / pull / fetch). Re-runs `isSafeRef` / `isSafeRemote` for defence in depth — a missed guard at a route should widen the attack surface by zero.
5. **`packages/git/src/git-write-confirm-registry.ts`** — session-scoped, 60 s TTL, one-shot consume. Structural op-equality check prevents "mint-for-harmless, replay-with-dangerous" attacks. Direct sibling of `fs-write-confirm-registry.ts`; same shape, different stored type.

The cwd anchor is the **one shared primitive** — [`checkFsPath`](../../packages/runtime/src/fs-sandbox.ts) from ADR-0008. Every route in M2+ runs `checkFsPath` on `cwd` before the first `runGit` call. No other primitive is shared: the classifier, the registry, the parser all live in `packages/git/`.

**Policy rules of note:**

- `push --force` (plain) — hard-deny at the policy layer. Always. Users who need this go to the terminal where they have full context, reflog, and `@{u}`. The UI is not that context.
- `push --force-with-lease` — confirm danger. Acceptable but worth a deliberate click.
- `push` regular when `upstreamAhead > 0` — confirm warn. Git would reject it anyway (non-fast-forward); we return a cleaner message.
- `branch-switch` when working tree is dirty — deny in v1. v2 may offer stash-on-switch; stash is its own surface with its own failure modes, so punting is cheaper than half-shipping.
- `branch-delete` of the current branch — deny (git refuses too, but our message is clearer).
- `branch-delete` of an unmerged branch (`-D`) — confirm danger.
- `commit --amend` when HEAD has been pushed (detected via `rev-list @{u}..HEAD`) — confirm danger; it rewrites shared history.
- `discard working` — confirm warn. The edits are gone after, recoverable only via reflog.
- `discard staged` — auto. Changes remain in the working tree, reversible.
- `pull --ff-only` — auto. Divergence fails cleanly.
- `pull --rebase` / `pull --merge` — confirm warn.
- `fetch` — auto (read-only on local refs).

**Threat items this ADR addresses:**

- Shell-injection via branch / path / remote names (argv-guards + `shell: false`).
- Commit-message argv smuggling (message via stdin, never argv).
- `git -c alias.x=!sh` RCE and `--exec-path` / `--git-dir` / `--work-tree` sandbox escapes (`containsForbiddenFlag` rejects).
- Symlinked cwd escape (`checkFsPath` anchors every route).
- Force-push on any ref (hard-deny at policy).
- Amend on a pushed ref (confirm danger).
- Branch-switch with unsaved edits (deny; no silent data loss).
- Mint-with-X-replay-with-Y token attack (registry op-equality check).
- Runaway-diff OOM (2 MB buffer cap in `runGit`).
- Credential-helper blocking spawn (`GIT_TERMINAL_PROMPT=0`).

**Items deferred to [ADR-0013](./0013-git-remote-ops-and-credentials.md)** (M5, optional):

- Credential-helper inheritance vs in-app prompts.
- Remote-URL sanitisation.
- Stderr redaction for auth error surfaces.

**Items deferred out of scope entirely (v2+):**

- Hunk-level staging (patch editor — own feature).
- Stash (own surface, own failure modes).
- Rebase / merge / cherry-pick / conflict-resolution UI (chat handles this; panel flags state only).
- Blame gutter, history / graph view.

## Consequences

**Positive:**

- IDE parity. The user gets what VSCode / Cursor ship, without MARVIN having to do it.
- Third classifier follows the same shape as the first two (`policy.ts`, `fs-write-policy.ts`) — reviewers already know how to read it.
- Every user-supplied string is whitelisted at least twice (route layer via `argv-guards`, policy layer defence-in-depth). Missing a guard at the route is not a single point of failure.
- Shared sandbox means tightening ADR-0008's `checkFsPath` automatically flows into the git channel too.
- `runGit` centralisation means every future git-surface tightening (timeout, buffer cap, forbidden flag, environment variable) lands in one file.

**Negative:**

- Third parallel policy module. Adding a new op kind now requires touching classifier + registry + route + UI. Same cost as the filesystem channel; same mitigation (tests pin the classifier).
- New in-flight state object (git confirm registry) sitting alongside the two prior ones. Three registries means three TTL sweepers, three shapes, three places to audit for leaks.
- Users who want a feature we deferred (hunk staging, stash, rebase UI) will land the request as a v2 ask. That's fine — preferable to half-shipping — but worth naming here so it doesn't drift into "why isn't this done" complaints.

## Alternatives considered

### Wrap every git op as an LLM `Bash` tool call

*What it is:* UI click → synthesise a `Bash("git add foo")` call → route through `canUseTool`.

*Why plausible:* Reuses the existing gate. One audit surface.

*Why rejected:* Same reason [ADR-0008](./0008-user-initiated-write-channel.md) rejects it — the turn-scoped registry has no natural home for session-scoped UI events, and the gate's value is that it's structural (SDK-enforced). A gate enforced by app code is tautological. Also: parsing a user commit message into a shell-safe `Bash(…)` argument is exactly the kind of surface that produces injection bugs.

### Reuse `fsWritePolicy` — make git ops a subset

*What it is:* Extend `FsWriteOp` with git variants; `fsWritePolicy` classifies both.

*Why plausible:* One classifier to maintain. Shared `auto`/`confirm`/`deny` set.

*Why rejected:* Git ops have no path / bytes / overwrite fields — the existing union members don't share a shape with them. Widening `FsWriteOp` to accommodate would force every existing call site to handle git variants it will never emit. The shared-constants pattern (ADR-0008) already provides the anti-drift benefit across filesystem channels; we extend that by sharing `fs-sandbox` only, not the classifier.

### Skip the policy for user-initiated git ops

*What it is:* Every panel click goes straight to `runGit`.

*Why plausible:* UI already gates destructive ops behind a button click; policy is noise.

*Why rejected:* `git push --force` on `main` is one misclick from a bad incident. "User clicked it" is not the same as "user intended the consequences." The policy codifies "what's actually destructive"; the UI codifies "did the user mean it"; mixing them means both jobs are done by whichever layer happens to be in the reviewer's head at the time.

### Drive git via a shell instead of `execFile`

*What it is:* `exec("git status", { cwd })`, string interpolation for arguments.

*Why plausible:* Ergonomic, matches how most git tutorials are written.

*Why rejected:* Shell-interpolation on user-supplied refs / paths / messages is the canonical git-UI CVE pattern. `execFile` + argv-guards removes the entire class of bug. The 10 extra lines of arg-list construction are worth it.

### SSE / websocket for live-refresh instead of polling

*What it is:* Server pushes `files.changed` to the client; panel refreshes on event.

*Why plausible:* Instant feedback, zero wasted cycles.

*Why rejected:* The poll is 12 lines of code: a hook that fetches `/api/git/status` every 2 s when the panel is visible and pauses otherwise. SSE introduces a stream registry, reconnection logic, cross-tab fan-out, and a second invalidation channel. Not a v1 cost worth paying for a single developer machine's CPU budget. Revisit if perf shows up in telemetry.

### Ship hunk-level staging in v1

*What it is:* Select a range of +/- lines in the diff; MARVIN builds a patch and applies it via `git apply --cached`.

*Why plausible:* Table stakes in VSCode / Cursor.

*Why rejected:* Hunk staging is a patch editor, which is a larger UI surface than the rest of M4 combined. Its failure modes (context-mismatch, whitespace normalisation, rename-detection) each need careful handling. File-level staging first; hunk-level as a follow-up when the panel is proven.

## Verification

- `pnpm --filter @marvin/git typecheck` green.
- `pnpm test -- packages/git` — 52 unit tests passing (argv-guards: 15, parse-porcelain-v2: 13, git-write-policy: 24).
- `rg "execSync|\"shell\"\\s*:\\s*true|shell:\\s*true|spawn\\(\\s*['\"]sh['\"]" packages/git/ apps/web/src/app/api/git/` → 0 hits (there is no `apps/web/src/app/api/git/` yet in M1, but the grep is in the M2/M3 gate too).
- `rg "child_process" packages/git/src/` → one hit in `exec.ts`. No other file in the package imports `child_process`.
- Unit tests on `argv-guards` include injection attempts (`; rm -rf /`, `$(whoami)`, `--upload-pack=/bin/sh`, `-c alias.x=!foo`, `-C /etc`) — each rejected.
- Unit tests on `parse-porcelain-v2` cover: clean, modified staged-only, modified working-only, rename, rename-followed-by-other-entries, unmerged, untracked, ignored, detached HEAD, initial commit, ahead/behind with N > 9, paths containing spaces, unknown record type (forward compat), empty input.
- Unit tests on `gitWritePolicy` cover every branch of the `GitOp` union including every `push.force` × `upstreamAhead` combination and every `branch-delete` × `merged` × `isCurrent` combination.
- Manual (M2+): MARVIN `Bash("git checkout -b foo")` during an open panel — panel refreshes within 2 s.

## Related

- [ADR-0004 — Structural confirm gate](./0004-structural-confirm-gate.md) — the LLM channel's policy enforcement; template for this ADR's confirm-at-the-boundary pattern.
- [ADR-0008 — User-initiated write channel](./0008-user-initiated-write-channel.md) — the second mutation channel; this ADR is the third, following the same shape.
- [ADR-0013 — Git remote ops and credentials](./0013-git-remote-ops-and-credentials.md) (M5, pending) — extends this ADR to cover push / pull / fetch.
- [`packages/git/src/git-write-policy.ts`](../../packages/git/src/git-write-policy.ts) — the classifier.
- [`packages/git/src/argv-guards.ts`](../../packages/git/src/argv-guards.ts) — whitelists.
- [`packages/git/src/exec.ts`](../../packages/git/src/exec.ts) — `runGit`.
- [Tool policy reference](../security/tool-policy.md) — the three-channel matrix.
