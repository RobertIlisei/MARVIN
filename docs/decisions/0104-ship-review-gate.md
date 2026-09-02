# ADR-0104 — The ship-review gate: `pr-review` / `security-audit` are enforced at `git commit`

- **Status:** Accepted — implemented 2026-09-02
- **Date:** 2026-09-02
- **Related:** [ADR-0060](./0060-graph-drift-nudge-rearm-graphify-first.md) (the design-hook pattern this joins), [ADR-0083](./0083-graph-drift-rail-rearms-and-escalates.md) (advisory → deny, and the once-per-stretch cap), [ADR-0084](./0084-blast-radius-and-pre-ship-impact-nudges.md) (the same `SHIP_COMMAND` moment, advisory), [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) (the breakdown script this also corrects), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (why the gate's state is keyed on the tree)

## Context

An audit of session `8927baf0` (agri-saas-platform, 2026-09-02, 25 turns,
~$108) checked what MARVIN did against what `personality.ts` says it MUST do.
The mechanical rules held: every subagent dispatch was a sanctioned type, the
only subagent writes were graph-extractor chunks under `graphify-out/`, the
force-push to `main` the user asked for twice was refused, and the ADR-0031
wakeup rails brought eight background pipeline polls back into the session.

The prompt-only rules did not. The session edited `.gitlab-ci.yml`,
`scripts/ci-fetch-secrets.sh`, `scripts/prod-backup-dump.sh`, installed a
sudoers grant on the production host and rewrote SMTP credentials in
`/opt/agricore/.env`. Personality §Skill triggers lines 1424–1445 say
`pr-review` MUST run when a diff "touches auth / credentials / tool-policy /
sandbox / shell-exec / persistence / migrations" and `security-audit` MUST run
when it "touches auth flows / credential handling" or "adds a new
shell-execution path". Across **eight pushes and three merge requests, neither
skill was invoked once.** The only `Skill` calls in the session were two
`graphify` refreshes.

This is the 2026-05-22 finding again, on the highest-stakes surface the
project has: prompt-only MUST lists fire ~0×. Every rule that has been made to
hold has been made to hold at the gate — graphify-first (ADR-0060/0083),
advisor-on-ADR-trigger, the advisor verdict (ADR-0095). The review skills were
the last load-bearing MUST with no mechanism.

### Two further findings from the same audit, fixed alongside

**The system prompt was built two ways.** `/api/chat` assembled personality +
project context + active-skills block; `startScheduledTurn` (wakeups)
assembled personality + project context. The prompt is the cache prefix. With
~650–870K tokens of context, every human↔wakeup transition re-created the
entire cache — 7 of the session's 12 full re-creations, at $2.50–3 each,
including a turn that emitted **100 output tokens for $2.67**. The remaining
misses are the Claude Code preset's per-process git-status snapshot ("This is
the git status at the start of the conversation"), which changes whenever the
tree changes and which MARVIN cannot pin from outside the binary.

**A drained queue turn left no `turn.started`.** `startQueuedTurn` appended
only `turn.user`, so anything that groups a transcript by turn attributed the
drained turn's whole run to the next `turn.user` — which arrived 300 ms later
as the client's own re-send. The audit read this as a vanished turn.

**The ADR-0067 breakdown script over-counted stalls ~3×.** It classified 20
waits (2.8 h) as "STOPPED with no question"; read one by one, most ended with
a message naming something only the user could do — push a tag, approve a
production step, review a design. Legitimate waits were being reported as the
failure the script exists to measure.

## Decision

### 1. A third design hook: the ship-review gate

`checkShipReview` in `design-hooks.ts` runs in `runDesignHooks` after the
advisor checks. On a `Bash` call that contains a `git commit` (plain,
compound, `cd X && …`, `git -C X …`, heredoc messages) it:

1. **Reads the diff the commit will seal** — the index, plus whatever the same
   command stages first (`git add -A` / `.` / `-u`, explicit `git add <paths>`,
   `commit -a`). Untracked files are counted by line. Four-second timeout;
   any git failure **fails open** — a hook that could block every commit on a
   git hiccup would be worse than the prompt rule it replaces.
2. **Classifies it by the personality's own lists.**
   - Docs-only (`*.md`, `*.txt`, `*.rst`, …) and lockfile-only diffs need
     nothing (the MUST-NOT list).
   - A security-boundary path — the ADR-trigger patterns (auth, credentials,
     migrations, schema, GitHub workflows, Dockerfiles, policy) plus the ops
     surface a *commit* touches that an *edit* rule never named: GitLab CI,
     Jenkinsfile, sudoers, `.env*`, `secrets/`, `*.sh`, token/password/
     sandbox/tool-policy names, compose files — requires **both**
     `security-audit` and `pr-review`. Tests and specs are exempt, on the same
     reasoning as the ADR-trigger rule.
   - Otherwise, more than 3 files or more than 50 changed lines requires
     `pr-review`. One small file is the "lint / format fix" the MUST-NOT list
     exempts.
3. **Checks whether the review has happened.** A `Skill` call with
   `pr-review` / `security-audit` (namespaced or not) is recorded per
   **working tree**, as is every commit that goes through. A review satisfies
   the gate if it ran **in this turn** (it covers every commit the turn
   makes) or, from an earlier turn, if **no commit has sealed the tree
   since**. Keyed on the tree, not the session, because "has this diff been
   reviewed" is a property of the tree — and ADR-0102 lets two sessions share
   one.
4. **Denies, naming the exact `Skill` call and the file that triggered it**,
   at most `SHIP_REVIEW_MAX_DENIES = 2` times per skill per turn. A third
   attempt is allowed and logged as `ship.review.bypass`: two refusals carry
   the instruction, and a third would only stall a turn whose skill call is
   failing for some other reason. `MARVIN_DESIGN_HOOKS=measure` logs instead
   of denying, like the other hooks.

Commits, not pushes: a push ships commits that were already gated. MR
creation is not gated either.

### 2. One system-prompt builder

`buildTurnSystemPrompt` in `turn-orchestrator.ts` is now the only assembler of
the SDK `append` prompt, used by the chat route, `startScheduledTurn` and
(through the route's params) drained queue turns. The three paths can no
longer diverge.

### 3. Drained turns record `turn.started`

`startQueuedTurn` emits and persists the same `turn.started` payload the route
and the wakeup path do, with `queued: true`.

### 4. The breakdown script has a "BLOCKED on a named human action" class

`scripts/session-time-breakdown.py` classifies a closing message that names a
user action (push, merge, approve, review, "your call", "waiting on you") as
legitimate. On session `8927baf0`: stalls **2.8 h / 20 → 0.3 h / 4**.

## Consequences

- A commit of CI, credential, sudo or shell changes cannot go through until
  both review skills have run, and a large diff cannot go through without
  `pr-review`. The deny message is the remedy.
- The gate adds up to three git subprocess calls before a commit, bounded at
  4 s each. Measured on the reporting project's tree: 70 ms for all three.
- The review is discharged by the skill *running*, not by its findings being
  acted on. That is the same limit the advisor gate had before ADR-0095; a
  verdict-reading PostToolUse hook is the obvious next step if measurement
  shows reviews being run and ignored.
- Both review skills must exist in the SDK session for the gate to be
  satisfiable. They are vendored under `.claude/skills/` and installed by
  `scripts/install-skills.sh`; the two-deny cap is the backstop if they are
  not.
- Cache re-creation from the preset's git-status snapshot remains. Pinning it
  would mean leaving the `claude_code` preset for a custom system prompt — a
  separate, non-neutral decision, not bundled here.
- Known cosmetic: `turn.started` from the wakeup and queued paths reports
  `runtimeMode` as `advisor` whenever an advisor model is configured, because
  the user's runtime-mode selection is not on the wakeup record. The model
  field is correct; only the label is.

## Scope of Done

- [x] A `git commit` whose diff touches a boundary path is denied until
      `security-audit` and `pr-review` have both run; a >3-file or >50-line
      diff is denied until `pr-review` has run; docs-only and lockfile-only
      commits pass — unit tests on the classifier and the parser, and an
      integration run of the collector against a real repository (staged,
      `add -A`, `commit -a`, explicit paths, `-C`, not-a-repo).
- [x] A review this turn covers every commit this turn; one from an earlier
      turn holds until the next commit — tested.
- [x] Denies cap at two per skill per turn, then allow with a logged bypass —
      tested.
- [x] The wakeup and chat paths build the same prompt from one function.
- [x] A drained queue turn records `turn.started`.
- [x] The breakdown script reports a named human action as legitimate.
- [x] `pnpm typecheck` clean; 1040 runtime + tools tests pass.
