# ADR-0013 — Git remote ops and credentials

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN

## Context

[ADR-0012](./0012-source-control-mutation-channel.md) shipped local-only git in M1-M4: stage, unstage, discard, commit, branch create / switch / delete. The classifier encodes rules for push / pull / fetch but no routes execute them yet.

M5 closes that gap by adding three remote routes — `/api/git/push`, `/api/git/pull`, `/api/git/fetch`. That introduces a new trust boundary that the local channel doesn't have: the **user's git credential helper** (osxkeychain / gh auth / 1password-cli / SSH agent). A remote op requires authenticating to the upstream, and MARVIN has to decide what role it plays in that flow.

Three shapes are plausible:

1. **Inherit.** Spawn `git` with the user's env; credential helpers answer out-of-band; MARVIN never sees a secret. If nothing is configured, the command fails with readable stderr.
2. **Prompt.** When git asks for credentials, intercept the prompt, pop a dialog in the app, pipe the answer into git's stdin.
3. **Manage.** Store a PAT (or key) in MARVIN's settings, rewrite remote URLs to carry it.

Shape 2 turns MARVIN into a UI-layer credential proxy — we'd have to reason about when to clear the cache, how to present TOTP challenges, what happens to the token if the renderer process is logged. Shape 3 turns MARVIN into a secrets manager — PATs get leaked in screenshots, checked into the settings JSON file, and drift out of sync with the user's actual auth. Both reclassify MARVIN from "dev tool" to "credential manager," which is a different category of product with different supply-chain and threat-model obligations.

There's a further wrinkle specific to our runtime. MARVIN's server is a Next.js process spawned from the user's shell (`pnpm dev` or `bin/marvin` or the Tauri sidecar). Its env already carries `SSH_AUTH_SOCK`, `HOME`, and whatever the user's login shell exported — everything `git` needs to find the user's credential helper. We'd have to work to *not* inherit auth.

## Decision

Inherit. Never handle.

Concretely, for every `/api/git/{push,pull,fetch}` route:

- Spawn `git` via the existing `runGit` wrapper with `stdio: ["pipe", "pipe", "pipe"]`, `GIT_TERMINAL_PROMPT=0`, and `LC_ALL=C`. `GIT_TERMINAL_PROMPT=0` turns git's interactive username/password prompt into an immediate failure with readable stderr — credential helpers configured in `~/.gitconfig` (osxkeychain, gh, 1password-cli) still answer because they bypass the prompt.
- Never write to `child.stdin` on these routes. The `runGit` contract already supports stdin for `commit -F -`, but remote routes don't call that path.
- Never transform remote URLs. If a remote is `https://u:p@host/...` already, that's the user's decision and the user's leak, not ours. We pass the remote name through verbatim.
- Never prompt for credentials in the MARVIN UI. If a push fails because git needs credentials, we surface the stderr and a one-line remedy ("configure a credential helper"). The user fixes their auth in the shell; the next push works.
- Force-push remains hard-denied (the `"plain"` variant of `push.force`). `--force-with-lease` stays confirm-danger.

**Stderr classification.** The three routes share `apps/web/src/lib/git-remote-errors.ts`, which matches well-known git-network stderr strings onto a stable error-code taxonomy: `auth-publickey`, `auth-failed`, `network`, `non-fast-forward`, `no-upstream`, `no-remote`, `merge-conflict`, `git-failed`. The UI's `RemoteErrorBanner` renders the matched code with a remedy plus a "show stderr" toggle for the occasional weird failure. No credential-bearing strings are part of that classifier (`https://u:p@host` URLs wouldn't trip it — the banner would show "git-failed" and drop the stderr into the show-details section, which is the same as every other generic failure). Stderr pass-through is intentional: users debugging auth need the raw message.

**Timeouts.** Network ops override the 10 s default on `runGit` up to 60 s (fetch) / 90 s (pull, push). These are still capped at the 60 s ceiling `runGit` hard-clamps, so push/pull actually max out at 60 s in practice — enough for ordinary pushes over a residential uplink without hanging a poll loop on a broken connection.

**No stash-on-switch, no pull --autostash.** The pull route refuses to run on a dirty tree. This matches the v1 branch-switch rule (ADR-0012): destructive resolutions for dirty trees are a v2 feature with their own UX surface.

## Consequences

**Positive:**

- Zero credential storage in MARVIN. No new secrets to misplace.
- SSH, osxkeychain, `gh auth`, 1password-cli all work on day 1 with no integration per-helper. The user's existing credential setup is the feature.
- Reinstalling MARVIN, switching machines, rotating keys — all no-ops for the app.
- The attack surface stays the same as the local-ops channel: argv-guards + fs-sandbox + policy + confirm. Nothing new to audit.

**Negative:**

- Fresh machines with no credential helper get a wall-of-text stderr on first push. The remedy banner ("configure a credential helper") points in the right direction but can't fix it. Documentation has to.
- Users who expect an in-app "set up git credentials" wizard will not find one. This is deliberate; the wizard is a secrets manager.
- Certain failure modes (expired OAuth token, revoked PAT, missing 2FA) surface as opaque HTTP 401 in stderr. The remedy "configure a credential helper" is not wrong but isn't precise for these cases.

## Alternatives considered

