# @marvin/desktop

MARVIN packaged as a native macOS app via [Tauri 2](https://tauri.app).

The desktop target is a **thin native shell** around the existing
`apps/web` Next.js server. The Tauri window points at
`http://localhost:3030`; the web app does the actual work. This keeps
every feature MARVIN already ships (tree, editor, chat, graph,
terminal, cost pill, confirm gate, the lot) working without a second
implementation.

See [ADR-0010](../../docs/decisions/0010-desktop-wrapper-tauri.md) for
the *why* (Tauri vs Electron vs SwiftUI, the localhost-wrapper pattern,
what's deferred to v2).

## Prerequisites

1. **Everything MARVIN already needs** — Node 22, pnpm, credentials.
2. **Rust toolchain.** Tauri compiles a native Rust binary.

   ```bash
   # One-shot install — per-user, to ~/.cargo and ~/.rustup
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal

   # Or, if you prefer Homebrew:
   brew install rustup && rustup-init -y --default-toolchain stable --profile minimal

   # Either way, restart your shell or source the env once:
   . "$HOME/.cargo/env"
   ```

   Verify: `cargo --version` + `rustc --version` both print a version.

3. **Xcode Command Line Tools** — for the linker + macOS SDK headers.
   Most devs already have this. If not: `xcode-select --install`.

## Dev (hot-reload the native shell against the live dev server)

```bash
# Terminal 1 — start MARVIN's web server
bin/marvin                 # or: pnpm dev, if you prefer foreground

# Terminal 2 — start the Tauri window
pnpm --filter @marvin/desktop dev
```

Tauri opens a window pointed at `http://localhost:3030`. Hot-reload
works the same way it does in a browser tab — Next.js HMR inside
Tauri's WKWebView.

## Build a `.app` + `.dmg`

```bash
pnpm --filter @marvin/desktop build
```

The `prebuild` hook runs two scripts before `tauri build`:

1. `scripts/fetch-node.sh aarch64-apple-darwin` — downloads Node 22
   into `src-tauri/binaries/node-aarch64-apple-darwin` (~60 MB, cached
   on subsequent builds).
2. `apps/desktop/scripts/bundle-resources.sh` — builds `apps/web` in
   Next.js standalone mode and stages the output to
   `src-tauri/resources/next/` for Tauri to copy into the `.app`.

See [ADR-0011](../../docs/decisions/0011-sidecar-node-bundling.md) for
the full architecture (why sidecar, how the Rust side spawns it, what
v1 leaves out).

Outputs land in `src-tauri/target/release/bundle/`:

- `MARVIN.app` — standalone bundle (~110–150 MB). Spawns its own
  Next.js server on launch; no `bin/marvin` prereq.
- `MARVIN_0.0.1_aarch64.dmg` — DMG installer.

**Unsigned builds** run fine on the build machine but Gatekeeper will
refuse to launch them on any other Mac. Code signing + notarization
are deferred to v2 (see ADR-0010 §"Deferred" and ADR-0011 §"Follow-ups").

### Icon artwork

`src-tauri/icons/` ships a placeholder — a 1024×1024 PNG of a black
"M" on warm paper, matching MARVIN's light-theme palette. It's
legible in Dock, Finder, and ⌘-tab but it's not the final mark.

To swap in real artwork:

```bash
# Drop a 1024x1024 PNG somewhere on disk
pnpm --filter @marvin/desktop tauri icon path/to/my-icon.png
```

Tauri regenerates the full bundle (`icon.icns` + `icon.ico` + every
PNG size Apple / Windows / Android expect).

## How it works

Two distinct modes, one codebase:

**Dev** (`pnpm desktop:dev`)
- Tauri's main window loads `http://localhost:3030`.
- `#[cfg(not(debug_assertions))]` skips the sidecar spawn; the Rust
  side assumes you've already run `bin/marvin` elsewhere.
- HMR works through the webview like a browser tab.
- Fast iteration — no resource bundling, no Node binary fetch.

**Release** (`pnpm desktop:build` → `.app`)
- Before Tauri starts bundling, `prebuild` runs:
  - `scripts/fetch-node.sh` puts a Node 22 binary at
    `src-tauri/binaries/node-<triple>`.
  - `apps/desktop/scripts/bundle-resources.sh` builds `apps/web`
    with `output: "standalone"` and copies `.next/standalone/` plus
    `.next/static/` + `public/` into `src-tauri/resources/next/`.
- Tauri embeds the Node binary as an `externalBin` sidecar and the
  staged Next bundle as a `resources` tree.
- On `MARVIN.app` launch, Rust `setup()` spawns the sidecar with
  `PORT=3030 HOSTNAME=127.0.0.1 NODE_ENV=production node
  Resources/next/apps/web/server.js`.
- The main window loads `http://localhost:3030` once the sidecar is
  listening. The existing `marvin_server_is_up` Tauri command + a TS
  polling loop bridges the ~1-3 s boot delay.
- On `WindowEvent::CloseRequested`, the sidecar gets SIGTERM so Next
  shuts down cleanly.

Native menu bar, dock icon, and menu items come from Tauri's
`MenuBuilder` wiring in `src-tauri/src/lib.rs`. Menu clicks emit
`marvin:menu` Tauri events; the web app's `useTauriMenu()` hook
listens and dispatches to the existing React actions.
`withGlobalTauri: false` + the narrow
[capabilities](./src-tauri/capabilities/default.json) keep the web
shell from reaching Tauri IPC beyond the sidecar spawn + shell.open
for external links.

## What's not in v1

- **Code signing / notarization** — needs an Apple Developer
  certificate.
- **Auto-updater** — Tauri supports it, not wired up.
- **Universal binary (x86_64 + aarch64)** — today aarch64-apple-darwin
  only. `scripts/fetch-node.sh` supports both triples; flipping it on
  is a one-line config change when needed. See ADR-0011 §"Alternatives".
- **Sidecar crash recovery** — if the bundled Next.js sidecar dies
  mid-session, the window is pointed at a dead server. No auto-restart.

## Troubleshooting

**`pnpm --filter @marvin/desktop dev` errors with `cargo not found`**
  → Rust isn't installed or your shell didn't pick it up. Re-run the
  rustup install, then `. "$HOME/.cargo/env"` in the current shell.

**Window opens but shows "can't connect" in `dev` mode**
  → Dev mode intentionally skips the sidecar — it expects `bin/marvin`
  running separately (see ADR-0010). Start it: `bin/marvin`.

**`pnpm desktop:build` fails with `resource path … not found`**
  → The bundle script hasn't staged `resources/next/` yet. Either run
  `apps/desktop/scripts/bundle-resources.sh` manually or rely on the
  `prebuild` script hook which `pnpm desktop:build` invokes
  automatically.

**`pnpm desktop:build` fails with `binaries/node-aarch64-apple-darwin
  not found`**
  → Node hasn't been fetched. Run `scripts/fetch-node.sh
  aarch64-apple-darwin` from the repo root. The `prebuild` hook does
  this for you; if you're running `tauri build` directly, you skip the
  hook.

**`.app` opens but hangs on a blank window for > 5 s**
  → Bundled Next.js is slow to boot, or the sidecar failed. Launch the
  `.app` from Terminal (`open -W /Applications/MARVIN.app --stdout -`)
  to see the sidecar's stdout/stderr — the Rust layer forwards
  `[marvin-server]` / `[marvin-server:err]` lines.

**`pnpm tauri build` fails with an icon-related error**
  → Tauri's codegen embeds the icon at compile time. Repo ships a
  placeholder so first-time builds work. To swap in real artwork:
  `pnpm --filter @marvin/desktop tauri icon path/to/new-icon.png`.
