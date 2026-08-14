# ADR-0064 — Backlog items get a `kind`, and `blocked` becomes its own axis

**Status:** Accepted — 2026-08-14
**Touches:** `backlog.ts` (`BACKLOG_KINDS`, `kind`/`blocked`/`blockedOn`,
back-compatible parse), `backlog-groom.ts` (two new rules + two exemptions),
`backlog-mcp.ts`, `/api/backlog` PATCH, macOS `BacklogService` + `BacklogPanel`
(group-by kind, hide-blocked, row badges, detail editing). Extends
[ADR-0044](./0044-project-backlog.md) and [ADR-0063](./0063-backlog-groomer-review-not-execute.md).

## Context

The question was whether to categorise backlog items (Improvement, Bugfix, …).
Rather than pick a taxonomy off a shelf, we measured a real backlog — 430 items,
56 live — and the data changed the answer twice.

**Severity is already working.** all: low 194 / med 174 / high 62; live: med 29 /
low 20 / high 8. A real spread, not everything on the `med` default. So a second
axis stands a fair chance of being used too.

**Type cannot be inferred from titles.** The leading token of the live items is
overwhelmingly a noun or identifier — `settings`, `model`, `gdpr`, `eppo`,
`authorized_keys.yml`, `dashboard.tsx:1073`. Only `verify`/`wire`/`update`
appear verb-like, once or twice each. The cheap option — derive the kind and
offer it — would have been mostly wrong, so classification has to be explicit.

**Reading all 56 produced a different taxonomy than the generic one.** Two
categories a bug/improvement/chore split would have hidden:

- **`investigate`** (~10 of 56) — the output is a DECISION, not a diff: *verify
  the quarantined EPPO codes*, *recheck the TLS + LPIS vintage*, *model the
  eco-scheme interaction*. Nearly a fifth of the live backlog.
- **`docs`** (~4) — drift between what's written and what's true, which is
  neither a bug in the product nor an improvement to it.

**And one item was not a kind at all.** ~5 items wait on something outside the
repo: *needs legal-counsel cutoff*, *need accountant sign-off*, *is undecided*,
*after first real pilot filing*. They sat as plain `open`, indistinguishable
from `Fix prod pgBackRest` — so "what can I pick up?" returned five things
nobody could pick up.

## Decision

**Two orthogonal additions.**

1. `kind ∈ unspecified | bug | feature | investigate | test | docs | chore`.
   Severity says how much it matters; kind says what sort of work it is.
2. `blocked: boolean` + `blockedOn: string`, deliberately **not** a kind and
   **not** a status value. A blocked bug and a blocked feature are both blocked,
   and folding it into `status` would make it mutually exclusive with `doing`.

### Both must change behaviour, or they're decoration

The groomer gains two rules and — more importantly — two **exemptions**:

| Rule | Why |
|---|---|
| `aging-bug` at the 14-day bar, not 30 | a bug is a thing that is currently wrong; unlike an investigation it doesn't become less true by being ignored |
| `blocked-without-reason` | blocked with no note means nobody can tell when it unblocks |
| **exempt:** `investigate` from `stale` | its output is a decision; "not decided yet" is a state, not a problem |
| **exempt:** `blocked` from `stale` and `aging-bug` | nagging about work the user cannot act on trains them to ignore the whole report |

The exemptions matter more than the rules. A groomer that nags about the wrong
things gets dismissed wholesale, and then the 22 real findings go unread too.

### No backfill

`unspecified` is the default and stays that way for all 430 existing items.
Bulk-classifying them would mean an LLM pass that MUTATES entries on a guess —
precisely what ADR-0063 refused to do, and a wrong kind is worse than none
because filters then silently miss items. Parsing is back-compatible: a file
written before these fields yields `unspecified` / `false`, never a guess.

An omitted `kind` on re-add KEEPS the existing value, so a provisional confirm
or a duplicate add can't wipe a classification the user made by hand.

## Consequences

- Panel gains Group-by ▸ Kind (with `Unclassified` sorted **last**, so the
  groups carrying information lead) and a Hide-blocked filter, off by default —
  hiding work silently is worse than showing it marked.
- Classification is editable in the detail view, saved eagerly like severity.
  It touches metadata only and never status, so a mis-click cannot resolve
  anything.
- The MCP tool's `kind` parameter tells the model to OMIT it when unsure. An
  unspecified kind is honest; a guessed one corrupts the user's filters.
- The taxonomy is fitted to one project's backlog. If a second project's data
  disagrees, the enum should be revisited rather than defended.

## Scope of Done

- [x] `kind` + `blocked`/`blockedOn` on the model, serialized, parsed
      back-compatibly.
- [x] Write paths: `backlog_add` (with an omit-when-unsure instruction),
      `/api/backlog` PATCH, macOS `classify`.
- [x] Groomer: `aging-bug`, `blocked-without-reason`, plus the `investigate`
      and `blocked` staleness exemptions.
- [x] Panel: group-by kind, hide-blocked, row badges, detail-view editing.
- [x] 10 new tests — defaults, round-trip, back-compat on a pre-ADR file,
      re-add preserving kind, and every new/exempted groomer rule. 641 total.
- [x] No backfill; 430 existing items remain `unspecified`.
