# ADR-0039 — Fetch skills from Git repos and marketplaces

**Status:** Accepted — 2026-06-11
**Touches:** new `skill-installer.ts` (runtime), `POST /api/skills/add`
(+ `/api/skills/marketplace` in phase B), Skills pane "Add from GitHub"
sheet. Builds on the skills index (ADR-0025) and enablement (ADR-0037).

## Context

A review of how the Claude ecosystem distributes skills found three
channels: the official `anthropics/skills` GitHub repo (document/design/meta
skills only — **no** infra/devops skills), **plugin marketplaces**
(`/plugin marketplace add <repo>` → `/plugin install <name>`; a marketplace
is a Git repo with a `.claude-plugin/marketplace.json`), and **drop-in**
folders (`~/.claude/skills/` or project `.claude/skills/`). Skills are
*acquired* (fetched from a repo), not generated — authoring is for
org-specific workflow that doesn't exist generically.

MARVIN only had two paths: **install** from its pinned bundle (~20 skills;
it even shallow-clones `anthropics/skills` once at install time) and
**author** (the generative "Discover" → build a project-local skill). It
had **no way to fetch an arbitrary existing skill from GitHub or a
marketplace**. So for, e.g., an Ansible + Azure Pipelines project (no
official skill exists), MARVIN could only *propose authoring* a project-local
runbook — never *fetch* a community skill. That's the gap.

## Decision

Add external skill acquisition, mirroring the Claude Code model, in two
phases.

### Phase A — Add a skill from a Git repo URL

`POST /api/skills/add` (CSRF-guarded). Given a Git URL and a scope:

- Shallow-clones the repo to a temp dir (no execution — clone + copy only).
  Accepts a plain repo URL or a GitHub `tree`/`blob` sub-path URL
  (`…/tree/<branch>/<path>`), in which case only that sub-path is the skill.
- **Discovers** every directory containing a valid `SKILL.md` (depth-limited),
  reading its frontmatter `name` / `description`.
- If `only` names aren't given and >1 skill is found, returns the candidate
  list for the user to pick (installs nothing). Exactly one → installs it.
- **Installs** each chosen skill folder into the target:
  `~/.claude/skills/<name>/` (`user-global`) or `<workDir>/.marvin/skills/<name>/`
  (`project-local`). Installed skills then flow through the enablement layer
  (ADR-0037) like any other.

Native: an **"Add from GitHub"** sheet in the Skills pane — URL + scope +
(when multi) a pick-list — that installs and refreshes the pane.

### Phase B — Marketplaces

`POST /api/skills/marketplace` to add a marketplace repo (read its
`.claude-plugin/marketplace.json`), list its plugins/skills, and install a
named one — the `/plugin marketplace add` + `/plugin install` flow, in-pane.
Covers the official + community marketplaces. Reuses the phase-A clone +
SKILL.md-discovery core; adds manifest parsing + the plugin directory shape.

## Security

Cloning a third-party repo and copying a `SKILL.md` (which can carry
`allowed-tools` + scripts) is supply-chain-sensitive. Mitigations: clone +
copy only (never run anything from the repo), validate it IS a SKILL.md
folder (not arbitrary files), user-initiated only (a pane action, not an
autonomous MARVIN install — MARVIN may *recommend* a URL in chat, the user
clicks Add), and a clear "third-party — review the source" note in the sheet.
This is a sanctioned user action, like `brew install` — not a refusal case.

## Rejected alternatives

- **An MCP tool letting MARVIN auto-install repos.** Too much
  supply-chain surface for an autonomous loop. Keep installs user-initiated;
  MARVIN recommends, the user confirms.
- **Generate-only (status quo).** Authoring can't surface a maintained,
  versioned community skill — the thing the user actually wanted.

## Scope of Done

- [x] (A) `POST /api/skills/add` clones a repo / sub-path, discovers + validates
      SKILL.md folders, installs selected to user-global or project-local;
      multi-skill repos return a pick-list; idempotent. 8 unit tests.
- [x] (A) Skills-pane "Add from GitHub" sheet (URL + scope + pick-list).
- [x] (A) Installed skills appear in the pane + flow through ADR-0037 enablement.
- [x] (B) Marketplace support, unified into the same `POST /api/skills/add`
      flow: a marketplace URL returns its plugin list; `plugin: <name>`
      resolves the plugin's `source` (relative / github / url / git-subdir)
      and installs its skills. (Separate `/marketplace` route folded into
      `/add` — one "paste any URL" UX.)
- [x] ADR + unit tests (parse, discover, single/multi/marketplace install);
      tsc + swift build clean.
