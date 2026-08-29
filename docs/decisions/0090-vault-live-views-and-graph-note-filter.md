# ADR-0090 — Live views in the vault, and keeping 32k generated notes out of it

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0065](./0065-obsidian-vault-project-as-vault.md) (the vault), [ADR-0089](./0089-obsidian-trust-with-a-consent-exception.md) (trusting the server), [ADR-0085](./0085-graphify-beyond-search.md) (graphify beyond search)

## Context

Asked to take full advantage of graphify *and* Obsidian together without
breaking things, measured on the real project (`agri-saas-platform`):

- the vault is already set up — `.obsidian/` with sensible ignore filters and
  `dataview`, `hidden-folders-access`, `claude-code-ide` enabled;
- **656 MARVIN notes** — 104 memory facts, 552 backlog items — with 152
  wikilinks across the two index hubs;
- **0 code-graph notes**: `graphify export obsidian` had never run there.

Two concrete gaps followed.

**1. The index note advertised Dataview and shipped none.** It said "frontmatter
… shows as properties, so Obsidian's search and Dataview can filter on them"
and then offered nothing to filter with, on a vault where the plugin was
already installed. 552 backlog notes with `status` / `severity` / `kind`
frontmatter are exactly what Dataview is for.

**2. The graph export would drown the vault.** `graphify export obsidian` writes
**one note per graph node** — verified live: **7,604 notes** for MARVIN's own
repo, and this project's graph has **31,863 nodes**, so ~32k. Much of it is AST
noise rather than concepts (a sampled note was `compilerOptions` from a
`tsconfig.json`, linked to `types_4`). The ignore filters covered
`graphify-out/cache/` but **not** `graphify-out/obsidian/`, so anyone running
the export in-repo would bury the graph view and the search index under
generated notes — the opposite of what the vault is for.

## Decision

**1. Ship live Dataview blocks, but only when the plugin is enabled.** The
index note gains three queries — open backlog by severity, durable facts by
type, recently resolved. `vaultStatus` gains `dataviewPlugin`, detected the
same way the hidden-folder plugin already was. Without the plugin the note
prints how to get them instead: an unrendered ```dataview fence is worse than
an honest sentence.

**2. Filter `graphify-out/obsidian/` out of the vault by default.** The notes
stay on disk and remain openable by direct link; they simply stop flooding the
graph view and search. The export remains genuinely useful — for a *separate*
vault (`--dir ~/vaults/<project>`), which is how a 32k-node graph is browsable
at all.

### Considered and not taken

- **Running the export on the user's project.** ~32k notes written into their
  working tree is a large, opinionated change and theirs to choose.
- **Filtering AST noise from the export.** `.graphifyignore` filters files, not
  node kinds; dropping language primitives would have to happen in graphify's
  extractor. Noted, not attempted.
- **Reading the user's own notes as context.** ADR-0065 forbids it and the
  reasoning still holds.

## Consequences

- A vault with Dataview gets three live tables that never go stale, over notes
  MARVIN already maintains.
- Running the code-note export in-repo is now safe by default.
- `VaultStatus` grew a field; `renderIndexNote` branches on it, test-pinned
  both ways.

## Scope of Done

- [x] `dataviewPlugin` detected; three live queries when present, instructions when not
- [x] `graphify-out/obsidian/` in the default ignore filters
- [x] Both branches test-pinned; existing vault tests updated
- [ ] Not in scope: running the export on the user's project; AST-noise
      filtering; reading user notes
