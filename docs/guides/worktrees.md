# Isolated tabs — what a session worktree is, and how MARVIN prepares it

Every new chat tab runs in its **own git worktree** by default ([ADR-0107](../decisions/0107-one-worktree-per-tab-and-a-multi-session-watch.md)).
This page explains what that means for your project, what a fresh worktree
is missing (dependencies, `.env`), and how MARVIN fills that gap — automatically,
or the way you tell it to.

## What a worktree is

A git repository can have more than one checkout at a time. `git worktree add`
puts a second working directory on disk that shares the same `.git` history
but sits on its own branch. Two people (or two MARVIN tabs) editing in two
worktrees never see each other's half-finished files, and one tab running
`git checkout` or `rebase` cannot pull the floor out from under another.

For a tab, MARVIN creates:

| What | Where |
|---|---|
| The checkout | `<project>/.marvin/worktrees/tab-<slug>/` |
| The branch | `marvin/tab/<slug>`, cut from your current `HEAD` |
| The record | `.marvin/worktrees.json`, `kind: "session"`, state `session` |

The worktree is created when you send the tab's **first message**, not when
you open the tab. The tab's chip reads `isolated: marvin/tab/<slug>` from then
on. The editor, terminal and file tree stay on your main checkout; only
MARVIN's turns run in the worktree. Closing the tab offers **Merge** (a local
`--no-ff` merge into your current branch, never a push), **Keep** the branch,
or **Discard** it.

## Closing a tab, and what survives

Nothing survives a tab unless it holds a commit ([ADR-0111](../decisions/0111-nothing-survives-a-tab-without-a-commit.md)).

| When you close | MARVIN does | Asks |
|---|---|---|
| a shared tab, or a draft | closes it | no |
| a tab with a turn running | offers to stop the turn first | yes |
| an isolated tab with no commits and no changes | removes its worktree and branch | no |
| an isolated tab whose branch is already merged | removes its worktree and branch | no |
| an isolated tab with changes but no commits | **Keep** (commits them as work in progress) · Discard | yes |
| an isolated tab with commits | **Keep for integration** · Merge into *your current branch* · Discard | yes |

Keep is the default. It leaves the branch for the integration step below. Merge folds the tab into the branch you have checked out, locally, and the button names that branch. Discard is the only destructive option and is only ever taken on a click.

Trees that are empty or already merged, and clean, are removed automatically: when MARVIN starts, and after every tab close. A tree with uncommitted work, unmerged commits, or a turn in flight is never touched by that sweep.

## Integrating what the tabs produced

The Sessions pane has a **Ready to integrate** section: every closed tab whose branch holds commits, with a verdict per row from a dry run against your current branch — `clean`, `clean · behind by 2`, or `conflicts in a.ts, b.ts`. The dry run checks nothing out and moves nothing.

- **Sync** appears on a row that is behind or would conflict. It asks the tab that owns the branch to merge your current branch into its own worktree, resolve every conflict, run the relevant tests, and commit. That session knows what its changes were for; you, in the main checkout, do not. After a sync the row reads clean.
- **Merge** folds one branch into your current branch, locally. Never pushes.
- **Merge all** folds every ready branch, oldest first, and stops at the first conflict, with everything before it already in.
- **Prepare MR…** squashes the branches you tick into one commit on a new `mr/…` branch, pushes it, and opens one merge request — one pipeline for the day's work instead of one per branch ([ADR-0109](../decisions/0109-batch-integration-and-metered-ci.md)). The sheet shows the same conflict chips, so a branch that needs a Sync is visible before anything is squashed.

Branches are named by their first commit, not by the first message: `marvin/tab/add-etransport-retry` rather than `marvin/tab/users-robertilisei-marvin-attachments-6b`. The rename happens once, on the first turn that leaves a commit; the worktree directory keeps its original name.

Sending a message to a closed tab whose branch was already integrated starts it on a fresh worktree cut from your current HEAD. A kept, unmerged tab reopens where it was.

## What a fresh worktree does not have

A worktree is a clean checkout of **tracked** files. Everything git ignores is
absent:

- **Installed dependencies** — `node_modules/`, `.venv/`, `vendor/`, `.pnpm-store/`, `.yarn/cache/`, `.gradle/`.
  Without them a test or build in the worktree fails until someone runs
  `npm install` again, which costs minutes and gigabytes per tab.
- **Local environment files** — `.env`, `.env.local`, `.envrc`, `*.local`.
  Without them the app in the worktree has no secrets or local ports.
- **Build output** — `target/`, `.next/`, `dist/`. These are *meant* to be
  rebuilt per worktree; sharing them would let two tabs overwrite each other's
  artefacts.

Anthropic's own worktree support has two knobs for exactly this
(`worktree.symlinkDirectories` and a `.worktreeinclude` file). They apply only
to worktrees the Claude Code CLI creates, so MARVIN honours the same intent for
the trees it creates itself.

## How MARVIN prepares a worktree

On the first message of an isolated tab, right after `git worktree add`,
MARVIN runs a setup pass:

