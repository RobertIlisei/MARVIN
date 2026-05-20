# ADR-0023 — Brew-distributable `.app` via bundled Node sidecar

**Status:** Accepted (install location superseded by ADR-0027 on 2026-05-20)
**Date:** 2026-05-08
**Deciders:** @robertilisei, MARVIN
**Supersedes:** [ADR-0011 — Standalone `.app` via bundled Node sidecar (Deprecated)](./0011-sidecar-node-bundling.md)
**Extends:** [ADR-0016 — SwiftUI macOS migration](./0016-swift-migration.md), [ADR-0021 — Remove WKWebView ghost; fully-native Swift macOS app](./0021-webview-removal-fully-native-swift.md)
**Partially superseded by:** [ADR-0027 — Install MARVIN.app to `~/Applications`, not `/Applications`](./0027-macos-26-gatekeeper-user-applications.md). macOS 26 kernel-kills ad-hoc-signed bundles in `/Applications`; the install destination moved to `~/Applications/MARVIN.app`. Everything else in this ADR (bundled Node, sidecar payload, brew cask flow) still applies.

## Context

MARVIN today is installable two ways: clone the repo and run `bin/marvin install-macos-app` (developer install — needs Swift, Node, pnpm), or `bin/marvin start` (CLI). Both assume a populated developer toolchain. There is no path for a non-developer to install MARVIN.

The user-facing ask is "easiest possible install on a fresh Mac, without paying for an Apple Developer ID." The honest answer is **Homebrew cask backed by a GitHub Release**: brew strips `com.apple.quarantine` during install, which is the only reliable way to make Gatekeeper accept an ad-hoc-signed `.app` without forcing the end user to type `xattr` commands. The end user runs `brew tap RobertIlisei/marvin && brew install --cask marvin` — two commands, no toolchain, no Apple Developer ID.

For brew to work, the published `MARVIN.app` must be self-contained. Today it isn't: the SwiftUI binary is in `Contents/MacOS/MARVIN`, but the Next.js sidecar runs from the source repo via a launchd agent that execs `pnpm start` against `${REPO_ROOT}`. Without the source repo on the user's machine, the app opens to a permanent "offline" splash.

[ADR-0011](./0011-sidecar-node-bundling.md) considered this exact problem in 2026-04 and **deprecated** the bundled-Node approach the same day it landed. Its three concerns:

1. **Binary-size blowup** (~90 MB Node) — *for no functional gain*, because the persona at the time was "developer who already has Node installed."
2. **Code-signing / notarization churn** — Apple's hardening rules for bundled executables.
3. **Node version drift** — pinned bundled Node vs the user's host Node.

Each concern reverses under the brew-distribution path:

1. **Persona changed.** A brew user does *not* have Node, pnpm, or Swift installed. The 90 MB *is* the functional gain — without it, there is no install path at all. "No functional gain" was true in 2026-04 only because the developer install was the only install.
2. **We are explicitly not notarizing.** Distribution is via Homebrew cask + ad-hoc signing. Brew strips the quarantine xattr, Gatekeeper accepts the unsigned binary, no Apple Developer ID needed. The "multi-stage signing dance" cost drops to zero because we're not signing.
3. **No drift, because no sharing.** The bundled Node runs *only* the sidecar process inside `MARVIN.app`. It never runs the user's project code. The user's project still uses whatever Node `pnpm dev` / `npm start` finds on their PATH. Two Nodes coexisting on a machine without sharing a codepath have no drift.

ADR-0011's rollback was correct for its persona. This ADR adopts the bundled-Node mechanism for the brew-user persona. The mechanism is the same; the trade-off table is different.

## Decision

Bundle the Next.js sidecar (Next standalone output) plus a pinned Node 22 binary into `MARVIN.app/Contents/Resources/`. Have the SwiftUI app spawn the bundled sidecar as a child process on launch (production path). Existing developer-install flows are preserved.

### Layout

```
MARVIN.app/
└── Contents/
    ├── MacOS/MARVIN              # SwiftUI binary (unchanged)
    ├── Info.plist
    └── Resources/
        ├── AppIcon.icns          # existing
        ├── Queries/              # tree-sitter (existing)
        ├── node                  # pinned Node 22.x arm64 (~30 MB stripped)
        └── sidecar/              # Next.js standalone output
            ├── server.js         # entry — runs under bundled node
            ├── .next/            # build artefacts
            ├── node_modules/     # traced minimal deps
            └── public/
```

### Build pipeline (one new step in `bin/marvin install-macos-app`)

