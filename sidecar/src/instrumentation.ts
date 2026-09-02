/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * Wires the self-wakeup scheduler (ADR-0031): injects the turn-dispatch
 * handler into the runtime scheduler (keeping the dependency direction
 * app → runtime) and re-arms any wakeups that were persisted before the
 * last shutdown. Past-due wakeups fire once; >24 h-stale are dropped.
 */
export async function register(): Promise<void> {
  // Only the Node.js server runtime has a filesystem + long-lived process;
  // the edge runtime can't host timers or read the data dir.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { setWakeupFireHandler, armAll } = await import(
    "@marvin/runtime/wakeup-scheduler"
  );
  const { startScheduledTurn } = await import("@/lib/turn-orchestrator");

  setWakeupFireHandler(startScheduledTurn);

  // ADR-0105 — the practice loop's nightly runner. A timer, not an agent:
  // it reads transcripts, updates a ledger, and stops.
  const { armPracticeSchedule } = await import("@marvin/runtime/practice");
  const { listProjects } = await import("@marvin/runtime/projects");
  armPracticeSchedule({ listProjectIds: () => listProjects().map((p) => p.id) });

  const stats = armAll();
  if (stats.armed || stats.firedImmediately || stats.dropped) {
    // eslint-disable-next-line no-console
    console.log(
      `[wakeup-scheduler] re-armed ${stats.armed}, fired ${stats.firedImmediately} past-due, dropped ${stats.dropped} stale`,
    );
  }
}
