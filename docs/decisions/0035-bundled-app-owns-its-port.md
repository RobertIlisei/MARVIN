# ADR-0035 — The bundled app owns its port: reclaim-then-spawn + version-stamped health

**Status:** Accepted — 2026-06-10
**Touches:** `SidecarManager.swift`, `/api/health`

## Context

Three releases in a row (v0.1.16 → v0.1.18) shipped features that were
**not actually running** after install. Mechanism, confirmed live on
2026-06-10: a sidecar leaked by an earlier app instance (crash or
force-kill skips `applicationWillTerminate`, the node child reparents to
launchd and keeps `:3030` bound). On the next install + launch,
`SidecarManager.start()` spawned its node child blindly; the child died on
EADDRINUSE while the app — which never checks who answers the port —
silently talked to the **stale** server. New `.app` on disk, six-day-old
code in memory. New API routes 404'd; the v0.1.17 advisor agent never
registered. Nothing surfaced the mismatch because `/api/health` carried no
version field.

## Decision

1. **Reclaim-then-spawn.** In bundled mode, `start()` first kills any
   listener on the sidecar port (`lsof -ti tcp:<port> -sTCP:LISTEN` →
   SIGTERM, 1.5 s grace, SIGKILL leftovers), then spawns. Deliberately
   unconditional — even a same-version listener is replaced. "Kill and
   respawn" is deterministic; "probe and adopt" is exactly what left us
   serving stale code. Dev builds (no bundled payload) keep the existing
   behaviour: external `pnpm dev` sidecar expected, nothing killed.
2. **Version-stamped health.** The spawn injects
   `MARVIN_APP_VERSION` (= the app's `CFBundleShortVersionString`);
   `/api/health` reports it as `version` (null = dev sidecar or
   pre-0.1.19 bundle). Release verification and the About surface can now
   assert *the serving process* matches the bundle on disk.

Consequence accepted: a user who intentionally runs `pnpm dev` on the
port and then launches the **installed** app loses the port — the
installed app owns it by design. The dev loop (swift run / Xcode, no
bundled payload) is unaffected.

## Scope of Done

- [ ] Launching the bundled app with a stale listener on the port kills
      it and serves from the freshly spawned sidecar.
- [ ] `/api/health` reports `version` equal to the app bundle's version.
- [ ] Dev mode (no bundled payload) behaviour unchanged.
- [ ] Verified live on the next release install (no manual `kill`).
