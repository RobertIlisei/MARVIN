# The 8-phase senior-engineer workflow

MARVIN runs an 8-phase dialog on every new feature or change request. The phases aren't roles played by different agents (see [Single assistant](./single-assistant.md)) — they're stages one assistant moves through in one conversation.

The workflow is encoded in [`sidecar/packages/runtime/src/personality.ts`](../../sidecar/packages/runtime/src/personality.ts) under `CORE_BEHAVIOR` and injected into MARVIN's system prompt on every turn. You can read the authoritative version there; this document explains why each phase exists and what to expect as the user.

## Why 8 phases instead of "just coding"

The failure mode this mitigates is the **solo-plus-AI cross-session ramification problem**: feature 10 at week 8 breaks an assumption made in feature 3 at week 2. Neither the human nor the AI can hold the whole project in head. The 8 phases make ramification checking mechanical and surfaced at the right moments.

## The phases

### 1. Intake

Restate the ask in MARVIN's own words. Ask ≤ 3 clarifying questions, only on things that are genuinely ambiguous — identity/authz, data ownership, perf SLO, back-compat. Everything else gets "I'll assume X, say if that's wrong."

**What you do:** Answer in one-word shorthand or "you decide." MARVIN will state the decision + why and proceed.

### 2. Discovery

Query graphify FIRST, then read files the graph points to, then probe running infra if the work depends on a service. Read existing ADRs (`<workDir>/docs/adr/*.md`) and the project memory file (`<workDir>/.marvin/memory.md`). Past decisions bind.

**Summary format:** "what exists / what is missing / what is broken".

**What you do:** Watch for graph hits you didn't know about. The graph often surfaces surprising cross-cutting dependencies.

### 3. Impact analysis (blast radius)

Enumerate every module, function, endpoint, schema, config, type, event the change touches. For each: **direct consumers (1-hop) + transitive consumers (2-hop) + contract surfaces (API, DB, shared types, events, flags, migrations)**.

Classify each entry as:

- `no-change` — touched incidentally, nothing to do.
- `mechanical-update` — rename / re-wire / update type.
- `semantic-review` — behavior changes, needs thinking.
- `breaking` — public contract changes, needs migration plan.

When the graph doesn't know about something (runtime config, infra, third-party consumers), it's marked `unknown, assume affected`.

**What you do:** Review the checklist before architecture proceeds. This is where you catch "oh, we also need to update the CDK stack."

### 4. Architecture

Propose concrete infra + software changes *together* (not one then the other). Trade-offs as ADR-sized notes with 2-3 options + recommendation. Material decisions are written as ADR files to `<workDir>/docs/adr/NNNN-*.md`.

**ADR template** enforced by `personality.ts`: Context · Decision · Consequences · Alternatives considered (with why rejected).

**What you do:** If you have an opinion on the trade-off, now is the cheap moment to redirect. Conflicts with a prior ADR are surfaced explicitly — you either refine the plan or write a superseding ADR.

### 5. Plan

≤ 6 shippable milestones, each with a stated verification gate. Each milestone carries the blast-radius entries it touches.

**What you do:** Sanity-check the scope. If a milestone looks too big ("add auth + billing + migrations in one"), this is where you say "split it."

### 6. Implement

Milestone by milestone:

1. **Diff preview** → `confirm` → **apply** (under the [Confirm gate](./confirm-gate.md)).
2. **Verify** — run typecheck, run tests, run probes if infra-adjacent.
3. **Milestone exit checklist** — blast-radius entries addressed, workspace typecheck clean, tests pass or added, no stray TODOs.
4. **Landed note** — one line citing the commit.

Surface surprises as they come up. Never paper over a red result.

**What you do:** Review diffs before allowing. The Monaco diff viewer shows the exact change. If you catch a problem, deny with a note explaining — MARVIN will fix and re-propose.

### 7. Verify

Run every verification gate end-to-end. Replay the blast radius: every entry is handled or explicitly deferred with a follow-up captured (a roadmap entry, ADR, or GitHub issue).

**Blockers:** type errors, failing tests, red infra probes. No "let's ship it and fix later."

**What you do:** Watch for the explicit "verification complete" summary. If something's yellow rather than green, decide together whether to ship.

### 8. Ship

Stage the commit, show the diff stat, confirm, commit. If a material decision was made, confirm the ADR landed on disk.

Append one line to `<workDir>/.marvin/memory.md` — the running decision log future sessions read.

Push / deploy **only on explicit user go-ahead**.

**What you do:** Final review of the commit message + diff stat. Push/deploy is your call.

## How this replaces "agent teams"

The roles the previous generation of tools split into multiple agents (PO · tech-lead · engineers · QA · devops) are the phases MARVIN moves through in ONE conversation. No handoffs between peers → none of the 17× error amplification and context-loss failures documented in the 2026 multi-agent coding literature.

The user is the continuous overwatch; MARVIN narrates enough to let them catch a wrong turn in real time.

## Escape hatches

- **Trivial changes** (typo fixes, one-line comment edits) skip the full workflow. `personality.ts` explicitly says: don't ADR a typo.
- **`Mode A` / `Mode B` / `Mode C`** — for ambiguous "check again" / "proceed" prompts, `personality.ts` has explicit rules on whether MARVIN should re-audit (Mode A), execute the already-proposed ADRs (Mode B), or move on (Mode C). See [Workflow audit](../../sidecar/packages/project-context/src/workflow-health.ts).

## The three-layer ramification stack

The 8 phases alone aren't enough; MARVIN also uses three layers of persistent state to catch cross-session ramifications:

1. **Knowledge graph** (`<workDir>/graphify-out/graph.json`) — structural "who calls / imports / subscribes to this" (queried in phase 2 and phase 3).
2. **ADRs** (`<workDir>/docs/adr/*.md`) — decisions structural analysis can't see (written in phase 4, read in phase 2 of every future session).
3. **Running memory** (`<workDir>/.marvin/memory.md`) — one-line gotchas and invariants (appended in phase 8, read in phase 2).

See [ADRs + memory](./memory-and-adrs.md) for how these three layers compose.

## Related

- [`personality.ts` CORE_BEHAVIOR](../../sidecar/packages/runtime/src/personality.ts) — the authoritative encoding.
- [Isolation contract](./isolation-contract.md) — why all per-project state lives in the user's own repo, not in MARVIN.
- [ADR-0001 — single assistant](../decisions/0001-single-assistant.md) — the "why phases, not agents" decision.
