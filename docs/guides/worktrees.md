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
