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
