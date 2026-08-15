# ADR-0065 — Obsidian: the project directory IS the vault

**Status:** Accepted — 2026-08-15
**Touches:** new `obsidian-vault.ts` (status, init, index note) and
`obsidian-mcp.ts` (`obsidian_status` / `obsidian_init`), registered in
`sdk-runner`; `backlog.ts` + `memory-mcp.ts` index writers emit `[[wikilinks]]`;
`personality.ts` firm surface. Builds on [ADR-0042](./0042-memory-as-durable-facts.md)
(memory), [ADR-0044](./0044-project-backlog.md) (backlog) and
[ADR-0028](./0028-two-graphs-code-and-knowledge.md) (graphs).

## Context

The user asked to use Obsidian with MARVIN and graphify, "project linked — the
same as graphify and marvin are".

Measuring first changed the shape of the answer. One real project
(`agri-saas-platform`) already contained **819 markdown files MARVIN had
written**:

| | |
|---|---|
| `.marvin/memory/` | 79 durable facts |
| `.marvin/backlog/` | 437 items |
| `.marvin/plans/` | 303 plans |

Every one carries YAML frontmatter, which Obsidian reads natively as
properties. An Obsidian vault is *a folder containing `.obsidian/`* — nothing
more. So the content and the container were both already there.

Three things were missing:

1. **`.obsidian/`** — trivial, but nobody had written one.
2. **Links.** Checked all 79 memory files: **zero `[[wikilinks]]`.** The notes
   referenced each other in prose, so Obsidian's graph view would have rendered
   819 disconnected dots — technically a vault, practically useless. This was
   the actual gap.
3. **The code graph as notes** — which `graphify export obsidian` already
   emits, one note per symbol.

Also relevant: this machine already registers a *project directory* as an
Obsidian vault (`Projects/clinica_regala`). The pattern being asked for was
already in use manually.

## Decision

**The project directory is the vault.** No side vault, no copying.

Golden Rule 4 says the project's knowledge lives in the project's directory. A
separate vault would need copies or symlinks, and every `[[link]]` would have to
be rewritten to survive the move — a synchronisation step that exists only to
drift. Pointing Obsidian at the project means the notes MARVIN already writes
*are* the vault.

### Links are the feature

`backlog.md` and `memory.md` now emit `[[backlog/<id>]]` and
`[[memory/<slug>|<name>]]` instead of bare paths. Markdown links
(`[name](path.md)`) render fine in Obsidian but **create no graph edges** — the
index would have looked connected while the graph stayed empty. That distinction
is the whole reason this ADR isn't just "write a config file".

Two hubs, 516 notes hanging off them. That is a graph worth opening.

### Opt-in, and never destructive

- `.obsidian/` is created **only** by an explicit `obsidian_init`. Writing
  config into someone's repository as a side effect of a turn is not ours to do,
  and `personality.ts` says so as a MUST NOT.
- An **existing** `.obsidian/` is never overwritten. The expected case is a
  user who already configured the vault: ignore filters are *merged*, every
  other setting is left alone, and a corrupt `app.json` is left exactly as
  found — a vault missing our filters still works; a vault with the user's
  config destroyed does not.
- MARVIN owns `.marvin/`, `MARVIN.md` and `graphify-out/`. It edits nothing
  else in the vault and deletes nothing: a backlog item is resolved by changing
  its `status`, never by removing the file.
- Default ignore filters (`node_modules/`, `.git/`, `.next/`, build dirs) exist
  because without them the vault is mostly dependencies and the graph view is
  unusable. The point is notes, not every file in the repo.

## What this is not

**MARVIN does not read the user's own notes as context, and cannot write into
them.** That was the explicit fork, and it is deliberately unbuilt:

- reading a personal knowledge base into every turn hits the context budget
  ADR-0041 exists to protect;
- writing into it needs the same surface-don't-mutate discipline the backlog
  groomer has (ADR-0063), plus a consent model that doesn't exist yet.

`personality.ts` forbids simulating it by grepping the vault.

## Consequences

- Anyone who already opens their project in Obsidian gets the notes immediately
  — no migration, no import.
- The wikilink change alters two files MARVIN writes on every update. Both are
  MARVIN-owned; the context injection that quotes `backlog.md` reads the same.
- `graphify export obsidian` is best-effort: graphify may be absent or the graph
  unbuilt. A missing export degrades the vault (no code notes) but never fails
  the init, because the note families are the point.
- The index note is regenerated on every init, so it says "safe to edit, but put
  lasting notes elsewhere" rather than silently eating someone's additions.

## Scope of Done

- [x] `vaultStatus` / `initVault` / `renderIndexNote`, pure enough to test with
      no Obsidian installed.
- [x] `obsidian_status` + `obsidian_init` MCP tools, registered in `sdk-runner`.
- [x] `backlog.md` and `memory.md` emit wikilinks; the backlog index test now
      pins the link form.
- [x] Existing `.obsidian/` merged not clobbered; corrupt `app.json` left
      untouched; idempotent on repeat runs; user notes untouched.
- [x] `personality.ts`: MUST run on request / MUST NOT create unasked / MUST NOT
      edit user notes / reading the vault is not a capability.
- [x] 12 unit tests, 655 suite-wide; `tsc` clean.
- [x] Phase 2 (two-way) recorded as unbuilt with the reasons.
