# ADR-0009 — File uploads from the OS to the project tree

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN

## Context

[ADR-0008](./0008-user-initiated-write-channel.md) set up MARVIN's second write channel — the file tree UI writing through `/api/files/write/*`. M5 extends that channel with a new surface: OS files dragged from Finder (or any other application) onto the tree. That adds a trust boundary the other routes don't have — the other routes take JSON from MARVIN's own UI, where every path + op shape is already in the browser's memory. OS drops carry arbitrary bytes from an unknown source.

Three new security considerations at this boundary:

1. **CSRF — the preflight gap.** JSON POSTs with `Content-Type: application/json` are "non-simple" under CORS and trigger a preflight OPTIONS request that fails by default (we never set `Access-Control-Allow-Origin` for third-party origins), so cross-origin drive-by JSON requests can't reach the route. **Multipart POSTs are different.** `Content-Type: multipart/form-data` is on the CORS "simple request" list — no preflight. A malicious page the user visits could write a form, point it at `http://localhost:3030/api/files/write/upload`, and submit — the browser would send the body without asking. That attack writes arbitrary files into the user's project.

2. **Size and count amplification.** A bad actor (or a confused drop) could drag a 2 GB file or 10,000 small ones. The route has to refuse without ever buffering the whole payload.

3. **MIME / extension spoofing.** The browser reports a MIME for dragged files but the OS and the user can lie. We can't trust the MIME for security decisions; we can only treat it as a display hint.

## Decision

Ship the OS → tree upload as `POST /api/files/write/upload` with four defensive layers. One of them is non-negotiable; the others are engineering choices documented so they don't erode.

### 1. `X-Marvin-Client: 1` header required (non-negotiable)

The route returns `400 missing-x-marvin-client` when the header is absent. Fetching with a custom header is a non-simple request under CORS, so browsers send a preflight OPTIONS — which we never answer for cross-origin callers. The route becomes effectively same-origin-only without us touching a CORS config.

Our own uploader sends `X-Marvin-Client: 1` explicitly (in `apps/web/src/components/file-tree/use-os-drop.ts`). Adding it is one line; a drive-by attacker can't force the user's browser to add it via `<form>` submission.

This is the one thing the design explicitly cannot ship without. If a future refactor makes the header optional or renames it, the ADR is violated.

### 2. Caps

- 50 files per batch
- 10 MB per file
- 50 MB total batch size

Files past the count cap fail the whole batch (413). Files past per-file or batch-byte caps are *skipped* (not failed) so the user still gets the rest of their drop through. Skipped entries come back in the response with reasons.

No streaming — at 50 MB peak, `req.formData()` fits in memory for Next.js's Node runtime. If caps are later raised we'd need to swap to a streaming parser (`formidable`, `busboy`) and revisit this ADR.

### 3. Sandbox + policy, same as every other write

Each destination path goes through the same `checkFsPath` + `fsWritePolicy` pipeline as `/create`. `HARD_DENY_DIR_SEGMENTS` stops uploads smuggled into `.git/`, `node_modules/`, etc. Symlinks-from-Finder are flattened by the DataTransfer API itself (we never see the link, only its target's bytes) — good for our sandbox because there's no link target to re-check.

### 4. Secret-file uploads are skipped, not confirmed

The per-file write policy returns `confirm danger` for `.env*` / `*.pem` / key files. `/upload` treats that as "skip this one" rather than "prompt per file" — a modal-per-file in a drop of 50 files is UX hostile. Users who genuinely want to upload a secret file can drag it alone and the `confirm` modal then shows once; or they can use the context menu's New File → paste contents, which goes through `/create` and the normal confirm flow.

### Alternatives considered

#### `formidable` or `busboy` streaming parser

*What it is:* use a streaming multipart parser instead of `req.formData()`.

*Why plausible:* wire protocol backpressure if caps go up.

*Why rejected:* at the current caps (50 MB peak batch) plain `formData` is simpler and correct. Swapping in a streaming parser adds a dep + a fallible init path + new failure modes. Revisit only if caps grow.

#### Skip this milestone entirely

*What it is:* let users use the terminal (`mv` / `cp`) to move files into the project.

*Why plausible:* zero new attack surface.

*Why rejected:* user explicitly requested OS → tree drop for an IDE-like UX. The preflight guard solves the CSRF issue fully; caps solve the amplification issue; existing sandbox+policy handles the rest. Shipping the route is net-positive.

#### Extension allowlist (block `.sh`, `.exe`, `.dmg`, etc.)

*What it is:* refuse uploads of executable extensions.

*Why plausible:* superficially feels safer.

*Why rejected:* we're a file browser, not antivirus. Shell scripts and binaries are legitimate artefacts in many project trees. An extension allowlist either blocks legitimate use or becomes permissive enough to be meaningless. The `HARD_DENY_DIR_SEGMENTS` check catches the real threat (smuggling into `.git/`), and the file browser isn't where malware defence belongs.

#### MIME allowlist

*What it is:* accept only `text/*` / `application/json` / etc. from drops.

*Why plausible:* rejects obviously-wrong uploads.

*Why rejected:* MIME from DataTransfer is self-reported by the OS and user-mutable. Using it for security is taxonomy theatre. Use it only for display hints.

## Consequences

**Positive:**

- IDE-parity drag-in from Finder / desktop / downloads with reasonable caps.
- CSRF closed at the preflight layer — no CORS config surface to get wrong.
- Skipped-secret policy keeps the happy path fast without losing the audit intent.
- Sandbox + policy reuse means no new drift surface; everything in ADR-0008 still holds.

**Negative:**

- `X-Marvin-Client` header is a convention the next contributor has to remember on any new multipart route. REVIEW.md gains a rule documenting this.
- Secret-file uploads skip instead of prompting; users who want to upload one must drag it alone or use New File + paste. This is a UX trade, surfacing it here so a future "improve this" has the context.
- No streaming at current caps — if caps grow, revisit.

## Verification

- `curl -F file=@some.txt -F cwd=… -F destDir=… http://localhost:3030/api/files/write/upload` without `X-Marvin-Client` → `400 missing-x-marvin-client`.
- Same curl with the header → upload succeeds; response lists `uploaded[]`.
- Drag a 20 MB file → reported in `skipped[]` with "exceeds per-file cap" reason; no partial write on disk.
- Drag a `.env` → reported in `skipped[]` with "requires explicit confirm" reason.
- Drag a file whose target is inside `.git/` (via `destDir`) → `400` from sandbox or `skipped` with `policy-deny`.
- Construct a scratch HTML page on a non-`localhost:3030` origin that POSTs a multipart form → browser blocks the preflight; network tab shows the OPTIONS failing. Manual; not part of the automated smoke.

## Related

- [ADR-0008 — user-initiated write channel](./0008-user-initiated-write-channel.md)
- [Tool policy reference](../security/tool-policy.md)
- [`apps/web/src/app/api/files/write/upload/route.ts`](../../apps/web/src/app/api/files/write/upload/route.ts)
- [`apps/web/src/components/file-tree/use-os-drop.ts`](../../apps/web/src/components/file-tree/use-os-drop.ts)
- [OWASP: Unrestricted File Upload](https://owasp.org/www-community/vulnerabilities/Unrestricted_File_Upload)
