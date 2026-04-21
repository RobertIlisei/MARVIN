# ADR-0008 — User-initiated write channel for the file tree

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN's file tree is read-only today. All filesystem mutations go through the LLM — MARVIN's `Edit`, `Write`, and `Bash` tool calls routed via `canUseTool` + [`toolPolicy`](../../packages/tools/src/policy.ts) + the structural confirm gate ([ADR-0004](./0004-structural-confirm-gate.md)).

The user has asked MARVIN to behave like an IDE: create / rename / move / delete files from the tree UI, drag-and-drop, and edit files in place. Those are user-initiated mutations dispatched from the browser, not LLM tool calls. They don't travel through the Agent SDK. The confirm-registry ledger is keyed by `(turnId, toolUseId)` — neither exists here.

That leaves a choice. We can either:

1. Reuse the LLM confirm gate directly — wrap user ops in synthetic turns so they flow through `canUseTool`. Turn-scoped lifetimes against session-scoped UI actions produce a terrible UX (user-initiated op waits on a turn that isn't happening), and we lose the one property that justified the gate in the first place: it's *structural*, enforced by the SDK. A user-initiated op enforced by user-initiated code is tautological.
2. Skip all policy because "the user clicked it." Fat-finger delete on a non-empty directory is still a data-loss event. The affordance layer isn't the policy layer; conflating them is how every "user double-clicked, lost four hours of work" bug gets written.
3. Build a **sibling** surface that reuses the policy primitives (ignore lists, hard-deny segments, secret-file patterns) but runs its own classifier and its own confirm ledger with session-scoped lifetimes.

Option 3 is what we're doing.

An additional finding during the design pass: the existing `content/route.ts` read path used `fs.stat` on the requested path, which silently follows symlinks. A symlink `project/foo.txt -> /etc/passwd` would have rendered `/etc/passwd`. This was a pre-existing bug the new sandbox helper fixes for the read channel too.

## Decision

Add a second filesystem channel with four shared and three parallel primitives.

**Shared across both channels** (imported by the LLM side via `toolPolicy` and the user side via `fsWritePolicy`):

- [`packages/tools/src/fs-constants.ts`](../../packages/tools/src/fs-constants.ts) — single source of truth for `IGNORE_DIR_NAMES`, `HARD_DENY_DIR_SEGMENTS`, `SECRET_FILE_PATTERNS`. Future tightening touches one file; both channels get the fix.
- [`packages/runtime/src/fs-sandbox.ts`](../../packages/runtime/src/fs-sandbox.ts) — `checkFsPath({ cwd, target, mustExist, allowDirectory })` returning a canonicalised absolute path or a typed error. Symlinks rejected by default. Ancestor-symlink escapes blocked via `fs.realpath`. Path length ≤ 1024 bytes, NUL-byte rejected. Used by the read routes too — the content/tree/status refactors land in the same PR.

**Parallel per channel** (same shape, different input space):

- [`packages/tools/src/fs-write-policy.ts`](../../packages/tools/src/fs-write-policy.ts) — `fsWritePolicy(op, cwd)` → `{ class: "auto" | "confirm" | "deny", reason, severity? }`. Classifies the seven user ops: `create-file`, `create-dir`, `write-file`, `rename`, `move`, `delete-trash`, `delete-permanent`.
- `packages/runtime/src/fs-write-confirm-registry.ts` (lands in M2) — session-scoped token ledger; 60 s TTL, one-shot consume. Not shared with `confirm-registry.ts` because turn-scoped and session-scoped lifetimes don't compose.
- `/api/files/write/*` (lands in M2) — six POST routes; each calls `checkFsPath` → `fsWritePolicy` → execute-or-return-409-with-confirm-token.

**Policy rules of note:**

- `delete-trash` is `auto`. macOS Trash (and XDG Trash / Recycle Bin on other OSes via the `trash` npm package) is reversible; requiring a modal on every delete trains users to click through modals.
- `delete-permanent` is always `confirm` with `severity: danger`, regardless of count. Irreversibility is the thing that warrants interruption, not the count.
- Operations on the project root itself (`op.paths.includes(cwd)`) hard-deny at the policy layer. Belt and braces; the sandbox also rejects but the policy message is clearer.
- Writes to `.env*`, `*.pem`, `id_rsa`, `id_ed25519`, `*.p12`, `*.pfx` → `confirm` with `severity: danger`. We don't block — users legitimately edit `.env` — but we want a conscious click.
- Case-only rename (`Foo.ts` → `foo.ts`) on APFS / HFS+ case-preserving volumes silently no-ops. Policy returns `confirm warn` so the UI can surface the quirk.
- Writes capped at 5 MB per call. The editor save path shouldn't be shipping bigger payloads.
- Hidden files (`.editorconfig`, `.gitignore`, etc.) at the project root: allow. Elsewhere: allow. Not worth a separate class — deny-list catches the ones that matter.

**Threat items addressed by this ADR:**

- Symlink escape (both target and ancestor).
- Path traversal via `..`.
- Case-insensitive collision on macOS.
- Project-root delete.
- NUL-byte in paths, oversize paths.
- Secret-file writes flag for confirmation.

**Items deferred to ADR-0009** (M5):

- OS → browser `DataTransfer` trust boundary.
- `X-Marvin-Client` preflight-forcing header on the multipart upload route.
- Per-file and per-batch size caps.

**Items deferred out of scope entirely:**

- Anti-virus, MIME allowlist. We're a file browser, not a gatekeeper. The deny-list catches smuggling into `.git/` and friends; the rest is the user's files in the user's project.

## Consequences

**Positive:**

- IDE parity. Users can create / rename / move / delete files from the tree without asking MARVIN to do it for them, which was the explicit ask.
- Latent symlink bug fixed for the read path too — the sandbox helper replaces `fs.stat` in `content/route.ts`.
- Single source of truth for ignore/deny/secret lists across both channels. Future tightening doesn't drift.
- The user-initiated channel inherits every existing deny-list without code duplication.
- Case-collision surfaces instead of silently no-op'ing.

**Negative:**

- Two write surfaces now exist. Every future policy tightening must be evaluated for both; we'll need to keep REVIEW.md's "Always check" list aware of that.
- Doubled test matrix (manual today; becomes formal when the test harness lands).
- Session-scoped confirm registry introduces a second in-flight state object beyond the turn-scoped one. Timeouts + abort semantics have to be handled explicitly.
- `trash` npm dependency in `apps/web` (M2) — another first-run Automation permission dialog on fresh macOS installs. Documented in the install guide.

## Alternatives considered

### Reuse the LLM confirm gate directly

*What it is:* Wrap user ops in synthetic turns so they flow through `canUseTool` + `confirm-registry.ts`.

*Why plausible:* One gate to reason about. One audit surface.

*Why rejected:* The registry is keyed by `(turnId, toolUseId)` — user ops have neither. Retrofitting turn identity onto user ops either invents synthetic IDs (confusing the turn-scoped abort semantics) or changes the registry's shape to accommodate both lifetimes (breaking ADR-0004's invariants). Session-scoped and turn-scoped are structurally different; parallel siblings cost less than a generalised one.

