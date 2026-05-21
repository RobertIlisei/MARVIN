# Troubleshooting

Common issues, probable causes, fixes. Ordered by "how often it happens in practice."

> **Note on log paths.** When MARVIN is installed via the Homebrew cask
> (`brew install --cask marvin-ai`), the sidecar runs as a child of the
> SwiftUI process and its stderr lands at
> `~/Library/Logs/MARVIN/sidecar.log`. When running from a clone with
> `pnpm dev`, the same output goes to the terminal you started `pnpm
> dev` in. The two are interchangeable below — read whichever exists.

## MARVIN.app won't launch — "Apple could not verify..."

**Symptom (macOS 26 / Tahoe):** double-clicking `MARVIN.app` in
`~/Applications` pops a dialog: *"Apple could not verify "MARVIN.app"
is free of malware that may harm your Mac or compromise your privacy."*
Buttons offered are **Done** and **Move to Bin** — there is no
"Open" button and right-click → Open does nothing.

**Cause:** MARVIN is ad-hoc signed (no paid Apple Developer Programme
membership). On macOS 26 Apple removed the right-click → Open shortcut
that worked on earlier macOS versions; ad-hoc apps must be whitelisted
once through System Settings.

**Fix (one time, persists across upgrades):**

1. Click **Done** on the popup (not Move to Bin).
2. Open **System Settings → Privacy & Security**, scroll to the **Security** section.
3. Find **"MARVIN.app was blocked from use because it is not from an identified developer"** and click **Open Anyway**.
4. Authorize with Touch ID or your password. MARVIN launches and the bundle is whitelisted for the life of the install.

If you don't see the "MARVIN.app was blocked..." line, double-click
the app first to register the block, then check Privacy & Security
within 30 seconds.

See [ADR-0027](../decisions/0027-macos-26-gatekeeper-user-applications.md)
for the technical detail (path-specific kernel-level Gatekeeper kill
that motivated the `~/Applications` install location).

## MARVIN.app dies at 32 KB RSS in `/Applications`

**Symptom (macOS 26):** Double-click `MARVIN.app` in `/Applications/`,
the process briefly appears in Activity Monitor at ~32 KB RSS, then
vanishes. No dialog, no log, no UI window.

**Cause:** macOS 26 kernel-kills ad-hoc-signed bundles launched from
`/Applications/` regardless of signature state. This is path-specific
— the same bundle launched from `~/Applications/` runs normally.

**Fix:** uninstall + reinstall via the current cask, which targets
`~/Applications/`:

```bash
brew uninstall --cask marvin-ai
brew install --cask marvin-ai
```

If you installed from source: `bin/marvin install-macos-app` (post
v0.1.12) installs to `~/Applications/` automatically and migrates
the legacy `/Applications/MARVIN.app` away. Pull and rerun:

```bash
cd ~/marvin && git pull
bin/marvin install-macos-app
```

The empirical detail (same bundle, three paths, two outcomes) lives
in [ADR-0027](../decisions/0027-macos-26-gatekeeper-user-applications.md).

## MARVIN won't take a turn

**Symptom:** chat input is enabled, you send a message, nothing happens or an immediate error.

**Diagnosis:**

```bash
curl -s http://localhost:3030/api/health | jq .
```

| Output | Fix |
|---|---|
| `ok: false, auth.mode: "none"` | Set `ANTHROPIC_API_KEY` in your shell or run `claude auth login`. See [Credentials](../security/credentials.md). |
| `ok: true` but chat still hangs | Check the terminal running `pnpm dev` for SDK errors. Most commonly: network blocked or Anthropic API rate-limited. |
| `ok: false, binaryError: "..."` | The Claude CLI binary is missing from PATH. `which claude` — if empty, install it. |

## Port 3030 already in use

```
Error: listen EADDRINUSE: address already in use :::3030
```

**Diagnosis:**

```bash
lsof -iTCP:3030 -sTCP:LISTEN
```

**Fix:** kill the offending process, or it's another MARVIN instance you forgot about — point your browser at the existing one.

## Models dropdown shows "fallback list"

**Symptom:** header `<ModelPicker>` → `models` dropdown shows a warning: *"host-credentials token lives in the OS keychain and isn't readable by MARVIN; using fallback list."*

**Cause:** on macOS, `claude auth login` stores the token in the Keychain, which Node can't read.

