# ADR-0027 — Install MARVIN.app to `~/Applications`, not `/Applications`

**Status:** Accepted — 2026-05-20
**Supersedes part of:** [ADR-0023](./0023-brew-distributable-bundled-sidecar.md) (install location)
**Related:** [ADR-0016](./0016-swift-migration.md), [ADR-0026](./0026-release-artefact-signing-minisign.md)

## Context

ADR-0023 standardised MARVIN's macOS distribution: an ad-hoc-signed `MARVIN.app`
with a bundled Node 22 runtime + Next.js standalone sidecar in
`Contents/Resources/`, installed to `/Applications/MARVIN.app` either by
`bin/marvin install-macos-app` (dev path) or by the Homebrew cask
`marvin-ai` (user path).

That model worked on macOS 14 / 15. It does **not** work on macOS 26 (Tahoe).

### What we observed on macOS 26 (Darwin 25.3.0, 2026-05-20)

Verified empirically against the exact same `MARVIN.app` bundle:

| Launch path                                           | Process state         | UI |
|-------------------------------------------------------|-----------------------|----|
| `/Applications/MARVIN.app/Contents/MacOS/MARVIN`      | RSS 32 KB, STAT=S     | none — killed at exec |
| `~/Applications/MARVIN.app/Contents/MacOS/MARVIN`     | RSS 152 MB, STAT=R    | renders normally |
| `/tmp/MARVIN.app/Contents/MacOS/MARVIN`               | RSS 148 MB, STAT=R    | renders normally |

The kill is **path-specific** — same bundle, same code signature, same xattrs,
different parent directory, different outcome. It's a new kernel-level
Gatekeeper enforcement in macOS 26 specifically targeting `/Applications`
for ad-hoc-signed (non-notarized) bundles.

### What we tried that didn't work

- `xattr -rc <bundle>` — strips `com.apple.quarantine`, doesn't help.
- Fresh `codesign --force --deep --sign -` — re-signs cleanly, doesn't help.
- Removing `com.apple.provenance` — SIP-protected, `xattr -d` returns silently.
- `spctl --master-disable` — Gatekeeper "disabled", binary still killed.
- `brew install --cask marvin-ai` — brew strips quarantine, binary still killed.

The check is enforced at process exec time by the kernel based on the
parent directory. There is no user-space override.

### What Apple expects

The official solution is Developer ID signing + notarization
([ADR-0026](./0026-release-artefact-signing-minisign.md) Phase 3
captures the future path). That requires a paid Apple Developer Programme
membership ($99/yr) which the maintainer explicitly does not want.

## Decision

**Install MARVIN.app to `~/Applications/MARVIN.app` instead of
`/Applications/MARVIN.app`.**

`~/Applications` is the standard user-scope Applications directory recognised
by Finder, Spotlight, Launchpad, and the Dock. It exists on every macOS
version. It is **not subject to the macOS 26 kernel-level Gatekeeper check**
that kills ad-hoc bundles in `/Applications`.

### Implementation

1. `bin/marvin`:
   `MACOS_APP_BUNDLE_DIR="$HOME/Applications/${MACOS_APP_NAME}.app"`.
   Install logic creates `~/Applications` if absent (`mkdir -p`),
   migrates a stale `/Applications/MARVIN.app` left over from older
   installs (quit, remove), and points all status output at the new path.
2. `uninstall-macos-app` removes the bundle from **both** locations so
   upgrade paths clean up cleanly.
3. Homebrew cask (`marvin-ai.rb`):
   `app "MARVIN.app", target: "~/Applications/MARVIN.app"`.
4. `caveats` in the cask + the relevant `README.md` install section
   document the **one-time** System Settings dance for new users:
   *Privacy & Security → "MARVIN.app was blocked..." → Open Anyway*.
   This is the standard user-space Gatekeeper popup that still fires
   on first Finder launch of any ad-hoc-signed app on macOS 26. It's
   a single click, not a workflow blocker, but if we don't document
   it new users will assume the brew install is broken.

### What this doesn't fix

The user-space Gatekeeper popup ("Apple could not verify "MARVIN.app" is
free of malware…") still appears on first Finder launch. On macOS 26
the right-click → Open shortcut Apple shipped for years has been removed;
the only way through is System Settings → Privacy & Security → Open Anyway.
This is one-time, persists across launches, and is the unavoidable price
of ad-hoc signing on 26+. Notarization (Phase 3 of ADR-0026, blocked on
not having a $99/yr Developer ID) is the only thing that removes this popup.

## Consequences

**Positive**
- Brew install works on macOS 26 (once the user does the one-time whitelist).
- No paid Apple Developer Programme membership required.
- Same install path on macOS 14 / 15 / 16 / 26 — no version-conditional code.
- Cleans up after the legacy `/Applications/MARVIN.app` automatically.

**Negative / mitigated**
- `~/Applications` is unfamiliar to users who expect apps in `/Applications`.
  *Mitigated:* Spotlight + Launchpad + Finder all index it. The Dock pin
  works the same way.
- First-launch Gatekeeper popup still fires. *Mitigated:* documented
  prominently in cask `caveats`, README install section, and the
  `OnboardingView`'s Setup step.
- Migration step in `cmd_install_macos_app` runs `pkill` against the
  legacy bundle. *Mitigated:* `pkill -f` scoped to the exact bundle
  path; can't false-match other processes.

**Reversibility**
This decision is fully reversible. The day MARVIN ships Apple-notarised
binaries (ADR-0026 Phase 3), we can move the cask target back to
`/Applications` without breaking anything — `~/Applications` and
`/Applications` are equally valid macOS app install locations.

## Scope of Done

- [x] `bin/marvin install-macos-app` installs to `~/Applications/MARVIN.app`.
- [x] `bin/marvin uninstall-macos-app` removes from both `~/Applications` and `/Applications`.
- [x] Legacy `/Applications/MARVIN.app` is auto-migrated on next install.
- [ ] Homebrew cask `marvin-ai.rb` retargets to `~/Applications` (bumped in next cask version).
- [ ] README install section explains the one-time Privacy & Security click-through.
- [x] ADR captures the macOS 26 kernel-level behaviour for posterity.