### Pop a password dialog when git asks for credentials

*What it is:* Intercept git's credential prompt, pipe the answer via `child.stdin`.

*Why plausible:* Feels friendlier than "config your shell." Matches what VSCode does via its credential-manager extension.

*Why rejected:* MARVIN storing or proxying credentials reclassifies the product into a credential-manager — different category, different obligations (secure storage, screen-lock, automatic clearing, 2FA dance, TOTP support). The supply-chain threat-model implication is also serious: every release now has to defend secrets, not just code. VSCode's credential-manager works because it's one of several compromises VSCode has already made (telemetry, signed binaries, an update channel, a dedicated credential store per-OS). MARVIN doesn't run those compromises.

### Store a PAT in MARVIN settings; rewrite remote URLs on push

*What it is:* User pastes a token into the observability-style settings dialog; push/pull rewrite the remote URL to `https://x-access-token:<pat>@github.com/...`.

*Why plausible:* Zero dependency on the user's shell being configured. Works out-of-the-box for HTTPS remotes.

*Why rejected:* Same reclassification as above, worse. PATs have a long lifetime and are routinely pasted into screenshots, terminal scrollbacks, and chat logs. Storing them in app settings duplicates (and shadows) the user's credential helper, so now we've added a drift problem on top of the secrets-manager problem. URL-rewriting also means every stderr we surface risks leaking a `https://x-access-token:...@host` line into the banner's show-details section. Not worth it.

### Block remote ops entirely; redirect to the terminal

*What it is:* No `/api/git/{push,pull,fetch}` routes; the panel shows a "push in the terminal" hint.

*Why plausible:* Simplest possible answer to the credential question. The terminal is already where credentials live.

*Why rejected:* Makes the panel a pretty status viewer rather than an IDE surface. The whole point of ADR-0012 was to close the gap between "MARVIN the file viewer" and "MARVIN the IDE"; refusing push/pull widens the gap at exactly the feature the user asked for. "Inherit" gives us the feature without the secrets problem.

### Always prefer `gh` over `git` for GitHub remotes

*What it is:* Detect GitHub URLs, shell to `gh auth` / `gh pr push` instead of `git`.

*Why plausible:* `gh` has first-class token rotation and handles PAT storage correctly.

*Why rejected:* Tool-sprawl. `gh` doesn't exist on every user's machine; not every remote is GitHub; `gh auth` itself is a credential helper, so it already works under "Inherit" when configured. We'd add a special-case per-host surface for no net gain over the general-case.

### Surface credential prompts as a MARVIN chat turn

*What it is:* When git needs credentials, the server pushes an `assistant_message` into the current chat session asking the user for them.

*Why plausible:* Unifies the affordance — every interactive prompt lives in chat.

*Why rejected:* Chat is an LLM surface; piping user secrets through it would write them into the JSONL transcript (which is disk-persistent for resume) and into any future telemetry. Orthogonal to "inherit"; compounds the secrets-manager problem.

## Verification

- `rg -l "child.stdin" packages/git apps/web/src/app/api/git` → one hit (`commit/route.ts`, for the message-via-stdin pattern). No remote route writes to stdin.
- `rg -l "X-Marvin-Confirmed|GIT_TERMINAL_PROMPT" apps/web/src/app/api/git` → `GIT_TERMINAL_PROMPT` is set exactly once, in `packages/git/src/exec.ts`.
- Manual: on a repo with the `gh` credential helper configured, `curl -X POST /api/git/fetch …` succeeds with no UI prompt.
- Manual: on a repo with an intentionally-missing SSH key, `/api/git/fetch` returns `502 auth-publickey` with the `ssh-add -l` remedy; MARVIN does not prompt.
- Manual: `/api/git/push` with an upstream ahead by N commits returns `409 needs-confirm` (warn). User accepts → request replays → `502 non-fast-forward` when upstream really is ahead. Remedy banner surfaces "pull first or force-with-lease."
- Manual: `/api/git/push` with `forceWithLease: true` on a clean fast-forward returns `409 needs-confirm` (danger). User accepts → replay succeeds.
- Attempted plain `--force` via `{ "forceWithLease": false, "force": "plain" }` request body is impossible by construction — the route accepts only `forceWithLease: boolean`, never a `force` string from the client. Policy layer rejects `force: "plain"` anyway as a defence-in-depth check.
- `rg "https?://[^/]*:[^/]*@" apps/web/src packages/git/src` → 0 hits. No credential-bearing URL construction anywhere.

## Related

- [ADR-0012 — Source-control mutation channel](./0012-source-control-mutation-channel.md) — this ADR extends it.
- [`packages/git/src/git-write-policy.ts`](../../packages/git/src/git-write-policy.ts) — push / pull / fetch rules.
- [`apps/web/src/lib/git-remote-errors.ts`](../../apps/web/src/lib/git-remote-errors.ts) — stderr classifier.
- [`apps/web/src/app/api/git/push/route.ts`](../../apps/web/src/app/api/git/push/route.ts), [`pull/route.ts`](../../apps/web/src/app/api/git/pull/route.ts), [`fetch/route.ts`](../../apps/web/src/app/api/git/fetch/route.ts) — the three remote routes.
- [Tool policy reference](../security/tool-policy.md) — the three-channel matrix.
