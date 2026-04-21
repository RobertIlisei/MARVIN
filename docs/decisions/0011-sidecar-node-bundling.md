# ADR-0011 — Standalone `.app` via bundled Node sidecar

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0010 — Desktop wrapper via Tauri](./0010-desktop-wrapper-tauri.md)

## Context

ADR-0010 shipped the MARVIN desktop window as a thin Tauri 2 wrapper whose main window points at `http://localhost:3030`. The explicit v1 compromise was: *the user runs `bin/marvin` in a terminal first; the `.app` just gives them a window, dock icon, and menu bar.* That shipped fast and preserved every IDE-mode feature without a second implementation.

The compromise is now the friction. A non-technical (or non-MARVIN-hacker) user who double-clicks `MARVIN.app` expects it to work. Today they get "can't connect to localhost:3030". For MARVIN to feel like a real app instead of a companion window, the `.app` has to start its own server.

Two realistic ways to make the `.app` self-contained:

1. **Bundle Node.js + the Next.js standalone output as a Tauri "sidecar"**, spawned on app start. Pure engineering — no runtime architecture change.
2. **Rewrite the web server as a native-embedded server** (Rust HTTP server inside Tauri). Eliminates Node but throws away months of Next.js work.

Option 2 is obviously wrong. We ship (1).

## Decision

Add a sidecar Node binary + Next.js standalone build to the Tauri `.app` production bundle. Tauri's Rust `setup()` spawns it before the window opens (only in release builds); the window URL still points at `http://localhost:3030`; `WindowEvent::CloseRequested` tears it down.

### Architecture

```
MARVIN.app/
└── Contents/
    ├── MacOS/
    │   ├── MARVIN                     ← Tauri native binary
    │   └── node-aarch64-apple-darwin  ← sidecar (Tauri names it per-triple)
    └── Resources/
        └── next/                      ← Next.js standalone output
            ├── server.js              ← the sidecar entry-point
            ├── .next/
            └── apps/web/              ← pnpm-workspace layout preserved
```

### The five pieces

1. **Next.js standalone output.** `apps/web/next.config.ts` gains `output: "standalone"` + `outputFileTracingRoot: path.join(__dirname, "../..")` so the monorepo root (where `@marvin/*` workspace packages live) is traced. `next build` then emits `apps/web/.next/standalone/` with a minimal runtime + only the deps the server touches.

2. **Node binary fetch.** New `scripts/fetch-node.sh` downloads a pinned Node 22 for `aarch64-apple-darwin` and lays it down at `apps/desktop/src-tauri/binaries/node-aarch64-apple-darwin`. Not checked into git (~60 MB); produced on demand by `pnpm desktop:build`. The script is idempotent — re-runs skip if the binary is already present with the expected hash.

3. **Tauri config — resources + externalBin.** `tauri.conf.json` declares `bundle.externalBin: ["binaries/node"]` (Tauri resolves the triple suffix per-target) and `bundle.resources: ["resources/next/**"]` so the standalone dir gets copied into the `.app`'s `Resources/`.

4. **Rust spawn + kill.** `src-tauri/src/lib.rs` gets a `SIDECAR` global (parking_lot `Mutex<Option<CommandChild>>`). In `setup()`, `#[cfg(not(debug_assertions))]` spawns the sidecar with `PORT=3030 HOSTNAME=127.0.0.1` and the resolved path to `server.js`. `on_window_event` watches for `CloseRequested` and kills it. Dev builds (`pnpm desktop:dev`) skip this entirely — `bin/marvin` is still the path for development, matching ADR-0010.

5. **Boot delay in JS.** The Tauri window loads `http://localhost:3030` synchronously; if the sidecar isn't yet listening, the user sees a "connection refused" page. The existing `marvin_server_is_up` Rust command plus a small TS polling loop shows a "starting MARVIN server…" splash for the ~1–3 seconds between app-open and server-ready.

### Sizing

- Node binary (stripped): ~60 MB per arch
- Next.js standalone output (apps/web + traced deps): ~40–80 MB
- Existing Tauri binary: ~10 MB
- Total `.app` size: ~110–150 MB

Still ~5× smaller than the equivalent Electron app, and amortised against a self-contained experience.

## Consequences

**Positive:**

- Double-click the `.app` → it works. Dock-icon-first UX parity with Zed / VS Code / Xcode.
- No behaviour change in `pnpm desktop:dev` — developer flow unchanged.
- Everything IDE-mode, every ADR-0008 security invariant, every test — all still run inside the same Next.js. The sidecar is operational plumbing, not a new runtime.
- Falls back gracefully on dev machines that skip the fetch — `pnpm desktop:dev` still works as ADR-0010 described.

