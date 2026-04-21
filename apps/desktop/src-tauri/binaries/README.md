# Sidecar binaries

Tauri's `externalBin` config (see `../tauri.conf.json`) requires each
declared sidecar to exist at build time — even for `cargo check` on
dev builds where the Rust code is `#[cfg(not(debug_assertions))]`'d
out. The `node-<triple>` files here are **stubs** so the build
succeeds on a fresh clone without running the fetch script.

Before `pnpm desktop:build`, run:

```bash
./scripts/fetch-node.sh aarch64-apple-darwin
```

That downloads Node 22 and overwrites `node-aarch64-apple-darwin`
with the real ~60 MB binary. See [ADR-0011](../../../../docs/decisions/0011-sidecar-node-bundling.md).

The stubs themselves only print an error and exit 1 — if `MARVIN.app`
ever tries to spawn one of them, something went wrong with the build
pipeline.
