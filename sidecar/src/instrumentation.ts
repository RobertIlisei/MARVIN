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

  // ADR-0107 — stamp every turn the previous process cut off BEFORE any
  // past-due wakeup fires into the same session.
  try {
    const { markInterruptedAtBoot } = await import("@marvin/runtime/session-recovery");
    const { marked } = markInterruptedAtBoot();
    if (marked) {
      // eslint-disable-next-line no-console
      console.log(`[session-recovery] marked ${marked} interrupted turn(s) from the previous process`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[session-recovery] boot scan failed:", err);
  }

  // ADR-0111 — closed `empty` and `merged` session trees leave the disk at
  // boot, under ADR-0103's guards (never dirty, never ready, never live).
  // Bounded: one reconcile per registered project.
  try {
    const { sweepWorktrees } = await import("@marvin/runtime/worktrees");
    const { getLiveTurn } = await import("@marvin/runtime/turn-registry");
    const { logTelemetry } = await import("@marvin/runtime/telemetry");
    let swept = 0;
    for (const p of listProjects()) {
      try {
        swept += sweepWorktrees(p.workDir, Date.now(), { isSessionBusy: (id) => !!getLiveTurn(id) && !getLiveTurn(id)?.ended })
          .filter((s) => s.deletedBranch).length;
      } catch {
        /* a project whose checkout is gone or not a repo: nothing to sweep */
      }
    }
    if (swept) {
      logTelemetry({ kind: "worktree.session.swept", trigger: "boot", swept });
      // eslint-disable-next-line no-console
      console.log(`[worktrees] reclaimed ${swept} spent session worktree(s) at boot`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[worktrees] boot sweep failed:", err);
  }
  const stats = armAll();
  if (stats.armed || stats.firedImmediately || stats.dropped) {
    // eslint-disable-next-line no-console
    console.log(
      `[wakeup-scheduler] re-armed ${stats.armed}, fired ${stats.firedImmediately} past-due, dropped ${stats.dropped} stale`,
    );
  }
}
