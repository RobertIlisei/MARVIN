# ADR-0071 — Install provenance, and the update path it enables

- **Status:** Accepted
- **Date:** 2026-08-24
- **Related:** [ADR-0039](./0039-fetch-skills-from-git.md) (fetch skills from Git),
  [ADR-0053](./0053-plugins-as-local-plugin-loader.md) (plugins as a local plugin loader),
  [ADR-0054](./0054-plugin-agents-read-only-hooks-stay-stripped.md) (plugin agents read-only)

## Context

MARVIN could install skills (ADR-0039) and full plugins (ADR-0053 Phase 3), but
had **no way to pull a newer version of either**. Asked directly — "does MARVIN
have a refresh for pulling latest versions of already-installed skills /
plugins?" — the answer was no, and the reason was not a missing button:

| Surface | What it actually did |
|---|---|
| `SkillsPane.refresh()` / `PluginsPane.refresh()` | Re-read the **local** index. A list refresh, not a version pull. |
| `addSkillFromGit` (`skill-installer.ts:261`) | Clone `--depth=1`, `rmSync(dest)`, copy — *"idempotent re-install"*. |
| `installPluginFromGit` (`plugin-installer.ts:164`) | Same, into `cache/<market>/<plugin>/<version>`. |
| `scripts/install-skills.sh` | Explicitly **skips** anything already present. Never updates. |

So re-installing from the same URL *was* effectively an update — but only if
the user remembered the URL and re-typed it, one item at a time.

**The blocker was missing provenance.** `registerInstalledPlugin` wrote
`scope / installPath / version / installedAt / lastUpdated` — no clone URL, no
ref. Skills recorded nothing at all; `installCandidates` just copied a folder.
Nothing on disk knew where anything came from, so an updater had no source to
re-clone. Two secondary gaps fell out of the same hole: superseded plugin cache
versions accumulated with no GC, and `lastUpdated` was written but never read.

## Decision

Record where every install came from, then act on it.

### 1. Two provenance stores, deliberately not one

- **Skills** → `.marvin-source.json` **inside** the installed skill folder. The
  folder is the unit of install *and* of deletion, so removing a skill removes
  its record — no registry to garbage-collect.
- **Plugins** → a sidecar registry at `~/.marvin/plugin-sources.json`, keyed by
  plugin key. Explicitly **not** a new field in
  `~/.claude/plugins/installed_plugins.json`: that file is co-owned by the
  Claude Code `/plugin` UI, and ADR-0053's premise is that installs stay
  visible in both directions. An unknown key risks the other writer dropping
  it — silent provenance loss. The cost is that a plugin updated *by Claude
  Code* leaves our record stale; the content hash catches that on next check.

### 2. Content hash, not version string

Skills have no version field, so "is upstream newer?" is answered by hashing
the tree (`hashTree`: sorted relative path + bytes, excluding `.git` and the
provenance file). Plugins *do* carry a manifest version, but plenty ship
changes without bumping it — so the comparison is the hash there too, and the
version is reported alongside purely for the UI.

### 3. Identity is name **and** path

`sourcePath` (repo-relative folder) is recorded next to `skillName`, because
name alone cannot tell apart the two things upstream does:

| upstream did | by name alone | by path |
|---|---|---|
| renamed the skill in place | recorded name absent, one other present | folder still there → **rename** |
| deleted the skill | recorded name absent, one other present | folder gone → **deletion** |

A test caught this the hard way: the first implementation fell back to "the
repo's only remaining skill", which on a deletion would have installed a
**different skill over the user's**, silently. Path matching runs first, name
matching second (for records predating `sourcePath`), and the sole-candidate
guess survives only when there is no recorded identity at all.

### 4. Backfill instead of a migration

Anything installed before this ADR has no record. Rather than a one-shot
migration (which has nothing to migrate *from*), both update endpoints accept
an optional `url` that binds provenance and updates in one step. The Skills
pane surfaces it as **Set source** on any row lacking one; the Plugins pane
shows `no source` with an explanatory tooltip, since a plugin installed through
the Claude Code UI is not ours to update.

### 5. Cache GC on update

The plugin cache is version-keyed, so an update lands in a new folder. The
previous path is now pruned — behind `isPrunableCachePath`, which refuses
anything that isn't exactly `<market>/<plugin>/<version>` inside our own cache.
It deletes recursively from a path another program writes, so the guard is
deliberately paranoid and unit-tested.

### 6. Surfaces

- `POST /api/skills/update` — `{ name, scope, workDir?, url?, checkOnly? }` or
  `{ all: true, scope, workDir?, checkOnly? }`.
- `POST /api/plugins/update` — `{ key, url?, checkOnly? }` or `{ all: true }`.
- Both CSRF-guarded. `url` + `all` is rejected: applying one URL to every item
  would silently rebind every record.
- A per-item failure is a `200` with `status: "error"`, not an HTTP error —
  bulk and single share one response shape, and one bad row shouldn't read as a
  failed request.
- `GET /api/skills` and `GET /api/plugins` now carry per-item `source`, so the
  panes can enable/disable Update without a second round-trip.
- Both panes gain **Check for updates** (checks, installs nothing — always safe
  to press) and a per-row **Update**.

## Scope of Done

- [x] Provenance written on every skill and plugin install; `installed_plugins.json` byte-compatible.
- [x] `updateSkill` / `updateAllSkills` / `updatePlugin` / `updateAllPlugins` with `checkOnly` + `url` rebind.
- [x] Two CSRF-guarded routes; `source` surfaced in both read models.
- [x] Check-for-updates + per-row Update in SkillsPane and PluginsPane; Set-source sheet for sourceless skills.
- [x] Superseded plugin cache versions pruned behind a guard.
- [x] 24 new tests; 772 total pass, 8/8 typecheck, macOS build clean.

## Consequences

**Skills with no recorded source stay un-updatable until told once.** That is
every skill on an existing machine. `updateAllSkills` **skips** them rather
than reporting errors — a wall of failures for a hand-authored tree would bury
the real results — so a bulk check on a fresh install reports "nothing to
check" until sources are bound. That is the honest state, not a bug.

**Update is a re-install, not a merge.** Local edits to an installed skill are
overwritten. This matches what install already did (`rmSync` then copy) and
what the user means by "pull the latest", but it means the installed tree is
not a working copy.

**A bulk check shallow-clones once per item.** Bounded and user-initiated, never
automatic — deliberately not wired into the per-turn watchdog, for the same
reason `graphify label` isn't.

**`hashTree` reads every file in a tree.** Fine for skill and plugin folders;
it would not be fine as a general-purpose utility on a repo, and shouldn't be
reached for as one.
