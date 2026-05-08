# Per-project isolation contract

Starting a new project with MARVIN means starting from zero. No shared session history across projects, no inherited memory, no assumed services.

This is a contract, not just a default.

## The rule

- **The user picks a `workDir`** at session start (via the project picker). Everything outside that `workDir` is opaque to MARVIN.
- **Per-project state lives inside the project's own `workDir`** — knowledge graph, ADRs, memory log. It travels with the code, survives `git clone`, is visible in code review.
- **MARVIN's user-scoped data dir** (default `~/.marvin/`) holds only cross-project plumbing — session transcripts, cost ledger, registered-projects list, user config. Never project content.

## Why

Two failure modes this prevents:

### 1. Cross-project contamination
An assumption made while working on Project A ("we use RLS for tenant isolation") bleeding into Project B, where the decision was opposite. Solo-plus-AI projects typically collapse around month 3 when this kind of leakage accumulates.

### 2. Hardcoded project knowledge
Any specific user project's service names, realm ids, workflow conventions, ports, or stack choices getting baked into MARVIN's source. MARVIN is supposed to work the same way for a rocket-guidance solver as for a Next.js app.

See the [Golden rules in CLAUDE.md](../../CLAUDE.md) — rule 6 is specifically "no hardcoded project knowledge."

## What lives where

### Inside the user's project `<workDir>/`

- `docs/adr/NNNN-*.md` — Architecture Decision Records. Written in Phase 4 of the workflow, read at Phase 2 of every future session.
- `.marvin/memory.md` — running decision log. One-line entries appended at Ship (Phase 8), read at Discovery (Phase 2). Gotchas, invariants, "we decided Y because Z was broken."
- `graphify-out/graph.json` — knowledge graph, rebuilt by the [graphify skill](./graphify-integration.md) when the code or docs change. Gitignored cache (`graphify-out/cache/`) is not checked in.

These are the three ramification layers. See [ADRs + memory](./memory-and-adrs.md) for how they compose.

### Inside MARVIN's user data dir `~/.marvin/`

- `projects.json` — registered projects (id, name, workDir, createdAt, lastUsedAt).
- `active-project.json` — currently-selected project id.
- `config.json` — user preferences (personality, theme, executor/advisor picks).
- `cost-tracker.json` — append-on-turn spend ledger, summarized per project.
- `sessions/<projectId>/<sessionId>.jsonl` — conversation transcripts.

Nothing in `~/.marvin/` references a specific user project's internals. `projects.json` knows the `workDir` path, but the content inside that `workDir` is never duplicated into MARVIN's own data.

Configurable via `MARVIN_DATA_DIR`. See [Environment variables](../reference/env-vars.md).

## What gets injected into the first message

On Message #1 of each session, [`buildProjectContext()`](../../sidecar/packages/project-context/src/index.ts) builds a project context block and appends it to the system prompt. The block contains:

- **Project docs** — whole file contents of `README.md`, `CLAUDE.md`, `PROJECT_STATUS.md`, `BUSINESS_OVERVIEW.md`, any `.md` at the repo root. No truncation. (An earlier implementation had a 6 KB cap; it was removed after real projects routinely exceeded it.)
- **ADRs** — every file under `<workDir>/docs/adr/` verbatim.
- **Memory** — `<workDir>/.marvin/memory.md` if it exists.
- **Graph header** — god nodes + top communities from `<workDir>/graphify-out/graph.json` if present. Compact; doesn't duplicate the full graph.
- **Workflow health** — a short audit block that flags missing ADRs, missing memory, or stale graph. Fires on EVERY turn until the gaps close, not just the first — this is how MARVIN nudges you to write the missing ADR.
- **Infra probes** — **off by default**. Each project opts in by configuring probes in its own repo.

The block is a *context*, not a contract. MARVIN treats it as "here's what this project currently looks like," not "here's what the project must always be."

## Switching projects

Picking a different project in the header:

1. Sets `active-project.json` to the new id.
2. Loads that project's registered sessions list for the picker.
3. The next chat turn builds a fresh context block from the new `workDir`.
4. **No memory bleed.** MARVIN's in-process state for the previous project is discarded. The new turn starts at Phase 1 (Intake), with the new project's graph, ADRs, and memory.

## Fresh project = from zero

A `workDir` MARVIN has never seen before has:

- No `graphify-out/` → MARVIN recommends running `/graphify .` early.
- No `docs/adr/` → Mode A of the workflow audit proposes the first ADRs based on what Intake reveals.
- No `.marvin/memory.md` → Mode B of the workflow audit creates it with seed entries from the first real decision.

MARVIN never pre-populates these from some template. They grow from real work.

## Related

- [ADR-0005 — per-project isolation](../decisions/0005-per-project-isolation.md) — the decision record.
- [ADRs + memory](./memory-and-adrs.md) — how the three layers compose.
- [Storage layout](../reference/storage.md) — the exact file structure.
- [Golden rules in CLAUDE.md](../../CLAUDE.md) — rule 4 (separate workspace) and rule 6 (no hardcoded project knowledge).
