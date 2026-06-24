# ADR-0038 — Background jobs with event-based completion wakeups

**Status:** Accepted — 2026-06-11
**Touches:** new `background-jobs.ts` (runtime), `fireNow` export on
`wakeup-scheduler.ts`, three new `marvin-control` MCP tools
(`wakeup-tools.ts`), a `policy.ts` Bash deny, `personality.ts`. Builds on
self-scheduled wakeups (ADR-0031) and the background-Bash deny (ADR-0032).

## Context

MARVIN would say *"I started the build in the background, I'll be notified
when it's done"* — and never be. Three gaps stacked up:

1. **The deny was flag-only.** ADR-0032 hard-denied the SDK Bash
   `run_in_background: true` flag, but the gate didn't catch **shell-level**
   backgrounding — `cmd &`, `nohup`, `setsid`, `disown`. Those detach a
   process while the Bash tool call returns immediately, so MARVIN could
   still orphan a job past the gate.
2. **Wakeups were time-only.** ADR-0031's scheduler is `delaySeconds` /
   `setTimeout` — there is no event/process-exit wakeup. Nothing watches a
   spawned process.
3. So the orphaned job ran, **nothing fired a turn on its exit**, and MARVIN
   forgot. Same narration-vs-reality gap as ADR-0031, one layer deeper.

## Decision

Give MARVIN a **real background-job mechanism whose process EXIT fires a
follow-up turn** — exactly the pattern an agent harness uses to re-invoke an
agent when its background task ends. It's an **event-triggered wakeup** that
reuses ADR-0031's entire turn-dispatch path; only the trigger differs (a
process exit instead of a clock).

- **`background-jobs.ts`** — `startBackgroundJob({command, reason, ctx})`
  spawns `bash -lc <command>` as a **child of the long-lived sidecar** (not
  detached: it outlives the turn but dies if the app quits), streams
  stdout/stderr into an 8 KB in-memory tail, and registers `child.on('exit')`.
  On exit it builds a `WakeupRecord` (prompt = command + exit status +
  output tail + a succeed/diagnose instruction) and calls
  `wakeup-scheduler.fireNow(record)` — the SAME shared fire handler
  (`startScheduledTurn`) as a timed wakeup. Posture (model / strategy /
  effort) is inherited; depth advances for the chain-depth guard. Rails: ≤3
  concurrent per session, chain depth ≤8.
- **`fireNow(record)`** on the scheduler — dispatch immediately, bypassing
  the timer + persistence, so any event source can reuse the dispatch path.
- **MCP tools** (`marvin-control`): `run_background_job`,
  `list_background_jobs`, `cancel_background_job`. A cancelled job fires NO
  completion turn (the user asked it to stop).
- **Gate deny (`policy.ts`)** — `SHELL_BACKGROUND_RE` denies trailing `&`,
  `nohup`, `setsid`, `disown` (a negative lookbehind spares `&&` and `&>`),
  steering to `run_background_job`. The `run_in_background` flag deny now
  points at the same tool.
- **`personality.ts`** — the honest-follow-through options become: block
  foreground · `run_background_job` (event, preferred when MARVIN started the
  process) · `schedule_wakeup` (timed, for things with no process to watch —
  a remote CI run) · hand back.

### Why not persist jobs across sidecar restarts

A job is a child of the sidecar; if the sidecar dies the child dies, so
there's nothing to re-arm (unlike a timed wakeup, which is pure data). In
the rare restart-mid-job case the job is lost — acceptable for v1, and
honest (no false "it'll resume" promise). Documented, not hidden.

## Consequences

- "I'll be notified when the job's done" is now true: the exit event starts
  a real turn with the actual result. No more orphan-and-forget.
- The wakeup architecture is complete on both axes: **time-based**
  (ADR-0031) and **event-based** (this ADR), sharing one dispatch path.
- Shell backgrounding is fully closed at the gate (flag + shell syntax).

## Rejected alternatives

- **Just tighten the prompt / deny shell `&` and poll via schedule_wakeup.**
  Polling wastes turns and races the job; an exit event is strictly better
  when MARVIN owns the process.
- **Fully detached (`setsid`) jobs that survive sidecar restarts.** Then
  nothing can watch the exit (the whole problem), and orphans accumulate.

## Scope of Done

- [x] `run_background_job` spawns a tracked child, returns a job id, registers
      an exit watcher; exit fires a real turn (success/failure framed).
- [x] `fireNow` reuses the shared wakeup dispatch path.
- [x] Shell backgrounding (`&`/nohup/setsid/disown) denied at the gate;
      `&&`/`&>` spared.
- [x] `list_/cancel_background_job`; concurrency + chain-depth caps; cancel
      fires no turn.
- [x] `personality.ts` updated; 4 unit tests (exit→turn, failure framing,
      cancel-no-fire, concurrency cap); tools + runtime tsc clean.

## Addendum — 2026-06-24: don't fire a completion turn for shutdown/stop kills

**Symptom.** Every time the user quit and reopened MARVIN, the chat showed a
"A background job you started earlier has finished … Result: killed by signal
SIGTERM … It did NOT succeed — diagnose…" turn. One project had **174** of these
accumulated across its session transcripts.

**Root cause.** A long-running job (a Vite dev server) never exits on its own —
it only ends when killed. On app quit the macOS app SIGTERMs the sidecar, which
kills its child jobs (this module's documented contract: the job "dies if the
app quits"). `onExit` only suppressed the completion turn for jobs cancelled via
the explicit cancel tool (`rec.cancelled`), so a shutdown-SIGTERM'd job fell
through, fired a "did NOT succeed" turn, and that prompt resurfaced in the chat
on the next launch — regenerated every close→open cycle because the dev server
restarts each session.

**Fix.** `onExit` now also returns without firing when the job was killed by a
**stop/shutdown signal** (`SIGTERM` / `SIGINT` / `SIGHUP` / `SIGKILL`) — these
mean "stopped," not "finished," matching what `cancelBackgroundJob` already does
(SIGTERM → no turn). A job that exits with a numeric **code** (success or
failure) still fires, and genuine **crash** signals (`SIGSEGV` / `SIGABRT` /
`SIGBUS` / `SIGFPE`) are deliberately NOT in the set, so real crashes still
notify. Chosen over a process-level shutdown flag (which races the children's
exit events and entangles Next's exit semantics); the signal is a robust,
race-free proxy for "killed, not finished".

**Verified.** New test: a job killed by an external `SIGTERM` (not via the cancel
tool) fires no completion turn, while the existing exit-code-0 / exit-code-3
tests confirm genuine completions still fire. Existing transcript noise is left
as-is (the user's session history); the fix only stops new occurrences.
