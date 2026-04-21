# ADR-0010 — Desktop wrapper via Tauri

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN has been a `localhost:3030` browser tab from day one. That shipped v1 faster and the browser gave us diff rendering, font rendering, theme toggling, keyboard shortcuts, and inspector tools for free. Downsides became noticeable once the IDE-mode work (ADR-0008 / ADR-0009) landed and MARVIN *felt* like an IDE:

- **Alt-tab friction** — browser tabs compete with docs, Slack, and whatever else is open; muscle memory for a dev tool is dock icon + ⌘-tab.
- **No dedicated menu bar** — `File`, `Edit`, `View` live in the browser's chrome, not MARVIN's.
- **Session coupling to the browser** — closing the tab by accident isn't catastrophic (the turn registry + session resume handle it) but it's UX noise.
- **Window management quirks** — single-tab full-screen is fiddly in Chrome/Safari; most IDEs get this right natively.

The three realistic ways to ship a desktop wrapper for a localhost web shell:

| Option | Shell | Bundle size | Runtime needed to build |
|---|---|---|---|
| **Tauri** | WKWebView (macOS) / WebView2 (Win) / WebKitGTK (Linux) via Rust | ~10 MB | Rust + Xcode CLT |
| **Electron** | Chromium + Node | ~100 MB | Node (easier) |
| **SwiftUI + `WKWebView`** | WebKit | ~3 MB | Xcode + Swift, macOS only |

## Decision

Ship the macOS desktop target as **a Tauri 2 wrapper around the existing `localhost:3030` web shell**. New workspace package at `apps/desktop/` with a `src-tauri/` crate. Window URL points at `http://localhost:3030`. The web app does the work; Tauri provides the native window, dock icon, menu bar, and build pipeline for `.app` + `.dmg`.

Four load-bearing consequences of this shape:

1. **No second implementation.** Every IDE-mode feature — tree edits, DnD, Monaco editor, confirm gate, ⌘P quick-open, graph iframe, terminal, cost pill — is the same code running in the same Next.js server. No "Tauri-only" forks.

2. **User runs MARVIN separately.** `bin/marvin` is still the way to start the server. The `.app` is purely a window; if the server isn't up, the window shows a browser-style "can't connect" page. A future `marvin-server-is-up` IPC probe (already scaffolded in Rust) can surface a clearer prompt. **We deliberately do NOT bundle Node inside the `.app`** — that's a separate effort (see Deferred).

3. **Security posture inherits from the web app.** The confirm gate (ADR-0004), the user-initiated write channel (ADR-0008), the upload preflight guard (ADR-0009) all still run the same way. Tauri's `capabilities/default.json` is intentionally narrow: `core:default` + `shell:allow-open` for external links. `withGlobalTauri: false` prevents the loaded web shell from calling Tauri's IPC surface unless a capability is explicitly added.

4. **Rust becomes a build-time prereq.** First-time setup on any dev machine now has a `rustup` step. README documents it. The runtime of the `.app` itself doesn't care about Rust once compiled.

### Why Tauri over the other two

**Tauri beats Electron on:**

- **Bundle size.** ~10 MB vs ~100 MB for the same window. For a desktop pair-programmer people will leave running, the 10× difference matters over months.
- **Memory footprint at runtime.** WKWebView shares the system WebKit; Electron ships its own Chromium. Side-by-side, Tauri idles at ~30 MB where Electron idles at ~250 MB.
- **macOS-native integration.** WKWebView honours system accent colour, scrollbar behaviour, and accessibility features without translation. Electron's Chromium always looks slightly "web" on Mac.

**Tauri beats SwiftUI + WKWebView on:**

- **Single codebase covers Windows + Linux eventually** if we ever decide to ship beyond macOS. The desktop crate is mostly Rust; the native-side work is tiny. SwiftUI is macOS-only.
- **Cargo + Tauri CLI is a better developer ergonomics story** than Xcode + Swift Package Manager for a dev-tools team whose primary stack is TypeScript. Rust ownership model is a one-time learning curve rather than an ongoing one.

**Where Electron wins, and why we don't care:**

- Electron has zero Rust-install friction. Fair; we accept the rustup step.
- Electron's Node bundling makes the "ship a sidecar server" story easier. Also fair — and also why we're deferring that until we need it.

## Consequences

**Positive:**

- Dock icon + `⌘-tab` + native menu bar — MARVIN now fits the muscle memory of a pro dev tool.
- `.app` bundle can be dropped in `/Applications` alongside VS Code / Zed / Xcode. Not a browser tab any more.
- Small bundle (~10 MB) keeps distribution friction low.
- Everything IDE-mode ships unchanged; no Tauri-specific code paths to maintain.
- Security posture unchanged — same confirm gate, same write policy, same upload preflight.