1. **Next.js standalone build.** `sidecar/next.config.ts` adds `output: "standalone"` + `outputFileTracingRoot` pointing at the monorepo root so the `@marvin/*` workspace packages are traced. `pnpm build` produces `sidecar/.next/standalone/` with a minimal `node_modules` tree. (Existing `pnpm build` keeps working — standalone output is additive.)
2. **Node fetch.** New `scripts/fetch-node.sh` downloads Node 22.x for `darwin-arm64` to `vendor/node/node-darwin-arm64/bin/node`, idempotent, sha-pinned. Not committed.
3. **Bundle assembly.** `bin/marvin install-macos-app` (and the future release workflow) copies `node` → `Contents/Resources/node` and the standalone tree → `Contents/Resources/sidecar/`.
4. **Ad-hoc codesign.** `codesign --force --deep --sign -` re-signs the bundle including the new executables. No Developer ID. Brew handles the quarantine.

### Sidecar lifecycle (Swift app spawns it)

`MARVINApp` gets a `SidecarManager` (singleton, MainActor):

- On `applicationDidFinishLaunching`: detect whether the app is running from `/Applications/...` *and* `Contents/Resources/sidecar/server.js` exists. If yes, this is a production install — spawn `Contents/Resources/node Contents/Resources/sidecar/server.js` with `PORT=3030 HOSTNAME=127.0.0.1 NODE_ENV=production` and `MARVIN_DATA_DIR=$HOME/.marvin`. Hold the `Process` reference. If the bundled `server.js` is missing, fall back to the existing "expect external sidecar" behaviour (developer mode — `pnpm dev` from source).
- Pipe stdout/stderr to `~/Library/Logs/MARVIN/sidecar.log` (rotated by file size).
- On `applicationWillTerminate`: `process.terminate()` + 3 s grace, then `SIGKILL`.
- If the process exits non-zero while the app is running, surface a banner with the last 40 log lines and a "Restart sidecar" button.

The launchd-agent path is **retired for the brew install**. It was useful for the developer install (sidecar persists across logins, runs without the GUI app open), but it couples the .app to the source repo. The launchd plist generation is moved behind a `--launchd` opt-in flag on `bin/marvin install-macos-app`. Default is now: app-spawned sidecar.

### Distribution

GitHub Actions workflow on `v*` tags:

1. `macos-14` runner, arm64.
2. Run a hardened build script: `scripts/release-app.sh` → invokes the bundled-app build, ad-hoc signs, zips as `MARVIN-${version}-arm64.zip`.
3. Compute sha256, attach both zip and sha256 to a GitHub Release.

A separate repo `RobertIlisei/homebrew-marvin` carries `Casks/marvin.rb` pointing at the release URL. End-user install:

```bash
brew tap RobertIlisei/marvin
brew install --cask marvin
```

## Consequences

**Positive**

- A non-developer can install MARVIN. This is the entire point.
- Two commands. No Swift, no Node, no pnpm, no Apple Developer ID, no `xattr` chant.
- The `.app` is portable. It runs from `/Applications` without any source checkout.
- Quitting MARVIN cleans up the sidecar. The current launchd-agent install leaves a server running until logout — surprising for a Mac user.
- The Swift app gains a real lifecycle relationship with the sidecar, which is the natural place to add crash-restart, port-collision handling, and a "Restart MARVIN sidecar" menu item later.

**Negative**

- `.app` size jumps from ~10 MB to ~150 MB. Brew downloads stay small relative to most dev tooling (Docker Desktop is ~1 GB; VS Code is ~200 MB) but it's no longer a tiny binary.
- The release pipeline gains four new moving parts: `fetch-node.sh`, the bundled assembly step, the GitHub Actions release workflow, and the cask formula in a separate repo.
- Two install paths to keep working: the developer install (`bin/marvin install-macos-app` from a source clone, with launchd) and the brew install (`MARVIN.app` from a release zip, with app-spawned sidecar). Mitigation: the spawn logic auto-detects which mode based on whether `Contents/Resources/sidecar/server.js` is bundled.
- Updates require re-tagging + re-release + cask formula bump. Until we wire an auto-updater, users get updates by `brew upgrade --cask marvin`. Acceptable for now.

**Reversible if the trade-off shifts**

- Drop bundled Node in favour of `bun build --compile` once Bun reliably runs Next 16's standalone server (it doesn't today). Architecture is the same; only the binary inside `Contents/Resources` swaps.
- Add a Developer ID + notarization later if the Gatekeeper-on-non-brew-install path matters. The bundled Node binary will need its own sign+notarize step at that point — same churn ADR-0011 cited, just deferred until there's a reason.

## Alternatives considered

### Stick with developer-only install

Tell non-developers to install Xcode Command Line Tools + Node + pnpm. **Rejected** — it's the current state and the user's question explicitly asks how to make this easier. Nothing changes.

### Bun `bun build --compile` instead of bundled Node

