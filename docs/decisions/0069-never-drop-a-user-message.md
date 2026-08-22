# ADR-0069 — Never drop a user message: durable queue + safe preemption

- **Status:** Accepted
- **Date:** 2026-08-17
- **Related:** [ADR-0031](./0031-self-scheduled-wakeups.md) (self-scheduled wakeups),
  [ADR-0038](./0038-background-jobs-event-wakeups.md) (background-job completion turns),
  [ADR-0043](./0043-server-turn-announcements.md) (turn announcements),
  [ADR-0052](./0052-durable-plan-spine-and-plan-file-ownership.md) (state next to the transcript),
  [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) (transport auto-continue)

## Context

MARVIN runs **one turn per session**. Machine-initiated turns — scheduled
wakeups (ADR-0031), background-job completions (ADR-0038), auto-reconcile
(ADR-0057) and transport auto-continue (ADR-0067) — occupy that single slot
exactly like a human turn. A user message arriving during one was answered with
`409 turn-in-progress` and **discarded**.

Observed 2026-08-17 (local times):

| Time | Event |
|---|---|
| 22:19:07 | `commit and push.` completes |
| 22:19:20 | **wakeup fires** (background job done) → turn `97337619` |
| ~22:19:2x | user sends *"Update graphify and check what else needs to be updated"* → **409, discarded** |
| 22:20:02 | wakeup turn answers — about the M5 streak, not about graphify |
| 22:20:13 | **second wakeup fires** (auto-reconcile) |
| 22:20:36 | answers again |

Verified against the transcript: **150 `turn.user` records, none of them that
message.** Two machine turns talked past the human for 76 seconds and the only
thing thrown away was the human's input. (The nine text matches for "Update
graphify" are all inside the user's own resume macro, not a sent message.)

The user was left watching two answers to questions they had not asked, with a
stale 409 banner offering a **Retry** button that cannot work — the web client
already knows retrying "just 409s again until the running turn ends"; the macOS
client never got that fix.

### Why "just preempt" is not available

The 409 was itself a fix. From `route.ts`:

> …would otherwise evict the running turn and surface as "replaced by a newer
> turn" — **silently orphaning a possibly-heavy in-flight turn** … Refuse
> instead: to interrupt, the client must POST `/api/chat/cancel` first.

So blind eviction is the *older* bug: turns kept mutating the workspace after
the UI believed they had stopped. Any design that evicts unconditionally
regresses that.

## Decision

### 1. A human message is never refused

`POST /api/chat` no longer returns 409 to a user. The message is **persisted to
disk first** — `<dataDir>/sessions/<projectId>/<sessionId>.pending.json`, beside
the transcript and plan state (ADR-0052) — and only then is scheduling decided.
Everything after the write is best-effort; the words are already safe.

Disk, not memory: this app is reinstalled, relaunched and occasionally
OOM-killed. A queued instruction is the user's own words and the one thing in
the system that cannot be regenerated.

### 2. Preemption only when nothing has been written

The rule is decided by **observed behaviour, not by turn kind**:

```
preemptible = turn.kind === "machine" && !turn.mutated
```

`mutated` is set in the permission gate the instant a mutating call is
*allowed* — before the write lands, because a turn midway through an edit is
exactly the one that must not be interrupted. `isMutatingToolCall` is
deliberately conservative: the file-writing tools always count, `Bash` counts
unless it matches a short read-only allowlist, and an unreadable command counts
as mutating. A false positive only costs the user a queue; a false negative
corrupts an edit.

Classifying by *kind* alone would have been wrong: a transport auto-continue
(ADR-0067) is machine-started but resumes **real implementation work**, and the
mutation flag protects it automatically.

A preempted turn is aborted through the same `abortController` path
`/api/chat/cancel` uses, and its wakeup re-arms, so nothing is lost.

### 3. Coalescing and staleness

Drained messages become **one** turn, not N: three messages sent while blocked
would otherwise produce three sequential turns each acting on partial intent,
and the later ones routinely supersede the earlier. A message queued longer than
3 minutes is rendered with its age and an explicit instruction to check whether
it is still what's needed — turns here routinely run 5+ minutes, and "park it as
a backlog item" means something different once the context has moved on.

The queue caps at 20 and drops the **oldest** first: if someone is queuing
faster than MARVIN drains, their most recent intent is what still matters.

### 4. Machine turns are rate-limited

ADR-0031 bounds wakeup *depth* and *pending count* but never **rate** — which is
why two fired 53 seconds apart. `MIN_MACHINE_TURN_SPACING_MS = 60_000` makes a
too-soon wakeup re-arm on the existing deferral backoff, treated exactly like
"the session is busy". This reduces collision pressure at the source rather than
only handling it afterwards.

## Scope of Done

- [x] A human message is persisted before any scheduling decision; 409 removed
      for user sends (202 `queued-behind-turn` when it must wait).
- [x] Preemption gated on `machine && !mutated`; human turns never preempted;
      `registerLiveTurn` defaults to `"human"` so an un-migrated caller is never
      mistaken for a machine.
- [x] Queue drains on BOTH terminal paths (completion and error), coalesced,
      with staleness surfaced.
- [x] Machine-turn spacing wired into the scheduler's deferral path.
- [x] 25 new tests (13 queue, 12 preemption/mutation); 735 total pass, 8/8
      typecheck.

## Consequences

**Good.** The failure that motivated this — a user instruction silently
vanishing — becomes structurally impossible, including across a crash. A wakeup
no longer outranks the person it exists to serve.

**Risk.** Preemption depends on the abort genuinely stopping the SDK
subprocess. It is wired (`abortController` → `signal`), but that path has bitten
this repo before, which is precisely why it is gated on "nothing mutated yet" —
worst case, an abort that does not fully take still cannot corrupt anything.

**Deliberately not done.** The **macOS client** still shows the raw 409 JSON and
a Retry button. With this change 409 largely disappears for user sends, so the
banner should become rare — but the client should still adopt the web client's
handling and, more importantly, **retain the composer text until the server
acknowledges**. That is client work and belongs in its own change.

**Unverified.** Preemption and the drain are runtime behaviours that unit tests
can only approximate — the queue logic and the preemption predicate are covered,
the end-to-end path is not. Watch for: a queued message running twice (drain
called on both terminal paths), and a preempted wakeup that fails to re-arm.
