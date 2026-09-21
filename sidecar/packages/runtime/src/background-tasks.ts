/**
 * BackgroundTaskLedger — the set of background tasks (subagents, backgrounded
 * Bash) live inside one SDK query (ADR-0080).
 *
 * Background subagents survive the main model turn's `result`. Verified live
 * on 0.3.245 (2026-08-29): a `background: true` agent dispatched at +6.1 s
 * kept running through the main `result` at +8.3 s, finished at +35.0 s, and
 * the CLI then RE-PROMPTED the main model with the completion — a second
 * assistant turn and a second `result` inside the same query. Anthropic's
 * docs say the same: "the task keeps running and emits a task_notification
 * when it settles."
 *
 * `runAgent` used to treat the first successful `result` as terminal: close
 * the input channel and arm a 5 s watchdog that force-aborts the subprocess.
 * With a background scout still running, that watchdog would have killed it
 * — silently, five seconds after dispatch. This ledger is what lets the
 * runner tell an intermediate `result` from the last one.
 *
 * The SDK's `background_tasks_changed` is a LEVEL signal with REPLACE
 * semantics ("swap your set for this payload"), not an edge to pair with
 * `task_started` / `task_notification`. Consuming it that way means a missed
 * bookend cannot wedge a stale "still running" — the SDK's own reasoning for
 * emitting it. Pure so the rule is testable without an SDK subprocess.
 */

export interface BackgroundTaskRef {
  task_id: string;
  task_type: string;
  description: string;
}

export class BackgroundTaskLedger {
  private tasks = new Map<string, BackgroundTaskRef>();

  /** Apply one `background_tasks_changed` payload. Replace, never merge. */
  replace(tasks: readonly BackgroundTaskRef[]): void {
    this.tasks = new Map(tasks.map((t) => [t.task_id, t]));
  }

  /** Number of tasks the SDK reports as still running. */
  get live(): number {
    return this.tasks.size;
  }

  /** True when a `result` should be treated as intermediate, not terminal. */
  get hasLive(): boolean {
    return this.tasks.size > 0;
  }

  /** Short human-readable roster, for telemetry lines. */
  describe(): string {
    return [...this.tasks.values()].map((t) => `${t.task_type}:${t.description}`).join(", ");
  }
}

/**
 * Narrow the SDK message stream to the one payload this ledger consumes.
 * The SDK types the union, but the runner iterates `SDKMessage` and needs a
 * predicate that survives a subtype it has never seen.
 */
export function backgroundTasksPayload(ev: unknown): readonly BackgroundTaskRef[] | null {
  if (!ev || typeof ev !== "object") return null;
  const o = ev as { type?: unknown; subtype?: unknown; tasks?: unknown };
  if (o.type !== "system" || o.subtype !== "background_tasks_changed") return null;
  if (!Array.isArray(o.tasks)) return [];
  return o.tasks.filter(
    (t): t is BackgroundTaskRef =>
      !!t && typeof t === "object" && typeof (t as BackgroundTaskRef).task_id === "string",
  );
}

/**
 * Narrow the SDK stream to `task_notification` — the completion EDGE.
 *
 * `background_tasks_changed` stays the source of truth for liveness (a level
 * signal cannot wedge on a missed bookend, which is why it was chosen). But a
 * count cannot say WHICH task ended, and an implementer's whole deliverable is
 * identified by its task id: without this, the branch it just finished is
 * known to nobody (ADR-0103).
 */
export function taskNotificationPayload(ev: unknown): { task_id: string } | null {
  if (!ev || typeof ev !== "object") return null;
  const o = ev as { type?: unknown; subtype?: unknown; task_id?: unknown };
  if (o.type !== "system" || o.subtype !== "task_notification") return null;
  return typeof o.task_id === "string" ? { task_id: o.task_id } : null;
}

/**
 * ADR-0080 drain bound — measures SILENCE after a deferred result, not time
 * since the result.
 *
 * 2026-09-13: a 15-minute absolute timer armed when a `result` was deferred
 * behind a live advisor, and was neither restarted by the model's continued
 * work nor cleared when the advisor settled. Twice in one session the model
 * was mid-edit, fifteen minutes and two seconds after the deferred result,
 * when the timer aborted the subprocess; the abort surfaced as "Claude Code
 * process aborted by user", the auto-continue rail refused (attempt 9 > cap
 * 3), and the tab went to STATE error with 87 files changed. Nothing was
 * hung; the bound was measuring the wrong thing.
 *
 * `touch()` on every event while armed restarts the clock; `clear()` when
 * the ledger has no live task. Only a subprocess that goes silent for the
 * whole bound while a task is still live is force-aborted — and that abort
 * ends a turn whose result was already captured, so the runner treats it as
 * the deferred result's end, not a failure.
 */
export class BackgroundDrainBound {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFire: (() => void) | null = null;

  constructor(private readonly maxSilenceMs: number) {}

  get armed(): boolean {
    return this.timer !== null;
  }

  /** Arm once; a second `arm` while armed keeps the running clock. */
  arm(onFire: () => void): void {
    if (this.timer) return;
    this.onFire = onFire;
    this.start();
  }

  /** The subprocess produced an event: it is alive, restart the clock. */
  touch(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.start();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onFire = null;
  }

  private start(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      const fire = this.onFire;
      this.onFire = null;
      fire?.();
    }, this.maxSilenceMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}
