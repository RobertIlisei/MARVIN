# ADR-0120 — A stalled turn: the Mac was asleep, a search was reading stdin, and a job's result was dropped

- **Status:** Accepted — implemented 2026-09-27
- **Date:** 2026-09-27
- **Related:** [ADR-0031](./0031-self-scheduled-wakeups.md) (wakeups), [ADR-0038](./0038-background-jobs-event-wakeups.md) (job completion starts a turn), [ADR-0080](./0080-background-subagents-and-builtin-readonly-agents.md) (deferred result, drain bound), [ADR-0104](./0104-ship-review-gate.md) (the two-denies brake), [ADR-0107](./0107-one-worktree-per-tab-and-a-multi-session-watch.md) (several live turns at once), "Measure before theorising" in `AGENTS.md`

## Context

A 20-hour session on a real project (2026-09-26 → 27) looked stuck every quarter of an hour: 51 silent gaps of 5–18 minutes, each ending in an `api_retry` with no HTTP status, an advisor consult that "took" 2 h 43 min, and finally a turn that stopped mid-plan and stayed open for a further 15 minutes with nothing running. Three separate causes, each measured rather than guessed:

1. **The machine was asleep.** `pmset -g log` put a macOS `Sleep` within seconds of every gap's start and a `DarkWake` within a second of its end — 51 of 51. The AC power profile had `sleep 1`: one idle minute without a power assertion and the Mac slept; Power Nap woke it for ~45 s every ~15 minutes, the SDK found its stream dead, retried, got a minute of work done, and the machine slept again. About 11 of the 20 hours. MARVIN already wraps its long test runs in `caffeinate -i` (which is why *those* finished), and Claude Code raises a 300 s assertion around a tool call — but nothing covered the model's own API wait, which is most of a turn.
2. **A search was reading stdin.** At 08:07 the model ran `for A in …; do echo "== $A <- $(rg -l "\b$A\b" --type java | …)"; done`. `rg` with a pattern and no path reads standard input; a tool call's stdin is the SDK's message pipe, which never closes. Claude Code moved the call to the background at the ten-minute mark, the model carried on (and learned to append `< /dev/null` to every later `rg`), and when it ended its turn at 12:31 the sidecar kept the turn open for that "live" task — correctly, by ADR-0080: the CLI re-prompts the model when a background task settles, so the `result` was intermediate. The drain bound fired after 15 minutes of silence, as designed. The process had been asleep for 4 h 36 min.
3. **The job's result was nearly lost, and six others were.** The RED test run the model had started as a background job finished during that window. Its completion wakeup deferred behind the held turn on a 20 s backoff and would have been *dropped* at 60 deferrals (20 min); it fired at 46. The sidecar log for the same session shows six earlier job-done wakeups dropped that way ("stayed busy through 60 deferrals") — the commit hooks and verification suites of every milestone. The model learned whether its own commits had landed by polling `git log`. The 20-minute premise ("a session live continuously for that long is pathological") was written before turns routinely ran 100 minutes.

## Decision

1. **Keep the Mac awake while a turn is live** (`keep-awake.ts`, wired into `turn-registry.ts`). The registry knows exactly when work is in flight, so the first live turn spawns `caffeinate -i -w <sidecar pid>` and the last one's end kills it — one assertion for however many tabs are running (ADR-0107), none outside a turn. `-w` ties it to the sidecar's life if the sidecar dies first. Idle *system* sleep only; the display still sleeps. Darwin only; `MARVIN_KEEP_AWAKE=0` disables it. The machine-level alternative (`sudo pmset -c sleep 0`) is the user's call and is not touched.
2. **A search that would block on stdin is refused at the gate** (`checkSearchWithoutPath`, first check in `runDesignHooks`). `rg` / `grep` / `egrep` / `fgrep` with a pattern and no path operand, not fed by a pipe and with no `<` redirect, is denied with the fix in the message. Quotes, `--`, `-e`/`-f` patterns, value-taking flags (per tool — `-r` is a value for rg and recursive for grep), listing modes (`--files`, `--version`) and `$( … )` inside double quotes — the shape that actually hung — are handled; anything the small parser cannot read is allowed (fail open). ADR-0104's brake: two refusals per turn, then allow and log the bypass. Deterministic and free, so a gate rather than a prompt line — the model rediscovered `< /dev/null` on its own within the session and still lost the turn.
3. **A background-job completion is never dropped on the 20-minute rule** (`wakeup-scheduler.ts`). A wakeup whose reason carries the `background job done:` prefix keeps yielding for six hours (`MAX_JOB_DONE_DEFERRALS`); a self-scheduled check-in still gives up at 60. Neither ever evicts a live turn — that guarantee (ADR-0069) is unchanged.

Not changed, deliberately: the ADR-0080 drain bound. Fifteen minutes of silence with a task live is the right measure once the task cannot be a hung search — a legitimately long Maven run behind a backgrounded Bash call must still be allowed to re-prompt the model when it finishes.

## Consequences

- A turn's wall-clock is its work again. The mitigation applied by hand before this landed (`caffeinate -i -w <sidecar pid>` from a terminal) is what the sidecar now does itself, scoped to live turns.
- A hung search costs one denied call and a corrected retry instead of a quarter of the day. Commands with a heredoc body that *contains* a bare `rg PATTERN` line are parsed line by line and may be refused too — that script would hang when run, so the refusal is still right, and the third call goes through.
- A job-done wakeup that arrives during a long turn now fires when the turn ends, however long that takes, and the six-per-day silent losses stop. The queue can hold such a wakeup for up to six hours; `listWakeups` shows it with its deferral count.
- Observed and left alone: the wakeup turn that fired four seconds after the drain bound's force-abort returned an empty `result` in six seconds (no text, no tool call), so that RED-run result reached nobody. Whether a machine turn should wait out an abort before resuming the same SDK session is a separate question; noted here so it is not rediscovered from zero.

## Scope of Done

- [x] `keep-awake.ts`: reference-counted `caffeinate -i -w <pid>`, darwin only, env kill-switch; 3 tests (raise/share/release, off-platform and disabled, self-exit and spawn failure)
- [x] `turn-registry.ts` calls it on register, end and eviction; existing registry tests green
- [x] `checkSearchWithoutPath` + `searchesWithoutPath`, first in `runDesignHooks`, two-denies brake; 3 tests covering the real command, `$( … )` in double quotes, pipes, redirects, `--`, per-tool value flags and the bypass
- [x] `MAX_JOB_DONE_DEFERRALS` / `isJobDoneWakeup`; 2 tests (classification; a job-done wakeup survives 60 deferrals, a plain one does not, the six-hour bound drops it)
- [x] Full sidecar suite green, runtime typecheck clean
- [x] Roadmap and changelog entries; app rebuilt and restarted with the fix
