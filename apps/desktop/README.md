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

## Install as a real macOS app _(recommended)_

One command builds the `.app`, drops it in `/Applications/`, and
installs a launchd user agent so MARVIN's web server auto-starts
in the background on every login. After that, double-click MARVIN
from Spotlight / Launchpad / Dock and the window opens straight
into the UI — no terminal needed.

```bash
bin/marvin install-app
```

What happens:

1. Builds the `.app` via `pnpm --filter @marvin/desktop build`
   (~1 min on a cold Cargo cache, seconds after that).
2. Copies `MARVIN.app` to `/Applications/`.
3. Writes `~/Library/LaunchAgents/net.marvin.desktop.server.plist`
   that runs `pnpm dev` in the MARVIN repo on every login —
   `KeepAlive.NetworkState` restarts it if it ever exits.
4. `launchctl load` brings the agent up immediately (no logout
   required the first time).
5. Waits for `/api/health` on port 3030 before claiming success.

After install:

- **Logs:** `tail -f .marvin/launchd-stderr.log`
- **Uninstall:** `bin/marvin uninstall-app` — unloads the agent,
  removes `/Applications/MARVIN.app`. Source tree + `~/.marvin/`
  are left alone.

### What the install baked in

The launchd plist captures absolute paths at install time:

- `pnpm` abspath (so launchd doesn't need PATH discovery)
- MARVIN repo root (so `WorkingDirectory` is correct)
- The current shell's `PATH` (inherits Node / Cargo / etc.)

**If you move the MARVIN source directory, re-run `install-app`.**
The plist binds to the location where it was installed.

## Build a `.app` + `.dmg` _(without auto-start)_

```bash
pnpm --filter @marvin/desktop build
```

Outputs land in `src-tauri/target/release/bundle/`:

- `MARVIN.app` — the macOS app bundle
- `MARVIN_1.0.0_aarch64.dmg` — the DMG installer

Drag the `.app` to `/Applications/` yourself. You'll still need to
run `bin/marvin` in a terminal before double-clicking MARVIN,
since without the launchd agent nothing's serving port 3030.

**Unsigned builds** run fine on the build machine but Gatekeeper will
refuse to launch them on any other Mac. Code signing + notarization
are deferred (see ADR-0010 §"Deferred").

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

- **Sidecar Node server inside the `.app` bundle** — see
  [ADR-0011](../../docs/decisions/0011-sidecar-node-bundling.md) for
  why that was tried and rolled back (binary-size blowup, signing
  churn, runtime drift). `bin/marvin install-app`'s launchd agent is
  the current pragmatic substitute.
- **Code signing / notarization** — needs an Apple Developer
  certificate. Unsigned `.app` works but triggers Gatekeeper on
  first open; right-click → Open once to trust it.
- **Auto-updater** — Tauri supports it, not wired up.
- **Native menus beyond the current ones** — the macOS menu bar
  already has File / Edit / View / Window / Help with keyboard
  accelerators (see `src-tauri/src/lib.rs`). Per-feature additions
  are ongoing.

## Troubleshooting

**`pnpm --filter @marvin/desktop dev` errors with `cargo not found`**
  → Rust isn't installed or your shell didn't pick it up. Re-run the
  rustup install, then `. "$HOME/.cargo/env"` in the current shell.

**Window opens but shows "can't connect"**
  → The MARVIN web server isn't running. If you installed via
  `bin/marvin install-app`, check the launchd agent:

  ```bash
  launchctl list | grep net.marvin.desktop
  tail -40 .marvin/launchd-stderr.log
  ```

  Re-running `install-app` is idempotent and re-loads the agent.
  If the logs show repeated crashes, fall back to a foreground
  run to surface the real error:
  `bin/marvin uninstall-app && bin/marvin start`.

  If you never installed the agent, start the server by hand in
  another terminal: `bin/marvin`.

**`bin/marvin install-app` says `cargo not found`**
  → Rust toolchain missing or not on PATH. See Prerequisites
  above. `install-app` auto-sources `$HOME/.cargo/env` if that
  file exists; if not, re-run the rustup install.

**Gatekeeper blocks the first launch** ("can't be opened because
Apple cannot check it for malicious software")
  → The `.app` isn't signed / notarised. Right-click the icon →
  Open → Open. macOS remembers the choice.

**`pnpm tauri build` fails with an icon-related error**
  → Tauri's codegen embeds the icon at compile time. Repo ships a
  placeholder so first-time builds work. If the placeholder is
  corrupted or you're ready to swap in real artwork, regenerate the
  bundle: `pnpm --filter @marvin/desktop tauri icon path/to/new-icon.png`.
