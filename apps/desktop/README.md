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

Outputs land in `src-tauri/target/release/bundle/`:

- `MARVIN.app` — the macOS app bundle
- `MARVIN_0.0.1_aarch64.dmg` (or x86_64) — the DMG installer

**Unsigned builds** run fine on the build machine but Gatekeeper will
refuse to launch them on any other Mac. Code signing + notarization
are deferred to v2 (see ADR-0010 §"Deferred").

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

- The Tauri main window's `url` field (set in
  `src-tauri/tauri.conf.json`) points at `http://localhost:3030`.
- On launch, the window loads the MARVIN web shell as if the user
  opened `http://localhost:3030` in their browser.
- If the dev server isn't running, the window loads a Safari "can't
  connect" page. The Rust side exposes `marvin_server_is_up` — a
  future PR can use it to surface a proper "start MARVIN first"
  prompt.
- Native menu bar + dock icon come from Tauri's defaults.
- `withGlobalTauri: false` and the narrow
  [capabilities](./src-tauri/capabilities/default.json) keep the web
  shell from accidentally gaining native privileges.

## What's not in v1

- **Sidecar Node server** — the `.app` expects the user to run MARVIN
  separately via `bin/marvin`. Bundling a Node runtime inside the app
  is a separate effort.
- **Code signing / notarization** — needs an Apple Developer
  certificate.
- **Auto-updater** — Tauri supports it, not wired up.
- **Native menus beyond defaults** — the macOS menu bar shows Tauri's
  stock menu; a MARVIN-specific one (with Toggle Tree, Toggle Graph,
  etc.) is deferred.

## Troubleshooting

**`pnpm --filter @marvin/desktop dev` errors with `cargo not found`**
  → Rust isn't installed or your shell didn't pick it up. Re-run the
  rustup install, then `. "$HOME/.cargo/env"` in the current shell.

**Window opens but shows "can't connect"**
  → The MARVIN web server isn't running. Start it in another terminal:
  `bin/marvin`.

**`pnpm tauri build` fails with an icon-related error**
  → Tauri's codegen embeds the icon at compile time. Repo ships a
  placeholder so first-time builds work. If the placeholder is
  corrupted or you're ready to swap in real artwork, regenerate the
  bundle: `pnpm --filter @marvin/desktop tauri icon path/to/new-icon.png`.