**Negative:**

- First-time setup gains a `rustup` step on the Rust prereq. Documented in `apps/desktop/README.md`.
- Tauri 2 is relatively new — some niche plugins haven't migrated. We rely only on `tauri-plugin-shell` for external links, so this is a low blast radius.
- Code signing + notarization cost real Apple Developer $ + a manual submission step. Deferred to when we want to ship builds to people outside the build machine.
- The current design requires the user to have MARVIN's web server running separately. Until the sidecar-bundling story ships, the `.app` is a companion to `bin/marvin`, not a replacement.

## Alternatives considered

### Electron

*What it is:* Chromium + Node.js packaged with the web shell.

*Why plausible:* Zero Rust-install friction. Abundant plugin ecosystem. Node is already a MARVIN prereq — an Electron build could bundle the Next.js server as a sidecar for free, solving the "user runs MARVIN separately" problem that v1 Tauri doesn't.

*Why rejected:* 10× bundle size + 5–8× memory footprint is the long-term cost we'd pay for the short-term sidecar ergonomics. The sidecar problem is independently solvable under Tauri with `cargo tauri bundle --sidecar`; the bundle-size problem is irreducible under Electron.

### SwiftUI + WKWebView

*What it is:* Native macOS app written in Swift, hosts a WKWebView pointed at `localhost:3030`.

*Why plausible:* Smallest bundle of the three. Access to every macOS API Apple ships. No extra runtime dependencies for the build. If we only ever ship on Mac, the cost is minimal.

*Why rejected:* macOS-only. Locks out Windows and Linux indefinitely. The "only ever Mac" assumption is brittle — Claude Code ships everywhere, and if MARVIN grows beyond one developer we'll want that optionality. Plus: the team's primary stack is TypeScript, not Swift. Ongoing Swift maintenance cost is a tax we'd rather not take on for a thin window wrapper.

### No wrapper — stay as a browser tab forever

*What it is:* Accept that MARVIN is a web app and call it done.

*Why plausible:* Zero new dependencies, zero new build pipeline. Every IDE-mode feature works today.

*Why rejected:* Doesn't fix the UX problems that motivated this. Alt-tab friction, missing menu bar, tab-closure footgun. Once MARVIN's UX *feels* like an IDE (which ADR-0008 got us to), *being* a browser tab is the last thing holding it back from muscle-memory parity with the tools it competes with.

### Bundle Node + Next.js inside the `.app` on day one

*What it is:* Ship a self-contained `.app` that starts its own Next.js server on launch and points the window at it.

*Why plausible:* The cleanest UX — user double-clicks the app, it works. No `bin/marvin` prereq.

*Why rejected for v1:* Scope creep. Bundling Node inside a Tauri app is a non-trivial sidecar orchestration: Node binary per arch (x86_64 + aarch64), standalone Next.js output mode, environment wiring, graceful shutdown on app close. Each of those is a separate can of worms. Shipping a working wrapper with the user-runs-`bin/marvin`-separately model is the 80 % solution at 20 % of the effort; the 100 % solution is its own ADR when we want it.

## Verification

- `pnpm --filter @marvin/desktop dev` opens a Tauri window; the window loads MARVIN's web shell (given `bin/marvin` is running).
- `pnpm --filter @marvin/desktop build` (after dropping an icon into `src-tauri/icons/icon.png` and running `pnpm tauri icon`) produces `MARVIN.app` + `MARVIN_*.dmg` under `src-tauri/target/release/bundle/`.
- The `.app` launched on a second Mac **without Rust installed** runs correctly — Rust is build-time only.
- The `capabilities/default.json` grants only `core:default` + `shell:allow-open`; the web shell inside the window can't reach Tauri's IPC beyond those.
- Typecheck, lint, tests all remain green across the monorepo — `apps/desktop` doesn't touch the rest.

## Related

- [ADR-0004 — Structural confirm gate](./0004-structural-confirm-gate.md) — the gate still runs, unchanged, inside the Tauri-hosted web shell.
- [ADR-0008 — User-initiated write channel](./0008-user-initiated-write-channel.md) — same deal; the desktop window is a UI surface, not a new write channel.
- [ADR-0009 — File uploads from OS](./0009-file-uploads-from-os.md) — the `X-Marvin-Client` preflight-forcing header still applies; the Tauri webview is a same-origin caller like any browser tab.
- [`apps/desktop/README.md`](../../apps/desktop/README.md) — user-facing setup + troubleshooting.
- [Tauri v2 docs](https://tauri.app/start/) — upstream.
