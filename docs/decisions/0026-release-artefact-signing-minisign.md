# ADR-0026 — Release artefact signing via minisign

**Status:** Accepted
**Date:** 2026-05-20
**Deciders:** @robertilisei, MARVIN
**Extends:** [ADR-0023 — Brew-distributable `.app` via bundled Node sidecar](./0023-brew-distributable-bundled-sidecar.md)
**Closes:** Audit 🔴 #4 (cask formula at `RobertIlisei/homebrew-marvin` is an unaudited dependency) from [`docs/reviews/2026-05-17-full-security-audit.md`](../reviews/2026-05-17-full-security-audit.md).

## Context

ADR-0023 shipped the brew-distribution path: `MARVIN.app` is built ad-hoc-signed by `release.yml`, uploaded to a GitHub Release, and `RobertIlisei/homebrew-marvin`'s `Casks/marvin-ai.rb` pins the download URL + sha256 so `brew install --cask marvin-ai` fetches and installs.

The 2026-05-17 security audit's 🔴 #4 flagged a real gap in that chain: **the cask formula itself is an unaudited dependency.** sha256 in the cask only proves "the downloaded zip matches what the cask says you should get" — but if an attacker compromises the `homebrew-marvin` tap repo, they can change BOTH the URL (point at their malicious zip) AND the sha256 (match their zip) in the same commit. The user's `brew install` would then transparently install a backdoored MARVIN. sha256 alone is integrity, not authenticity.

Three real-world threat shapes this addresses:

1. **Tap-repo compromise.** Someone gains write access to `RobertIlisei/homebrew-marvin` (stolen token, social engineering, future contributor turning malicious) and ships a backdoored cask + matching zip.
2. **GitHub Release tamper.** Someone with write access to the MARVIN repo replaces a release zip with a backdoored one. The tap's sha256 is now wrong, but a `brew install` against a NEW user (no prior install) would silently get the new zip + a tap commit that bumps the sha.
3. **GitHub-side MitM.** A network attacker between brew and `objects.githubusercontent.com` can't currently swap content because sha256 catches it, but adds defence-in-depth.

Apple notarization would close all three, but requires a $99/yr Developer ID and adds notarytool to every release. We deliberately ruled that out in ADR-0023. Minisign offers the same authenticity property at zero cost.

## Decision

