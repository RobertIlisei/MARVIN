# ADR-0031 — MARVIN may self-schedule bounded wakeups

**Status:** Accepted — 2026-05-30
**Reverses (partially):** the "You are not a scheduler" clause in
`personality.ts` cross-phase rule 7 / Golden Rule "the user is the loop".
**Touches:** [chat route](../../sidecar/src/app/api/chat/route.ts),
[turn-registry](../../sidecar/packages/runtime/src/turn-registry.ts),
`personality.ts`.

## Context

MARVIN routinely narrated asynchronous follow-through it could not perform:

> *"Monitor armed — it watches health, boot failure, process death, and
> timeout, so silence won't mask a crash. I'll continue when it reports.
> The API cold-starts in ~30-60s."*

`Monitor` / `ScheduleWakeup` are **Claude Code harness** tools. MARVIN's
sidecar exposes no such tool, so the model imitated the phrasing from
training. The promise can never fire: a turn is a detached async loop
started **only** by `POST /api/chat → runAgentDetached` (`chat/route.ts`).
When the loop ends nothing re-enters it. The `turn-registry` + `/api/chat/
resume` machinery decouples a turn from the browser *tab*, never from the
*initiating request*. There is no server-side timer that starts a turn.

`personality.ts` already forbade this ("no 'I'll wait for the notification
and check the result' framing… You are not a scheduler"), but the rule was
written around three concrete **bash** anti-patterns (`&`/`nohup`,
`until…sleep`, marker files) plus one general clause. The "Monitor armed"
surface form slipped past — it reads like narrating a real harness tool, not
backgrounding a shell command. The MUST-NOT list never named the
hallucinated-watcher failure mode.

Two ways to close the gap: **forbid** the false promise harder, or **make it
real**. The project owner chose make-it-real: a build kicked off in one turn
should be able to report its own result in a later, self-started turn.

## Decision

Add a **bounded** server-side wakeup scheduler and a `schedule_wakeup` tool
MARVIN calls instead of narrating. This reverses "the user is the loop" for
one narrow, mechanically-bounded case: **time-delayed self-continuation**.

### What "bounded" means (the rails that keep this from becoming an
autonomous agent loop)

1. **Time-based only.** `schedule_wakeup({ delaySeconds, reason, prompt })`.
   `delaySeconds ∈ [60, 86_400]` (1 min – 24 h). No event/process watchers in
   v1 (a `watch_command` exit-trigger is a deliberate future extension).
2. **Per-session cap.** At most **5** pending wakeups per `marvinSessionId`.
   A 6th call is refused, not queued.
3. **Re-schedule depth guard.** A turn *started by a wakeup* may itself
   schedule at most **3** further wakeups, and a single causal chain is
   capped at **depth 8** — past that the scheduler drops the wakeup and logs
   it. This is the infinite-self-respawn backstop.
4. **Same permission posture, not elevated.** A fired turn resumes the
   session's SDK context and runs under the **same** model / permission
   strategy the scheduling turn used. No new capability; only a new *trigger*.
   The subagent read-only invariant (ADR-0030) is untouched — a wakeup starts
   a **main-loop** turn, not a subagent.
5. **Durable + idempotent.** Pending wakeups persist to
   `<dataDir>/wakeups/<projectId>.json` and are re-armed once on server boot.
   A wakeup whose fire-time elapsed during downtime fires **once, immediately**
   (not N times); a wakeup more than 24 h past-due is dropped as stale.
6. **Visible + cancellable.** `cancel_wakeup(id)` and the pending list are
   exposed to MARVIN; fired turns land in the transcript like any other turn.

### Delivery

The fired turn reuses the **existing** plumbing: it registers a `LiveTurn`
on the `turn-registry` bus and writes to the on-disk transcript, exactly as
a user-initiated turn does. An open tab on `/api/chat/resume` sees it live;
a closed tab sees it on next load from the transcript. No new always-on
client subscription in v1 (a persistent session-events SSE is the future
"push to an idle tab" extension).

## Consequences

- MARVIN stops lying about Monitors. The `personality.ts` MUST-NOT-scheduler
  block is replaced by a `schedule_wakeup` MUST trigger + the rails above.
- A fired wakeup **costs a turn** (real tokens, billed). The rails (cap,
  depth guard, 60 s floor) bound the blast radius; cost lands in the normal
  cost-tracker ledger.
- Single-process, in-memory timers — consistent with `turn-registry`'s
  existing "MARVIN is a single-process web app" assumption. Multi-process
  would need the same Redis swap the registry already calls out.

### Known limitation (v1)

`registerLiveTurn` keeps **one** live turn per `marvinSessionId` — a newer
turn evicts an in-flight one. So a wakeup that fires *while the user has a
turn running on the same session* would clobber it (and vice versa: the SDK
`resume` can't safely run two concurrent turns on one session anyway). v1
accepts this — wakeups are minutes-apart checks, the window is small. The
guard (on fire, if a live turn is active, re-arm +N s instead of clobbering)
is a deliberate follow-up, not silently half-built here.

## Implementation note — standalone module isolation (fixed in v0.1.16)

The first cut wired the fire handler ONLY from `instrumentation.ts` and kept
scheduler state (`fireHandler`, `timers`) as plain module-locals. That worked
in `next dev`/unit tests but **silently failed in the brew-distributed
standalone `.app`**: in Next's standalone output, `instrumentation.ts` is a
separate entry point and the bundler gives it its OWN copy of
`wakeup-scheduler`. The handler landed on instrumentation's copy while the
timers (armed during a chat turn) lived on the route chunk's copy — so
`fire()` ran, dropped the persisted record, found `fireHandler === null`, and
the wakeup evaporated with no turn. Symptom: `schedule_wakeup` succeeds and
persists, the timer fires, but **no follow-up turn ever appears**.

Fix: (1) pin scheduler state to a `globalThis` singleton so every module copy
shares one object; (2) ALSO wire the handler from `turn-orchestrator` (the
request-path chunk that schedules + fires timers), idempotently, so it's set
even if instrumentation never runs. Verified end-to-end against a real
standalone build (boot-time `armAll` fires a past-due wakeup → a
`[scheduled wakeup …]` turn is written). The lesson generalises: **any
cross-cutting singleton reachable from both `instrumentation` and route
chunks must be `globalThis`-pinned in standalone.**

## Scope of Done

- [ ] `schedule_wakeup` / `cancel_wakeup` tools callable from a MARVIN turn.
- [ ] A wakeup fires a real turn after the delay, resuming the SDK session,
      posting output to the transcript + bus.
- [ ] Wakeups persist and re-arm across a sidecar restart; past-due fires
      once; >24 h-stale is dropped.
- [ ] Per-session cap (5), re-schedule depth guard (8) enforced + unit-tested.
- [ ] `personality.ts` no longer claims MARVIN isn't a scheduler; the
      "Monitor armed" narration is replaced by the real tool.
