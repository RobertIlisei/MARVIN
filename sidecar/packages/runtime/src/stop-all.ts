/**
 * Stop everything a session has running.
 *
 * The existing Stop button aborts the in-flight turn and nothing else, which
 * is right for what it is: "stop talking, I want to say something". But a
 * turn can leave work behind that outlives it — `run_in_background` jobs
 * (their own child processes) and scheduled wakeups (which will start a NEW
 * turn later, on their own). Aborting the turn and walking away leaves those
 * running, and a wakeup firing minutes after the user pressed Stop is the
 * worst kind of surprise: the session they thought they had ended talks back.
 *
 * So this is the bigger hammer, deliberately separate from Stop rather than
 * folded into it.
 *
 * Two operations, and the split matters: `previewStopAll` reports what WOULD
 * be stopped so the UI can name it in a confirmation, and `stopAll` does it.
 * Confirming against a count the user never saw is how you end up killing a
 * 40-minute build someone forgot was running.
 */

import {
  cancelBackgroundJob,
  listBackgroundJobs,
} from "./background-jobs";
import { cancelLiveTurn, getLiveTurn } from "./turn-registry";
import { cancelWakeup, listWakeups } from "./wakeup-scheduler";

export interface StopScope {
  /** A turn is in flight for this session. */
  turnRunning: boolean;
  /** Background jobs belonging to this session, newest last. */
  jobs: { id: string; command: string }[];
  /** Wakeups this session scheduled, soonest first. */
  wakeups: { id: string; reason: string }[];
}

export interface StopResult {
  turnCancelled: boolean;
  jobsCancelled: number;
  wakeupsCancelled: number;
  /** Anything that reported failure on cancel — already gone, usually. */
  failed: string[];
}

/** What `stopAll` would stop, without stopping anything. */
export function previewStopAll(input: {
  marvinSessionId: string;
  projectId?: string;
}): StopScope {
  const { marvinSessionId, projectId } = input;
  return {
    turnRunning: getLiveTurn(marvinSessionId) !== null,
    jobs: listBackgroundJobs(marvinSessionId).map((j) => ({
      id: j.id,
      command: j.command,
    })),
    // Filtered by SESSION, not project: stopping this session must not cancel
    // a wakeup another session scheduled against the same project.
    wakeups: listWakeups({ marvinSessionId, projectId }).map((w) => ({
      id: w.id,
      reason: w.reason ?? "",
    })),
  };
}

/**
 * Cancel the live turn, every background job, and every pending wakeup.
 *
 * Order is deliberate: **wakeups first**, then jobs, then the turn. A wakeup
 * cancelled last could fire while the turn was being torn down and start a
 * fresh one; a job killed after the turn ends can still fire its completion
 * turn. Killing the things that CREATE work before the thing that is doing
 * work is what makes this idempotent rather than a race.
 */
export function stopAll(input: {
  marvinSessionId: string;
  projectId?: string;
}): StopResult {
  const { marvinSessionId, projectId } = input;
  const scope = previewStopAll({ marvinSessionId, projectId });
  const failed: string[] = [];

  let wakeupsCancelled = 0;
  for (const w of scope.wakeups) {
    if (cancelWakeup(w.id, projectId)) wakeupsCancelled += 1;
    else failed.push(`wakeup:${w.id}`);
  }

  let jobsCancelled = 0;
  for (const j of scope.jobs) {
    if (cancelBackgroundJob(j.id)) jobsCancelled += 1;
    else failed.push(`job:${j.id}`);
  }

  const turnCancelled = cancelLiveTurn(marvinSessionId);

  return { turnCancelled, jobsCancelled, wakeupsCancelled, failed };
}

/**
 * One line describing a scope, for a confirmation dialog.
 *
 * Returns null when there is nothing to stop — the caller should then say so
 * rather than showing a confirmation for a no-op.
 */
export function describeStopScope(scope: StopScope): string | null {
  const parts: string[] = [];
  if (scope.turnRunning) parts.push("the running turn");
  if (scope.jobs.length > 0) {
    parts.push(
      `${scope.jobs.length} background job${scope.jobs.length === 1 ? "" : "s"}`,
    );
  }
  if (scope.wakeups.length > 0) {
    parts.push(
      `${scope.wakeups.length} scheduled wakeup${scope.wakeups.length === 1 ? "" : "s"}`,
    );
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  const last = parts.pop() as string;
  return `${parts.join(", ")} and ${last}`;
}