**Negative:**

- Build pipeline gains two new moving parts (Node fetch, bundle step). Cached on successful fetch, but the first build on any machine is slower.
- Sidecar failures (missing binary, port collision, Next startup error) need surfacing clearly. MVP: splash screen polls `marvin_server_is_up`; retry-with-exponential-backoff + a visible error after 15s.
- Sidecar crashes mid-session (Node OOM, segfault, app-level JS error) will leave the window pointed at a dead server. Out of scope for v1 — keep an eye on it.
- `.app` size jumps ~120 MB. Still smaller than Electron but no longer "tiny".

## Alternatives considered

### Ship a native Rust HTTP server

*What it is:* Rewrite `apps/web`'s API routes as a Rust `axum` or `actix-web` app. Tauri serves it in-process.

*Why plausible:* Smallest possible `.app` (~15 MB). No sidecar at all.

*Why rejected:* Abandons every feature the `apps/web` stack gives us for free — Next.js routing, React SSR, monaco/xterm/diff-viewer integration, hot reload in dev. Months of work to reconstruct. Completely inverts MARVIN's "one implementation, three deployment modes" invariant from ADR-0010.

### Ship Node binary on first launch (download on demand)

*What it is:* `.app` ships without Node; on first open, downloads from nodejs.org.

*Why plausible:* Smallest initial download (~15 MB).

*Why rejected:* Needs network at first open — breaks offline environments. Adds "first launch is slow + needs internet" footgun. Notarization gets trickier (downloaded binaries can't be notarized with the app). Not a real win for a dev tool.

### Universal binary (x86_64 + aarch64 in one)

*What it is:* `lipo` the Node binary to ship both architectures.

*Why plausible:* One `.app` for every Mac.

*Why rejected for v1:* Doubles the Node binary to ~120 MB. Until we actually have Intel-Mac users asking for it, aarch64-only is the pragmatic shipment. Tauri's `externalBin` naming already supports the x86_64 path; flipping it on is a one-line config change when needed.

### Systemd-/launchd-style auto-start of `bin/marvin`

*What it is:* Install a launchd agent that runs `bin/marvin` as a background service; `.app` just opens a window.

*Why plausible:* Server restart across reboots. Persistent.

*Why rejected:* Installer complexity. launchd plists require root for system-level or careful user-level staging. Users expect `.app` drag-to-Applications to be the install path; a launchd agent breaks that promise. Better as an opt-in "run MARVIN in the background" feature later.

## Verification

- `cargo check` green on the Tauri crate with the sidecar path compiled in.
- `pnpm desktop:dev` still works as ADR-0010 described (no sidecar spawned; `bin/marvin` still the server).
- `pnpm desktop:build` runs `scripts/fetch-node.sh` → `apps/desktop/scripts/bundle-resources.sh` → `tauri build` in sequence. Output is `MARVIN.app` with Node + next embedded.
- Launching `MARVIN.app` with no prior server running opens the window; splash persists ~1–3 s while the sidecar boots; then MARVIN's UI renders.
- Closing the window terminates the sidecar (verify via `ps aux | grep node`).
- Port collision: if port 3030 is already bound, the sidecar fails cleanly and the splash shows the error. v1 doesn't retry on a different port.

## Follow-ups (explicitly NOT in this PR)

- **Universal binary** — x86_64 support for Intel Macs. Tauri config supports it; fetch script needs another target triple; bundle size doubles.
- **Code signing + notarization** — unchanged from ADR-0010's follow-ups. Sidecar Node binary needs to be signed alongside the main binary.
- **Auto-updater** — Tauri's updater plugin, wire up to a release feed.
- **Crash recovery** — if the sidecar dies mid-session, respawn + reload the window.
- **Port auto-selection** — find a free port instead of pinning 3030; pass it to both the sidecar env and the window URL.

Each is its own PR when the need surfaces.

## Related

- [ADR-0010 — Desktop wrapper via Tauri](./0010-desktop-wrapper-tauri.md) — the thin-wrapper v1 this ADR extends.
- [`apps/desktop/src-tauri/src/lib.rs`](../../apps/desktop/src-tauri/src/lib.rs) — sidecar spawn/kill implementation.
- [`scripts/fetch-node.sh`](../../scripts/fetch-node.sh) — Node binary download.
- [Tauri 2 sidecar docs](https://tauri.app/develop/sidecar/).
- [Next.js standalone output](https://nextjs.org/docs/app/api-reference/next-config-js/output).