Sign every release zip with [`minisign`](https://jedisct1.github.io/minisign/) in CI; publish the public key out-of-band on the MARVIN repo's README and on the tap repo's README. The cask formula references the public key + the `.minisig` file URL; users (or, in a later phase, the cask itself) verify before trusting the artefact.

### Why minisign and not GPG / cosign / sigstore

- **GPG** — heavy keyring management, web-of-trust theatre, signature format opaque. Every team that ships software has fought a "what gpg key version, what subkey, why is this key expired" battle. Avoid.
- **cosign / sigstore** — designed for container/OCI artefacts + transparency logs. Overkill for "sign this zip." Free if you accept the Sigstore TUF root + Fulcio CA dependency; that's a bigger trust surface than minisign's `pubkey + sig` pair.
- **minisign** — single static binary, EdDSA signatures, one-file pubkey, one-file signature. Created by the same author as libsodium and PASETO; the de-facto standard for "sign a release tarball" in modern OSS (WireGuard, curl, ZeroTier, Tailscale's helper artefacts).

### The signing flow

```
release.yml (on macos-15):
  1. Build MARVIN.app + bundle sidecar + zip → MARVIN-<v>-arm64.zip
  2. brew install minisign (already a cask dep — see below)
  3. Recover private key from GH Actions secret MINISIGN_SECRET_KEY
     + password from secret MINISIGN_PASSWORD
  4. minisign -S -s <secret-key-path> -m MARVIN-<v>-arm64.zip
     → produces MARVIN-<v>-arm64.zip.minisig
  5. Both files uploaded to the v<v> GitHub Release as assets
```

The private key lives only in GitHub Actions secrets. The public key lives in:

1. `RobertIlisei/MARVIN/README.md` (project root, top-level)
2. `RobertIlisei/homebrew-marvin/README.md` (tap root)
3. `RobertIlisei/homebrew-marvin/Casks/marvin-ai.rb` (embedded constant, single source of truth at install time)

A user who cares about authenticity reads the pubkey from #1 (over HTTPS to github.com, with the user's own browser TLS validation) and compares to what the cask embeds at #3. A tap-repo compromise can change #3 freely, but #1 lives in a different repo with separate access controls — discrepancy is the signal.

### Cask verification — phased

**Phase 1 (this PR):** Sign in CI, publish pubkey out-of-band. No automatic verification. Users who care follow a manual recipe documented in the README:

```bash
brew install minisign
gh release download v0.1.9 --repo RobertIlisei/MARVIN \
  --pattern 'MARVIN-*-arm64.zip' --pattern 'MARVIN-*-arm64.zip.minisig'
minisign -V -P "$MARVIN_PUBKEY" -m MARVIN-0.1.9-arm64.zip
```

**Phase 2 (separate PR):** Cask runs `minisign -V` automatically as a preflight step before extracting the app. Requires the cask to depend on `minisign` (a ~250 KB Homebrew bottle). User experience: `brew install --cask marvin-ai` transparently fails the install if the signature doesn't verify. Trust-on-first-use against tap compromise then becomes "user trusts the cask's embedded pubkey on first install"; a subsequent tap-compromise where the attacker rotates the pubkey gets caught by a `brew upgrade` against the now-wrong signature.

We ship Phase 1 first because Phase 2's cask-side preflight has a brew-engine compatibility question worth verifying separately, and Phase 1 is unambiguously useful even without it (anyone who cares can verify by hand).

### Key generation + secret-store onboarding

One-time setup by @robertilisei, performed locally:

```bash
brew install minisign
mkdir -p ~/.minisign
minisign -G -p ~/.minisign/marvin.pub -s ~/.minisign/marvin.key
# Prompts for a password — choose one with >40 bits of entropy.
# Save the password in a password manager.
```

Then upload via `gh secret set`:

```bash
gh secret set MINISIGN_SECRET_KEY --repo RobertIlisei/MARVIN \
  --body "$(cat ~/.minisign/marvin.key)"
gh secret set MINISIGN_PASSWORD --repo RobertIlisei/MARVIN \
  --body '<the-password>'
```

Public key (`~/.minisign/marvin.pub`) gets pasted into the three locations above by hand.

**Key rotation policy.** Plan to rotate every 2 years OR immediately if the secret-store is breached. Rotation procedure: generate new pair → update secrets → ship a release signed with the new key → publish new pubkey on README. Users see the pubkey changed; legitimate users update via the README; an attacker can't fake the README update (different repo).

## Consequences

**Positive**

- Closes audit 🔴 #4 — the only remaining 🔴 finding from the 2026-05-17 pass.
- Adds authenticity to the brew distribution at zero ongoing cost (no Apple Developer ID, no certificate renewal, no notarytool, no Sigstore TUF root).
- Pubkey-in-three-places makes tap-repo compromise visibly inconsistent with the project repo's record — even users who don't actively verify benefit from the social pressure.

**Negative**

- One-time setup burden (key generation, secret upload, README updates).
- Adds a release-pipeline dependency: `release.yml` now requires `minisign` to be installable on the runner (it's a standard Homebrew bottle, so this is trivial).
- Users who pin to a specific cask version benefit; users who never read the README don't auto-benefit until Phase 2 lands.
- Key rotation has a UX cliff: any user who pinned the pubkey out-of-band needs to re-pin after rotation. Mitigated by the 2-year cadence + clear release-note flag when rotating.

**Reversible**

- The pubkey is published in plain text — no irreversible commitment.
- The .minisig file is an additional release asset; it can be ignored.
- Cask formula references can be removed in one commit if the approach proves wrong.

## Alternatives considered

### Apple notarization (paid Developer ID)

*What it is:* $99/yr Apple Developer ID + `notarytool` integration in `release.yml`. Apple's notarization service signs the artefact in their cloud.

*Why deferred, not adopted:* ADR-0023 explicitly chose "brew install on a fresh Mac with no Apple Developer ID" as the canonical install path. Notarization is the better answer for a non-brew install (direct `.dmg` download), but the brew path already strips quarantine. Adopting notarization later doesn't preclude this minisign work — they layer cleanly.

### Sigstore / cosign with keyless signing

*What it is:* GitHub Actions OIDC → Sigstore Fulcio CA → ephemeral cert → Rekor transparency log. No long-lived keys.

*Why rejected:* Brings in TUF root trust, Fulcio CA trust, Rekor log trust — a much bigger transitive trust surface than "trust this 32-byte EdDSA public key." For a one-developer project, the dependency tree is wrong-sized. Reconsider if MARVIN ever joins a community with its own Sigstore policy.

### GPG via `gpg --detach-sign`

*What it is:* The traditional way. PGP key pair, GitHub keyring, `gpg --sign`, distribute via keyservers.

*Why rejected:* GPG's tooling is notoriously fragile (keyserver outages, key expiration UX, web-of-trust theatre). The actual cryptographic property (an asymmetric signature) is the same as minisign's, but the developer + user experience is meaningfully worse. Minisign is "GPG without the foot-guns" by explicit design.

### Self-host an entire signed-update server

*What it is:* Sparkle / appcast / EdDSA-signed update manifests served from MARVIN's own infra.

*Why rejected:* MARVIN doesn't have its own infra by design. Adding a hosted update channel is months of work and a permanent operational burden for a project whose distribution channel IS Homebrew.

## Verification

- `release.yml` produces both `MARVIN-${v}-arm64.zip` and `MARVIN-${v}-arm64.zip.minisig` as release assets.
- `MARVIN/README.md` and `homebrew-marvin/README.md` document the pubkey + the manual-verify recipe.
- `Casks/marvin-ai.rb` embeds the pubkey as a constant.
- A user running `minisign -V -P <pubkey> -m MARVIN-0.1.9-arm64.zip` against the published artefact validates "Signature and comment signature verified."
- (Phase 2, separate PR) Cask preflight runs `minisign -V` and fails the install on signature mismatch.

## Scope of Done (Phase 1)

- [ ] User generates a minisign key pair locally and stores private key in `~/.minisign/marvin.key`.
- [ ] User uploads `MINISIGN_SECRET_KEY` + `MINISIGN_PASSWORD` to GitHub Actions secrets.
- [ ] `release.yml` adds a signing step: install minisign → sign zip → upload .minisig as a release asset.
- [ ] MARVIN repo `README.md` carries the pubkey block + verify recipe.
- [ ] Tap repo `README.md` carries the same pubkey block.
- [ ] `Casks/marvin-ai.rb` embeds the pubkey as a constant (used in Phase 2; no behavioural change yet).
- [ ] A `v0.1.x` release after this lands has the `.minisig` asset and verifies against the published pubkey.

## Related

- [ADR-0023 — Brew-distributable `.app` via bundled Node sidecar](./0023-brew-distributable-bundled-sidecar.md) — the brew distribution path this hardens.
- [Audit finding 🔴 #4 in `docs/reviews/2026-05-17-full-security-audit.md`](../reviews/2026-05-17-full-security-audit.md) — the original flag.
- [minisign — Jedisct1](https://jedisct1.github.io/minisign/) — upstream documentation.
- WireGuard, curl, Tailscale all use minisign for the same reason — useful prior art.
