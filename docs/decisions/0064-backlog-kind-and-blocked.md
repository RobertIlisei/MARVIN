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

---

## Addendum (2026-08-14) — classification is automatic, not manual

**This reverses a decision made hours earlier in the same ADR.** The original
guidance told the model to OMIT `kind` when unsure, on the reasoning that "an
unspecified kind is honest; a guessed one makes the user's filters silently
wrong."

That was miscalibrated, and the user caught it: *"marvin creates backlog items
automatically, they should be categorized automatically."*

**Why the original reasoning was wrong.** MARVIN already assigns `severity` on
every auto-capture without hesitation — and severity is the *harder* judgement.
"How much does this matter" is genuinely subjective; "is this a bug or a doc
fix" mostly isn't. There was no principled reason to treat `kind` as the
dangerous one.

The deeper error was applying a caution meant for **destructive** actions to a
**reversible metadata** field. This ADR family has a standing rule — surface,
never mutate — because resolving the wrong item destroys work nobody agreed to
drop. A wrong `kind` destroys nothing: it is one click in a picker. Conflating
the two produced the worst outcome available: 430 of 432 items unclassified, a
Group-by-Kind view containing a single band called "Unclassified", and a feature
indistinguishable from a broken one.

The asymmetry runs the other way from what was assumed:

| | cost of being wrong | cost of abstaining |
|---|---|---|
| resolve / dismiss | work silently lost | user resolves it later |
| `kind` | one picker click | the filter is useless at any scale |

**Decision.** Classification happens at capture:

- The `backlog_add` tool description and `personality.ts` both now say **set
  `kind` on every capture**; `unspecified` is reserved for items that genuinely
  span kinds, not ones the model hasn't considered.
- A **mechanical nudge in the tool result**: when a newly-created item comes
  back `unspecified`, the response tells the model to re-add with a kind. Prose
  in the system prompt fires unreliably (the recurring lesson behind every firm
  surface in this repo); a line in the response is read at the moment it
  matters.
- Capture is still **never blocked** on classification. ADR-0047's invariant
  stands: an un-gated capture that loses the item is worse than an unclassified
  one.

**What did NOT change.** The groomer still only reports. Resolving, merging and
re-prioritising remain the user's, because those are the destructive class this
ADR family exists to protect.

## Scope of Done — addendum

- [x] Tool description + `personality.ts` require a kind on every capture.
- [x] Result-level nudge when a fresh capture lands `unspecified`.
- [x] Capture remains un-gated — a missing kind never rejects the item.
- [x] The reversal recorded here with the reasoning that failed, so the
      "unspecified is honest" argument isn't re-derived later.

---

## Addendum 3 (2026-08-14) — filtering by kind, and a staleness bug the pass exposed

**Filtering.** Grouping by kind shipped with the original ADR; *filtering* did
not. The Filter menu now carries a Kind section (six kinds + Unclassified),
persisted as one comma-joined `hiddenKinds` string rather than a flag per kind
— adding a kind later shouldn't strand a new `@AppStorage` key. Active kind and
blocked filters now appear in the menu's label: a filter that silently omits
rows reads as an empty backlog.

**The bug the classification pass exposed.** Classifying 58 items sent 58
PATCHes, and `updateBacklogItem` bumped `updated` on any field change. Result:
every staleness clock reset at once. The groom went 25 findings → 16, with all 9
`stale` and every `aging-bug` gone — which *looked exactly like* the new
`investigate`/`blocked` exemptions working, and was not.

`updated` drives staleness, so only a change to the WORK should count as
touching it. **Labelling an item is not engaging with it.** `updateBacklogItem`
now bumps `updated` only when `body` or `severity` changes; a kind/blocked edit
leaves it alone. Two regression tests pin both directions.

Timestamps on the affected items were restored from git (the backlog is tracked
in that project), keeping the classification.

**What it actually measures, with the clocks intact:**

| finding | before classification | after |
|---|---|---|
| duplicate | 9 | 9 |
| dangling-reference | 4 | 4 |
| stale (generic) | 9 | **0** |
| aging-bug | — | **10** |
| aging-high-severity | 3 | 2 |

Nine vague "this is old" findings became ten *named bugs left sitting*, five of
them production or security. The remaining stale items were all `investigate`
or `blocked` and correctly went quiet. That is the result the original ADR
claimed; it just wasn't the one the first measurement showed.

## Scope of Done — addendum 3

- [x] Filter by kind in the panel, persisted; active filters visible in the label.
- [x] `updateBacklogItem` no longer resets staleness for classification-only edits.
- [x] 2 regression tests (kind edit preserves `updated`; body edit bumps it).
- [x] Clobbered timestamps restored from git; classification retained.
