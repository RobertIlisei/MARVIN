# ADR-0110 — A worktree isolates the filesystem, not the machine

- **Status:** Accepted — implemented 2026-09-10
- **Date:** 2026-09-10
- **Related:** [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (one worktree per tab), [ADR-0081](./0081-implementer-subagents-on-isolated-worktrees.md) (worktrees as the isolation primitive), [ADR-0102](./0102-multiple-sessions-one-worktree.md) (the collision a shared tree causes)

## Context

The user, running several tabs at once, asked whether a cross-session failure
was MARVIN's bug or theirs. The evidence a session produced about itself:

> The real cause is contention I can now evidence: `~/.testcontainers.properties`
> has `testcontainers.reuse.enable=true`, and two other worktree sessions have
> live surefire JVMs on this same Docker daemon right now. Reusable containers
> are keyed by config hash and shared across all sessions, so a sibling's
> lifecycle management removed the container mid-run.

Three tabs, three worktrees, three branches — and one Postgres container
between them. Two of the suites `DROP TABLE public.platform_alert` in schema
setup, so they were also silently corrupting each other's data whenever they
overlapped. The visible failure was a connection refused against a valid port
mapping with nothing listening behind it.

**Neither party was wrong.** ADR-0107's isolation is real and did its job: each
tab had its own checkout, its own branch, its own files. The shared resource
was outside all of that — a Docker daemon, reached through a setting in
`$HOME`, which no amount of git isolation touches.

The gap is that nothing said so. The guide described what a worktree gives a
tab and never described what it does not, and there was no mechanism to make a
tab's runs independent even for a user who knew they needed to.

## Decision

**1. Say what isolation does not cover.** The worktrees guide gains a section
naming the class — Docker, host ports, databases, global caches, `$HOME` — with
this incident as the worked example and a table of the usual offenders. Two
symptoms are given, because they are what a user actually notices: tests that
pass alone and fail when tabs overlap, and failures that move between tabs.

**2. Give a worktree its own environment.** `.marvin/worktree.json` gains an
`env` map, applied to every turn in a tab that has its own worktree — and
therefore to every subprocess those turns spawn:

```json
{ "env": { "TESTCONTAINERS_REUSE_ENABLE": "false" } }
```

Applied only in worktree mode: in the shared checkout there is nothing to be
independent from, and a variable silently in force there would be a surprise.

### Why the mechanism is a map and not a Testcontainers rule

The one-line fix for this incident is to set `TESTCONTAINERS_REUSE_ENABLE=false`
for session worktrees. It is also exactly what Golden Rule 6 forbids: MARVIN
must ship no assumptions about a specific project or a specific tool. The next
user's collision is a port, or a database name, or a cache directory, and a
Testcontainers rule helps none of them.

So the project declares what makes its runs independent and MARVIN applies it.
`env` is deliberately **never** auto-detected, unlike `symlinkDirectories`:
dependency directories can be recognised from git-ignore state, but "which
variables make your tests independent" is not derivable from a repository.

Values are validated at the boundary — POSIX names only, 64 entries, 4 KB per
value, malformed entries dropped rather than fatal — on the same reasoning as
every other `.marvin/` reader: a typo must never cost the user their worktree.

## Consequences

- A project can make its per-session runs independent with one config line.
- MARVIN still ships no tool-specific knowledge.
- The shared-resource class remains real for anything the user does not
  declare. This is documentation plus a lever, not enforcement — MARVIN cannot
  detect that two JVMs are about to share a container.
- The shared-checkout mode is unchanged.

## Scope of Done

- [x] `.marvin/worktree.json` accepts `env`; names validated, count and value
      length capped, malformed entries dropped, absent file still defaults.
- [x] `detectWorktreeSetup` never populates `env`.
- [x] Turns in a worktree-mode session run with it; shared-mode turns do not.
- [x] The worktrees guide names what isolation does not cover, with this
      incident and a table of usual offenders.
- [x] Tests cover the map, coercion, rejection, caps, defaults and detection.
