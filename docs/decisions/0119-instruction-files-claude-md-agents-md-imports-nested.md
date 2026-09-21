# ADR-0119 — A project's instruction files, read the way the agent ecosystem writes them

- **Status:** Accepted — implemented 2026-09-21
- **Date:** 2026-09-21
- **Related:** [ADR-0118](./0118-one-prompt-per-session-and-settings-isolation.md) (settings isolation, which removed nested loading), [ADR-0041](./0041-project-graph-lifecycle-and-context-budget.md) (project context), Golden Rules 4–6 (separate workspace, no truncation of documents, no hardcoded project knowledge)

## Context

MARVIN is project-agnostic: a user brings a project set up for Claude Code (`CLAUDE.md`), for Codex / Cursor / other agents (`AGENTS.md`), or both — often with `@path` imports and per-directory files. MARVIN handled one case: `buildProjectContext` injected the root `CLAUDE.md` verbatim. So:

- an `AGENTS.md`-only project gave MARVIN **no instructions at all**;
- a `CLAUDE.md` that says `@AGENTS.md` — Anthropic's documented way to share one file across tools — reached the model as that literal line;
- since ADR-0118 isolated MARVIN from the SDK's project settings source, **nested instruction files reached nobody**. A real project had just moved its backend constraints into `apps/api/CLAUDE.md`; MARVIN would not have seen them.

Real projects also keep drifting duplicates. Two repos measured: `AGENTS.md` was an 85–88 % line copy of `CLAUDE.md`, hand-maintained, and the user runs Codex in both (133 sessions in two weeks) — so each agent followed a different copy.

## Decision

1. **Which file, per directory** (`resolveInstructionFiles`, `project-context/src/instruction-files.ts`). `CLAUDE.md` and `.claude/CLAUDE.md` load; `AGENTS.md` / `.claude/AGENTS.md` load when there is no `CLAUDE.md`. When both exist and `CLAUDE.md` does not import `AGENTS.md`, MARVIN goes one step past Claude Code's default: an `AGENTS.md` with distinct content loads too, while a near-copy — half or more of its lines already in `CLAUDE.md` — is skipped and reported. Calibrated on real files: copies 85–88 %, a genuinely different file 9 %. Never `CLAUDE.local.md` (existing decision), `AGENTS.local.md`, `AGENTS.override.md` or `.agents/`.
2. **Imports** expand as Claude Code documents: relative to the importing file, outside fenced blocks and inline code, at most four hops, each file once. A project file is attacker-controlled input, so an import whose real path leaves the project — by `..`, absolute path or symlink — is refused and left in place with a marker. An unresolvable token stays as written; it may be a mention. No size cap: Golden Rule 5 keeps documents whole, and an import cannot reach outside the project.
3. **Root** instructions go into the project context (the `"CLAUDE.md"` entry of `DEFAULT_FILES` now means the resolved set), headed with what loaded (`CLAUDE.md (imports AGENTS.md)`).
4. **Nested** instructions surface lazily (`nested-instructions.ts`, a `PostToolUse` hook): after a Read / Edit / Write / NotebookEdit, each directory between the working directory and the file that has instruction files is added as context once per session, outer first, reset when a compaction drops it. Directories under `IGNORE_DIR_NAMES` (dependencies, build output, VCS) and `.marvin/` never count — their instruction files belong to someone else.
5. **Duplicates are reported, never fixed silently.** A near-copy adds one line to the context pointing at the `marvin:instruction-files` skill, which explains the one-file pattern (canonical tool-neutral `AGENTS.md`; `CLAUDE.md` = `@AGENTS.md` + Claude-only lines; same per subdirectory) and consolidates only with the user's approval. MARVIN edits no project's instruction files on its own.

## Consequences

- AGENTS.md-only projects, import-based projects and nested files now reach MARVIN's model. Verified live on a real project: a turn that read one file under `apps/api/` quoted a rule that exists only in `apps/api/CLAUDE.md`, without opening it.
- A near-copy costs nothing extra — skipped — and becomes visible to the user as a drift problem rather than silently doubling tokens.
- Loading a distinct `AGENTS.md` alongside `CLAUDE.md` differs from Claude Code's default (which ignores it). MARVIN reads what the project wrote; the containment rule keeps duplicates out.
- Nested context arrives as a tool-result addition, so it is not part of the recorded system prompt (ADR-0118) and does not break the prompt cache.

## Scope of Done

- [x] `resolveInstructionFiles` with the rules above; 11 tests (file choice, imports, fences, `..` and symlink escape, cycle, depth, 88 % / 9 % containment)
- [x] `buildProjectContext` uses it for the root; AGENTS.md-only, import and duplicate cases tested
- [x] Nested `PostToolUse` hook, compaction reset, ignored directories; 6 tests; live on a real nested file
- [x] `marvin:instruction-files` skill, pointed at from the prompt and the duplicate notice
- [x] No project's files edited