**Fix:** set `ANTHROPIC_API_KEY` directly in your shell. MARVIN detects it first and uses it for the live `/v1/models` call. See [Credentials → macOS Keychain caveat](../security/credentials.md#macos-keychain-caveat).

If you don't care about new models showing up in the dropdown, ignore it — the static fallback list (Opus 4.7, Opus 4.6, Sonnet 4.6, Haiku 4.5) is usable.

## Hydration mismatch warning in console

**Symptom:** browser console shows *"A tree hydrated but some attributes of the server rendered HTML didn't match the client properties. … data-theme..."*

**Cause:** the pre-paint theme bootstrap script sets `<html data-theme="dark">` before React hydrates. SSR had no such attribute. React warns on the diff.

**Fix:** should not happen after [ADR-0006](../decisions/0006-light-first-theme-cascade.md) — `<html>` has `suppressHydrationWarning`. If you see this on the current `main` branch, the attribute was removed in a refactor — restore it in `sidecar/src/app/layout.tsx`.

## Session resume shows an empty transcript

**Symptom:** click a session in the picker, shell opens, no messages render.

**Diagnosis:**

```bash
ls -la ~/.marvin/sessions/<projectId>/
cat ~/.marvin/sessions/<projectId>/<sessionId>.jsonl | head
```

| Output | Diagnosis |
|---|---|
| File empty | The session never got a completed turn. Normal — fresh empty session. |
| File has `turn.user` but no `cli.event` | Network failure during the first turn; no transcript to hydrate. |
| File has events but doesn't render | Likely a client-side `hydrateFromSession` bug. Check browser console for errors. |

## Preview pane loads blank

**Cause:** the target site sends `X-Frame-Options: DENY` or a CSP `frame-ancestors` directive that blocks the iframe.

**Fix:** click the ↗ button in the preview pane to open in a new tab. The iframe cannot be worked around for third-party sites — browsers enforce the policy.

For your own dev server (`http://localhost:3000`), check that your dev server isn't setting these headers itself. Next.js sets `X-Frame-Options: SAMEORIGIN` by default in recent versions — fine for `localhost:3000` framed by `localhost:3030` (same origin *host* with different ports still passes SAMEORIGIN in most browsers; if not, remove the header for dev).

## Terminal shows "[exit 0 · 0.00s]" immediately

**Cause:** the project `cwd` isn't set or is invalid.

**Fix:** select a project in the picker. Without a project, the terminal has no `cwd` to execute in and bounces immediately.

## File tree is empty / "Permission denied"

**Cause:** the project's `workDir` is not readable by the user running `pnpm dev`.

**Fix:**

```bash
ls -la <workDir>
```

If the permissions are wrong, fix them (`chmod`, `chown`) or pick a different `workDir`.

## Browser automation fails

**Symptom:** MARVIN tries to run `npx playwright screenshot …` (or similar) via Bash and gets an error about Chromium not being installed.

**Cause:** Chromium binaries aren't installed.

**Fix:**

```bash
npx playwright install chromium
```

One-time per machine. MARVIN's next browser-automation turn picks up the installed binary automatically.

## "Can't go back to landing page" after picking a session

**Symptom:** after clicking a saved session in the picker, the shell opens with messages but there's no obvious way back to the hero.

**Fix:** as of 2026-04-19, clicking the `marvin` wordmark in the top-left acts as "home" — equivalent to ⌘⇧N / "new session." You can also click the `new session` button on the right of the header.

## Graph pane shows "no graph found"

**Cause:** graphify hasn't been run on the active project.

**Fix:** in the project's directory:

```bash
cd <workDir>
/graphify .
```

Or if you're inside a MARVIN chat, just say "build the graph" and MARVIN will run the skill.

## Turn costs are surprisingly high

**Diagnosis:** look at the session's token usage in the brain side panel. If it's dominated by `inputTokens` on subsequent turns (not just the first), you're paying for cache-misses.

**Fixes:**

1. Start a new session for new tasks (`⌘⇧N`). Long sessions accumulate context.
2. Try advisor mode ([ADR-0003](../decisions/0003-advisor-strategy.md)) — Sonnet executor + Opus advisor, 30-40% savings.
3. Run `/graphify . --update` to keep the graph fresh so MARVIN orients via graph instead of re-reading files.

See [Cost model → cost controls](../business/cost-model.md#cost-controls).

## Something else

Open an issue at github.com/RobertIlisei/MARVIN/issues with:

- `/api/health` output.
- Browser console errors.
- The last few lines of the `pnpm dev` terminal.
- The last 20 lines of the relevant `~/.marvin/sessions/<projectId>/<sessionId>.jsonl`.

## Related

- [Credentials](../security/credentials.md)
- [Health checks](../operations/health.md)
- [Sessions](../operations/sessions.md)
- [Cost model](../business/cost-model.md)
