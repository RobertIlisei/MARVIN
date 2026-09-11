import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetIntegrationJobsForTests,
  FINISHED_JOB_TTL_MS,
  finishIntegrationJob,
  getIntegrationJob,
  noteIntegrationProgress,
  startIntegrationJob,
} from "../src/integration-job";

// ADR-0109 amendment (2026-09-11). Prepare MR squashed six branches, made a
// commit under the project's compile-and-test hook and pushed — minutes of
// work behind one HTTP request that rendered nothing. The user: "where do I
// track it? … how do I know it's working or not?". These pin the record that
// answers that, including the part the request could never do: outliving it.

describe("integration jobs", () => {
  const repo = "/tmp/project-a";
  const other = "/tmp/project-b";

  beforeEach(() => __resetIntegrationJobsForTests());

  it("reports the phase it is in, and counts the branches it has folded", () => {
    startIntegrationJob(repo, "prepare-mr", 3);
    expect(getIntegrationJob(repo)?.phase).toBe("preparing");

    noteIntegrationProgress(repo, { phase: "squashing", current: "marvin/tab/a", done: 0, branch: "mr/2026-09-11-x" });
    expect(getIntegrationJob(repo)).toMatchObject({ phase: "squashing", current: "marvin/tab/a", done: 0, total: 3, branch: "mr/2026-09-11-x" });

    noteIntegrationProgress(repo, { phase: "squashing", current: "marvin/tab/b", done: 1 });
    expect(getIntegrationJob(repo)?.done).toBe(1);

    // The commit phase has no branch of its own — it must stop naming the
    // last one it squashed, or the panel reads as stuck on that branch.
    noteIntegrationProgress(repo, { phase: "committing", current: undefined, done: 3 });
    expect(getIntegrationJob(repo)?.current).toBeUndefined();
    expect(getIntegrationJob(repo)?.phase).toBe("committing");
  });

  it("refuses a second run on the same project, and allows one on another", () => {
    expect(startIntegrationJob(repo, "prepare-mr", 2)).not.toBeNull();
    expect(startIntegrationJob(repo, "merge-all", 2)).toBeNull();
    // Two checkouts are two independent pieces of work.
    expect(startIntegrationJob(other, "merge-all", 1)).not.toBeNull();

    finishIntegrationJob(repo, { ok: true, summary: "Squashed 2 branch(es)." });
    expect(startIntegrationJob(repo, "prepare-mr", 1)).not.toBeNull();
  });

  it("keeps the outcome readable after it ends — that is what a timed-out client comes back for", () => {
    startIntegrationJob(repo, "prepare-mr", 1);
    noteIntegrationProgress(repo, { phase: "pushing", current: "gitlab" });
    finishIntegrationJob(repo, { ok: true, summary: "Squashed 1 branch(es) into one commit on mr/x. Pushed to gitlab.", branch: "mr/x" });

    const job = getIntegrationJob(repo);
    expect(job).toMatchObject({ running: false, ok: true, branch: "mr/x" });
    expect(job?.summary).toContain("Pushed to gitlab");
    expect(job?.finishedAt).toBeTruthy();
    // Nothing is "currently" happening once it has ended.
    expect(job?.current).toBeUndefined();
  });

  it("forgets a finished run once it is old, so yesterday's never reads as news", () => {
    const start = new Date("2026-09-11T10:00:00.000Z");
    startIntegrationJob(repo, "merge-all", 1, start);
    finishIntegrationJob(repo, { ok: true, summary: "Merged 1 branch(es)." }, start);

    const stillFresh = start.getTime() + FINISHED_JOB_TTL_MS - 1_000;
    expect(getIntegrationJob(repo, stillFresh)).not.toBeNull();
    expect(getIntegrationJob(repo, start.getTime() + FINISHED_JOB_TTL_MS + 1_000)).toBeNull();
  });

  it("a running job is never aged out, however long it takes", () => {
    const start = new Date("2026-09-11T10:00:00.000Z");
    startIntegrationJob(repo, "prepare-mr", 1, start);
    noteIntegrationProgress(repo, { phase: "committing" }, start);
    // An hour into a pre-commit band that compiles and tests.
    expect(getIntegrationJob(repo, start.getTime() + 3_600_000)?.running).toBe(true);
  });

  it("a progress note after the end is ignored", () => {
    startIntegrationJob(repo, "prepare-mr", 1);
    finishIntegrationJob(repo, { ok: false, summary: "The squash commit was refused." });
    noteIntegrationProgress(repo, { phase: "pushing", current: "gitlab" });

    expect(getIntegrationJob(repo)).toMatchObject({ running: false, ok: false, phase: "preparing" });
  });
});
