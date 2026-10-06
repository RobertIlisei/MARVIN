# ADR-0122 — A tab gets its worktree or is refused: atomic creation, a disk floor, and an opt-in sparse checkout

- **Status:** Accepted — implemented 2026-10-06
- **Date:** 2026-10-06
- **Related:** [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (one worktree per tab; amended here — the "fall back to shared" clause is withdrawn), [ADR-0103](./0103-implementer-branch-lifecycle.md) (the same creation path serves implementers), [ADR-0110](./0110-worktrees-isolate-the-filesystem-not-the-machine.md) (the `worktree.json` read-boundary rule), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (what a shared tree costs), Golden Rules 1 and 6 in `AGENTS.md`

## Context

On 2026-10-06 at about 06:45 a real project's disk filled up. `git worktree add` failed for two new chat tabs. `POST /api/chat` caught the error, set `treeFallback`, and ran both tabs with `tree: { mode: "shared" }` — in the **user's main checkout**, which fifteen other tabs and the supervisor's merges were using at that moment. Nothing told the user; the session meta simply held no tree and no branch. The code said so in a comment: *"An unborn HEAD, a bare layout, a submodule: fall back to shared and say so in the record rather than failing the user's first message."* That sentence was written to be kind to the first message and it is the opposite of the isolation ADR-0107 exists to give: a tab that asked for its own branch got everyone's.

Two more facts surfaced the same day. Each worktree costs about 1 GB, roughly 530 MB of it a `docs/` reference corpus (PDFs, screenshots) a tab rarely reads — which is how a disk fills with fifteen tabs. And nothing checked free space before starting a checkout of that size.

## Decision

1. **No fallback, ever, from a worktree to the shared checkout.** The default is decided up front from facts about the repository (`body.tree ?? (repo has a commit ? "worktree" : "shared")` — a repository with no commit has nothing to branch from, and the tab is *recorded* as shared). Once a tab wants a worktree, any failure of creation or setup answers `409 { error: "worktree could not be created: <reason>", code: "worktree-failed", hint }` **before** a session meta, a transcript line or a turn exists, so nothing is written anywhere. The macOS app shows that sentence and the hint instead of an enum dump (`ServerRefusalText`). The same rule covers the closed-tab *recut* (the meta's `closedAt` is cleared only after the new tree exists, so a refused recut leaves the tab closed, and the old record untouched) and the header chip's switch-to-worktree (`PUT /api/sessions/meta`). `treeFallback` is removed.
2. **Creation is atomic.** One function, `addWorktreeAtomically`, wraps the disk preflight, `git worktree add`, the optional sparse checkout and the registry write; if any step throws it removes what was made — checkout, `prune`, then the branch (which cannot be deleted while a checkout holds it), each step tolerant — and rethrows. `createPreparedSessionWorktree` adds the setup pass and takes the tree back if setup throws. Setup stays best-effort per entry **except** `ENOSPC` / `EDQUOT`, which fail the tab: a "skipped: copy failed" line on a full disk is the first symptom of a tab that cannot work. Implementer worktrees (`createWorktree`) use the same function.
3. **A disk floor before any checkout.** Free bytes on the volume holding `.marvin/worktrees` (`statfs`, `bavail × bsize`) below the floor refuses with the numbers and the knobs. Default **10 GB**; `MARVIN_WORKTREE_MIN_FREE_GB` (the user's own environment) wins over `"minFreeGb"` in `.marvin/worktree.json`, which wins over the default — a repository must not be able to override its owner. `0` disables it.
4. **`sparseExclude` — lighter worktrees, opt-in per project.** `.marvin/worktree.json` gains `"sparseExclude": ["docs/reference-corpus"]`. The worktree is added with `--no-checkout`, then `git sparse-checkout set --no-cone -- '/*' '!/<dir>/'…`, then checked out. Non-cone because cone mode can only say what to *include*; the requirement is "everything except". Never auto-detected (Golden Rule 6). Files stay in git: commits keep the excluded paths (they are skip-worktree, not deleted), `mergeWorktree` runs in the main checkout, and a catch-up merge of a main that moved inside an excluded path leaves the tab clean — all asserted in tests. The model is told which directories are absent and where to read them (the main checkout), because without that a `ENOENT` reads as "the files are gone" and it recreates them somewhere git will not see them.
5. **`sparseExclude` and `minFreeGb` are project-controlled input** and are validated where they are read (REVIEW.md "Project-controlled config"). An entry is accepted only if it is boringly a directory path: `/`-separated segments of `[A-Za-z0-9._@+ -]`, no empty segment, no `.` / `..` / `.git`, no segment with leading or trailing space, no leading `/`, ≤ 200 chars, ≤ 64 entries. Nothing that is glob, negation, comment, escape or option syntax can pass, and each pattern is anchored with a leading `/` so none parses as an option to `git`. A rejected entry is dropped: that can only make a checkout *larger*, never wider. `minFreeGb` must be a finite number in `[0, 1024]`.

### Considered and not taken

- **Keep the fallback but make it loud.** A banner on a tab that is quietly editing the shared checkout is a warning *after* the damage, and the damage is to other tabs. Refusing costs one resend.
- **Cone-mode sparse checkout.** Reliable, but cannot express "everything except"; the project would have to list every directory it *wants*, which is project knowledge to maintain.
- **Auto-detect big directories to exclude.** A guess about what a tab needs; wrong in both directions. The user states it.
- **A 1 GB default floor** (the advisor's suggestion: a checkout needs ~300 MB). The owner specified 10 GB, configurable; the incident was a *project* whose tabs are ~1 GB each with fifteen open. Lower it per machine or per project.

## Consequences

- A full disk now surfaces as one clear refusal on the first message instead of fifteen tabs and a supervisor sharing a checkout nobody chose. The cost is that a new tab cannot start until space is freed — or the user opens a **shared-checkout** chat explicitly, which the hint says.
- `git sparse-checkout` in a linked worktree turns on `extensions.worktreeConfig` in the repository's shared config (git ≥ 2.36 does this correctly — a per-worktree `core.sparseCheckout`, so the main checkout and other worktrees are unaffected; asserted by a clean main-checkout status). It is persistent and outlives the worktree; very old libgit2-based tools may refuse a repository that carries the extension. A repository that does not set `sparseExclude` is never touched. Git older than 2.36 with `sparseExclude` set refuses the tab by name rather than ignoring the setting.
- APFS `bavail` can under-report purgeable space, so the floor is conservative on a nearly full Mac.
- Sessions that *already* fell back (a meta carrying `treeFallback` before this change) stay shared; the header chip shows it and switches them.
- Wakeups and recovery already refuse a missing worktree (`turn-orchestrator`, `session-recovery`); a wakeup record with **no** session meta still runs at its recorded cwd — the pre-0107 shape — and is unchanged here.

## Verification

- `worktree-atomic.test.ts` — a shimmed `git` failing `worktree add` ("No space left on device") leaves no record, branch or directory and the main checkout clean; a failure after the add (the sparse step) rolls everything back; the floor refuses with both numbers; env > project > default; the implementer path is atomic too; sparse checkout leaves the directory out with a clean status; a commit in a sparse tab keeps the excluded paths in its tree and merges back untouched; a catch-up merge with main moving inside the excluded path stays clean; git < 2.36 is refused by name; the read boundary for `sparseExclude` (good and ~25 hostile entries) and `minFreeGb`.
- `ServerRefusalText` — 970 Swift assertions.
- Not exercised by an automated test: the chat route's 409 itself — the route imports the SDK runner, which needs packages (`zod`, `diff`) absent from the development environment where this was written. It is thirty lines that return before any write; reviewed by hand.

## Scope of Done

- [x] A tab that asks for a worktree and cannot get one is refused (409 `worktree-failed`) before any meta / transcript write; no shared fallback; `treeFallback` gone
- [x] Disk floor, default 10 GB, env / project configurable, with tests
- [x] `sparseExclude` validated at the read boundary and applied as a non-cone sparse checkout; commits and merges proven to work
- [x] AGENTS.md, the worktrees guide, CHANGELOG and roadmap updated