Bun can produce a single executable from a JS entrypoint. **Rejected for v1** because Next.js 16's standalone server uses Node-specific module resolution + dynamic require patterns Bun's compile pipeline does not yet handle reliably. Worth re-evaluating when Bun's Next-compat is solid; the rest of the architecture (Swift spawn, brew distribution) doesn't depend on which JS runtime is bundled.

### Native Rust HTTP server inside the Swift app

Rewrite all sidecar API routes in Swift / Rust. **Rejected** — same reason ADR-0011 rejected it: throws away every Next.js feature (workspace packages, React UI for picker / settings, the entire `sidecar/` codebase that is the trust boundary). Months of work for marginal binary-size savings.

### `.dmg` with manual `xattr` instructions

Skip Homebrew. Ship a `.dmg` to GitHub Releases, tell users to `xattr -dr com.apple.quarantine /Applications/MARVIN.app` after install. **Rejected** — non-developers won't follow that instruction. The friction of a Terminal command between the user and "it works" is exactly what brew solves for free.

### Notarized `.app` (paid Apple Developer ID)

`.dmg` with full notarization, no brew needed, double-clicks cleanly. **Deferred, not rejected.** Costs $99/yr and complicates the release pipeline (notarytool, stapling, asset-by-asset signing of the bundled Node binary). Brew is a strictly cheaper path that gets us the same end-user UX. If MARVIN ever distributes outside brew (Mac App Store, direct download for non-Homebrew users), this becomes worth doing.

### Per-launch download of the sidecar

Ship a 5 MB SwiftUI app that downloads the sidecar from a CDN on first run. **Rejected** — breaks offline install, complicates upgrades, makes the cask formula a lie ("you installed an installer, not the app"), and the binary-size win isn't worth the surprise.

## Verification

- `pnpm --filter sidecar build` produces `.next/standalone/server.js` + `.next/standalone/node_modules/`.
- `vendor/node/node-darwin-arm64/bin/node sidecar/.next/standalone/server.js` boots the sidecar against the user's `~/.marvin/` data dir on port 3030, hits `/api/health` 200.
- `bin/marvin install-macos-app` produces `/Applications/MARVIN.app` with `Contents/Resources/node` and `Contents/Resources/sidecar/server.js` present, `du -sh` < 200 MB.
- Running `/Applications/MARVIN.app/Contents/MacOS/MARVIN` from a clean shell (with no source repo on PATH) opens the window, the sidecar starts, a chat turn round-trips. No "offline" splash.
- Quitting the app via `⌘Q` terminates the sidecar within 3 s (`pgrep -f 'Resources/sidecar/server.js'` empty).
- The dev path (`pnpm dev` in one terminal, `swift run` from `macos/`) still works and does *not* spawn a duplicate sidecar — the spawn logic detects the missing bundled `server.js` and falls back to "external sidecar expected."
- `brew tap RobertIlisei/marvin && brew install --cask marvin` on a Mac account that has never run MARVIN before → app appears in `/Applications`, opens, sidecar starts, chat round-trips. No `xattr` typing required.

## Scope of Done

- [ ] `sidecar/next.config.ts` carries `output: "standalone"` + the workspace-aware `outputFileTracingRoot`. `pnpm build` produces a runnable standalone tree.
- [ ] `scripts/fetch-node.sh` exists, is idempotent, sha-pins Node 22.x for `darwin-arm64`.
- [ ] `bin/marvin install-macos-app` bundles `node` + `sidecar/` into `Contents/Resources/`. The default install no longer wires a launchd agent (use `--launchd` to opt back in).
- [ ] A new Swift `SidecarManager` spawns the bundled sidecar on app launch when running from `/Applications`, falls back to "external sidecar" otherwise, and tears down on `applicationWillTerminate`.
- [ ] `.github/workflows/release.yml` exists, builds + zips + uploads on `v*` tags, computes sha256.
- [ ] `RobertIlisei/homebrew-marvin` carries `Casks/marvin.rb` pointing at the v0.1.0 release zip with the correct sha256. `brew install --cask marvin` succeeds end-to-end on a clean account.
- [ ] ADR-0011's deprecation note links forward to this ADR (`Superseded by ADR-0023`).

## Related

- [ADR-0011 — Standalone `.app` via bundled Node sidecar (Deprecated)](./0011-sidecar-node-bundling.md) — the prior attempt; this ADR supersedes it under a different distribution model.
- [ADR-0016 — SwiftUI macOS migration](./0016-swift-migration.md) — the migration that made the Swift app the canonical shell.
- [ADR-0021 — Remove WKWebView ghost; fully-native Swift macOS app](./0021-webview-removal-fully-native-swift.md) — confirms the sidecar is purely an HTTP API, not a webview source.
- [Next.js standalone output](https://nextjs.org/docs/app/api-reference/next-config-js/output).
- [Homebrew cask reference](https://docs.brew.sh/Cask-Cookbook).