### Skip the gate entirely for user-initiated ops

*What it is:* Trust the UI to be correct. Every click goes through to disk without policy inspection.

*Why plausible:* "User clicked it" is the canonical UX warrant for skipping confirmation. It keeps the code simple.

*Why rejected:* The policy layer isn't the UX layer. A fat-finger permanent-delete on a non-empty directory is data loss that the user's second click can't undo. The affordance layer (confirm modal) is upstream of the policy layer (classify the op); skipping the latter because the former exists is how every "I meant to click the other one" bug gets shipped. The policy also enforces invariants the UI shouldn't be responsible for (project-root delete, symlink escape, case-collision).

### One mega-policy module covering both channels

*What it is:* Merge `policy.ts` and `fs-write-policy.ts` into one classifier.

*Why plausible:* DRY. Tightening one list tightens both.

*Why rejected:* The two classifiers take different input shapes. `policy.ts` works on `{ name, input }` (LLM tool-call shape). `fs-write-policy.ts` works on `{ kind, path|paths, bytes }` (user op shape). Fitting both into one function requires a discriminated union that bloats both call sites. The shared-constants pattern (`fs-constants.ts`) gets the anti-drift property without the coupling.

### Ship without trash support — permanent-delete only

*What it is:* Skip the `trash` dependency; every delete is `fs.rm`.

*Why plausible:* One less dependency, one less first-run Automation dialog.

*Why rejected:* `trash` is what lets us default `delete-trash` to the `auto` policy class. Without Trash, every delete becomes `confirm` with `danger` severity. Users delete often; training them to click through danger modals is how they later miss a real danger modal. Reversibility is doing load-bearing work.

## Verification

- `rg "IGNORE = new Set" packages/ apps/` → 0 hits. The only source of `IGNORE_DIR_NAMES` is `packages/tools/src/fs-constants.ts`.
- Create a symlink `ln -s /etc/passwd <project>/leak.txt`, open in the file viewer → `400 symlink-rejected`. Delete: `rm <project>/leak.txt`.
- Open a file in the viewer (10 known paths, mixed file sizes and encodings) → no regression from the refactor.
- `pnpm -r typecheck` green across all 7 packages + web.
- Manual: try to write-through `cwd` itself via the sandbox → `is-directory`.
- Manual (deferred to M2): the full write-policy matrix (auto / confirm / deny / trash / permanent).

## Related

- [ADR-0004 — Structural confirm gate via Agent SDK](./0004-structural-confirm-gate.md) — the LLM channel.
- [Tool policy reference](../security/tool-policy.md) — the auto/confirm/deny matrix for LLM tools.
- [`packages/runtime/src/fs-sandbox.ts`](../../packages/runtime/src/fs-sandbox.ts) — shared path validation.
- [`packages/tools/src/fs-constants.ts`](../../packages/tools/src/fs-constants.ts) — shared ignore/deny lists.
- [`packages/tools/src/fs-write-policy.ts`](../../packages/tools/src/fs-write-policy.ts) — user-op classifier.
- ADR-0009 (M5) — OS → tree upload trust boundary. Deferred.
