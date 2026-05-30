---
description: Rebuild MARVIN.app from source and reinstall to ~/Applications.
---

Rebuild and reinstall MARVIN.app — the full ritual that turns the
working tree into a running desktop app. Use after sidecar or macOS
changes you want to see in the installed app, or to recover from a
stale bundle (e.g. the native-binary symlink that bit us 2026-05-22).

Run `bin/marvin install-macos-app --bundled` and stream its log to the
chat. That subcommand:

1. Runs `pnpm build` (if the standalone tree is stale).
2. Runs `scripts/bundle-sidecar.sh` to assemble
   `MARVIN.app/Contents/Resources/{node,sidecar}`. The bundler restores
   the pnpm sibling symlinks Next's tracer drops and trims cross-arch
   sharp libvips variants before sealing the bundle.
3. Boots the bundled tree on a probe port and hits `/api/health` —
   fails loudly if anything regressed.
4. Copies the verified `.app` into `~/Applications/MARVIN.app`.

After it lands, suggest `bin/marvin status` so the user can see the
new build picked up. If `--launchd` is wanted (auto-start at login),
the user can add the flag themselves; default is one-shot install.