1. **Symlink** each configured dependency directory that exists in the main
   checkout: `<worktree>/node_modules → <project>/node_modules`. The tab uses
   the same installed packages as you, with no copy and no reinstall.
2. **Copy** each git-ignored file that matches a configured pattern
   (`.env`, `*.local`, …). Only ignored files are ever copied — a tracked
   file is already in the checkout. Nothing is overwritten; at most 500 files
   / 50 MB.
3. **Honour `.worktreeinclude`** if the project has one (one gitignore-style
   pattern per line, the file Claude Code documents).

The result is recorded on the session (`setup` in the tab's meta file) and
told to the model at the start of every turn, so it does not try to
`npm install` into a directory that is a symlink to yours.

### Automatic detection (no config needed)

If the project has **no** `.marvin/worktree.json`, MARVIN works one out from
the project itself and **writes it** for you to review:

- every directory from the list above that exists **and is git-ignored**, at the
  root and inside workspace packages (`apps/web/node_modules`, `packages/*/node_modules`);
- the environment-file patterns, when at least one ignored file matches them.

The written file carries `"detected": true` so you can tell it was MARVIN's
guess. Edit it and the next tab uses your version; MARVIN never re-detects
over a file that exists. Build output is never symlinked, whatever git ignores.

### Configuring it yourself

`<project>/.marvin/worktree.json`:

```json
{
  "symlinkDirectories": ["node_modules", "apps/web/node_modules", ".venv"],
  "copyIgnored": [".env", ".env.*", "config/*.local"],
  "honorWorktreeInclude": true
}
```

- `symlinkDirectories` — repo-relative directories to symlink from the main
  checkout. Missing ones are skipped and reported, never created.
- `copyIgnored` — gitignore-style patterns; matching **ignored** files are
  copied. A leading `/` anchors to the root, a trailing `/` means a directory,
  `*` matches within a segment, `**` across segments.
- `honorWorktreeInclude` — also read `.worktreeinclude` (default `true`).

Set both lists to `[]` for a strictly clean worktree.

## A worktree isolates the filesystem, not the machine

This is the sharp edge, and it has bitten once already.

Each tab gets its own checkout and its own branch. It does **not** get its own
Docker daemon, host ports, databases, global caches, or anything keyed on
`$HOME`. Those are shared by every session on the machine, and by anything else
you happen to be running.

The real case, 2026-09-10. Three tabs were running Java integration tests at
once. `~/.testcontainers.properties` — a HOME-level file, nothing to do with
the project — had:

```properties
testcontainers.reuse.enable=true
```

Reusable containers are keyed by a config hash and shared across every JVM on
the same Docker daemon, so all three tabs were handed the **same** Postgres
container. Two of the suites `DROP TABLE` in their schema setup. They corrupted
each other's runs, and the failure surfaced as a connection refused when one
suite's lifecycle management tore the container down mid-run in another.

Nothing was wrong with the worktrees. The tests were sharing a resource that
lives outside them.

### Making per-session runs independent

Declare the variables that do it in `.marvin/worktree.json`. MARVIN applies
them to every turn in a tab that has its own worktree, and to every subprocess
those turns spawn:

```json
{
  "symlinkDirectories": ["node_modules"],
  "env": {
    "TESTCONTAINERS_REUSE_ENABLE": "false"
  }
}
```

MARVIN ships no knowledge of Testcontainers, or of any other tool — it cannot
know what makes *your* runs independent, and guessing would be project
knowledge it has no business holding. `env` is never auto-detected; the
`symlinkDirectories` above may be.

Things worth checking for your stack:

| Shared by every session | Typical fix |
|---|---|
| Reused test containers | a variable that disables reuse for the run |
| A fixed host port | bind port 0, or a per-session port |
| One dev database | a per-session schema or database name |
| A shared build/test cache | a per-session cache directory |
| A single dev server | run it in one tab, not all of them |

Two independent signs you have this problem: tests that pass alone and fail
when tabs overlap, and failures that move between tabs run to run.

## Caveats worth knowing

- **A symlinked `node_modules` is shared.** Installing a package from one tab
  installs it for every tab and for you. That is usually what you want; for a
  dependency experiment, remove the directory from `symlinkDirectories` first.
- **Tools that resolve symlinks** (some bundlers, `pnpm` with strict
  `node-linker`) may see the real path under the main checkout. If a build
  complains about files "outside the project", copy instead of symlink for that
  directory (`copyIgnored` on a directory pattern) or run that build on the
  main checkout after merging.
- **Nested `.git` and submodules** are not handled; the tab falls back to the
  shared checkout with a note in the chip.
- **Ignored data you did not list** (databases, caches, uploaded fixtures) is
  simply absent in the worktree. Add a pattern or a symlink for it.

## Where to look

- Chip popover on the tab: mode, branch, path, and this note.
- **Sessions** pane (left rail): every tab's state, what it is doing now
  (thinking / writing / using a tool), diff size, plan progress, cost.
- Source Control → Worktrees: every session worktree with its lifecycle state.
- Telemetry: `worktree.session.created` carries `detected`, `symlinked`,
  `copied`, `skipped` counts.
