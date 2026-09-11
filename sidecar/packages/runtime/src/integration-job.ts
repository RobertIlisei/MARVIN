/**
 * What a long integration is doing RIGHT NOW (ADR-0109, amended 2026-09-11).
 *
 * `prepareMergeRequest` squashes N branches, makes one commit **under the
 * project's own commit hooks** and optionally pushes it. On a real project
 * that is minutes: a compile-and-test pre-commit band, then a push to a
 * remote. The client fired it as one HTTP request and rendered nothing — the
 * sheet closed, two buttons dimmed, and the user (2026-09-11) asked the only
 * question that matters: *"where do I track it? … how do I know it's working
 * or not?"*
 *
 * The honest shape is a job. A run is registered here when it starts, its
 * phase is updated as it moves, and the outcome stays readable after it ends.
 * That makes progress a poll away, and — the part the HTTP request could never
 * do — it survives the client giving up, switching projects, or being
 * relaunched: the work continues in the sidecar and the panel finds it again.
 *
 * In memory on purpose. A job outlives no sidecar: if the process restarts,
 * the git work it was doing is either committed or not, and `reconcileWorktrees`
 * derives that from git, which is the authority (ADR-0103). A job file would be
 * a second, staler answer to a question git already answers.
 *
 * One job per project directory: the two flows both mutate the same checkout,
 * and a second concurrent run is refused at the boundary rather than left to
 * interleave two merges.
 */

export type IntegrationPhase =
  /** Cutting the integration branch and preparing its checkout. */
  | "preparing"
  /** Folding one branch in with `merge --squash`. */
  | "squashing"
  /** The one commit a reviewer reads — runs the project's hooks. */
  | "committing"
  /** `git push`, and the merge request if asked for. */
  | "pushing"
  /** `merge --no-ff` of one branch into the current one (Merge all). */
  | "merging";

export type IntegrationKind = "prepare-mr" | "merge-all";

export interface IntegrationJob {
  id: string;
  kind: IntegrationKind;
  phase: IntegrationPhase;
  /** What it is working on right now — a branch, or a remote while pushing. */
  current?: string;
  /** Branches finished so far, out of `total`. */
  done: number;
  total: number;
  /** The integration branch, once it has a name. */
  branch?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  ok?: boolean;
  /** The outcome sentence, once finished — the same one the caller returns. */
  summary?: string;
  /** True while the job is still moving. */
  running: boolean;
}

/**
 * How long a finished job stays readable. Long enough that a client which
 * timed out, or was relaunched, still finds the outcome; short enough that
 * yesterday's run never shows up as news.
 */
export const FINISHED_JOB_TTL_MS = 10 * 60_000;

const jobs = new Map<string, IntegrationJob>();

function isStale(job: IntegrationJob, now: number): boolean {
  if (job.running || !job.finishedAt) return false;
  return now - Date.parse(job.finishedAt) > FINISHED_JOB_TTL_MS;
}

/**
 * Register a run. Returns `null` when one is already in flight for this
 * project — the caller refuses rather than interleaving two merges into the
 * same checkout.
 */
export function startIntegrationJob(
  workDir: string,
  kind: IntegrationKind,
  total: number,
  now = new Date(),
): IntegrationJob | null {
  const existing = jobs.get(workDir);
  if (existing && existing.running) return null;
  const stamp = now.toISOString();
  const job: IntegrationJob = {
    id: `${kind}-${now.getTime()}`,
    kind,
    phase: "preparing",
    done: 0,
    total: Math.max(0, total),
    startedAt: stamp,
    updatedAt: stamp,
    running: true,
  };
  jobs.set(workDir, job);
  return job;
}

/** Move a running job on. A finished or missing job is left alone. */
export function noteIntegrationProgress(
  workDir: string,
  patch: Partial<Pick<IntegrationJob, "phase" | "current" | "done" | "total" | "branch">>,
  now = new Date(),
): void {
  const job = jobs.get(workDir);
  if (!job || !job.running) return;
  // `current` is cleared by an explicit undefined, so a phase with no subject
  // (committing) does not keep naming the last branch it squashed.
  if ("current" in patch) {
    if (patch.current === undefined) delete job.current;
    else job.current = patch.current;
  }
  if (patch.phase !== undefined) job.phase = patch.phase;
  if (patch.done !== undefined) job.done = patch.done;
  if (patch.total !== undefined) job.total = patch.total;
  if (patch.branch !== undefined) job.branch = patch.branch;
  job.updatedAt = now.toISOString();
}

/** End a run, keeping its outcome readable for `FINISHED_JOB_TTL_MS`. */
export function finishIntegrationJob(
  workDir: string,
  outcome: { ok: boolean; summary: string; branch?: string },
  now = new Date(),
): void {
  const job = jobs.get(workDir);
  if (!job) return;
  job.running = false;
  job.ok = outcome.ok;
  job.summary = outcome.summary;
  if (outcome.branch) job.branch = outcome.branch;
  delete job.current;
  job.finishedAt = now.toISOString();
  job.updatedAt = job.finishedAt;
}

/** The current run, or the last one while it is still fresh. */
export function getIntegrationJob(workDir: string, now = Date.now()): IntegrationJob | null {
  const job = jobs.get(workDir);
  if (!job) return null;
  if (isStale(job, now)) {
    jobs.delete(workDir);
    return null;
  }
  return { ...job };
}

/** Test seam. */
export function __resetIntegrationJobsForTests(): void {
  jobs.clear();
}
