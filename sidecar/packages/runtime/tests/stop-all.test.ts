import { describe, expect, it, vi } from "vitest";

import { describeStopScope, type StopScope } from "../src/stop-all";

// The cancel ORDER and the summary wording are the two things worth pinning
// without a live session. Order, because a wakeup cancelled last can fire
// while the turn is being torn down and start a fresh one — the bug this
// feature exists to prevent. Wording, because the confirmation is the whole
// safety story: a user agreeing to "everything" has agreed to nothing.

function scope(over: Partial<StopScope> = {}): StopScope {
  return { turnRunning: false, jobs: [], wakeups: [], ...over };
}

describe("describeStopScope", () => {
  it("returns null when there is nothing to stop", () => {
    // So the caller says "nothing is running" rather than showing a
    // confirmation for a no-op.
    expect(describeStopScope(scope())).toBeNull();
  });

  it("names one thing without list punctuation", () => {
    expect(describeStopScope(scope({ turnRunning: true }))).toBe(
      "the running turn",
    );
  });

  it("singular and plural are both correct", () => {
    expect(describeStopScope(scope({ jobs: [{ id: "a", command: "x" }] }))).toBe(
      "1 background job",
    );
    expect(
      describeStopScope(
        scope({
          jobs: [
            { id: "a", command: "x" },
            { id: "b", command: "y" },
          ],
        }),
      ),
    ).toBe("2 background jobs");
  });

  it("joins all three with a comma and an 'and'", () => {
    expect(
      describeStopScope(
        scope({
          turnRunning: true,
          jobs: [{ id: "a", command: "x" }],
          wakeups: [
            { id: "w", reason: "" },
            { id: "w2", reason: "" },
          ],
        }),
      ),
    ).toBe("the running turn, 1 background job and 2 scheduled wakeups");
  });
});

describe("stopAll ordering", () => {
  it("cancels wakeups and jobs BEFORE the turn", async () => {
    // A wakeup cancelled after the turn could fire during teardown and start
    // a new one; a job killed after the turn ends can still fire its
    // completion turn. The things that CREATE work die first.
    const calls: string[] = [];
    vi.doMock("../src/wakeup-scheduler", () => ({
      listWakeups: () => [{ id: "w1", reason: "r" }],
      cancelWakeup: () => {
        calls.push("wakeup");
        return true;
      },
    }));
    vi.doMock("../src/background-jobs", () => ({
      listBackgroundJobs: () => [{ id: "j1", command: "sleep 1" }],
      cancelBackgroundJob: () => {
        calls.push("job");
        return true;
      },
    }));
    vi.doMock("../src/turn-registry", () => ({
      getLiveTurn: () => ({}),
      cancelLiveTurn: () => {
        calls.push("turn");
        return true;
      },
    }));
    vi.resetModules();
    const { stopAll } = await import("../src/stop-all");

    const res = stopAll({ marvinSessionId: "s1", projectId: "p1" });

    expect(calls).toEqual(["wakeup", "job", "turn"]);
    expect(res).toEqual({
      turnCancelled: true,
      jobsCancelled: 1,
      wakeupsCancelled: 1,
      failed: [],
    });
    vi.doUnmock("../src/wakeup-scheduler");
    vi.doUnmock("../src/background-jobs");
    vi.doUnmock("../src/turn-registry");
  });
});

describe("session scoping", () => {
  it("touches only the named session's work, never another's", async () => {
    // Several sessions run at once, each on its own project. Stopping one
    // must not reach into another's jobs, wakeups or turn (user, 2026-08-31:
    // "we only need to kill the session we want with it's adiacents, not the
    // rest of the sessions or their jobs"). Every list call is asserted to
    // carry the session filter, and every cancel to hit only its own ids.
    const cancelledJobs: string[] = [];
    const cancelledWakeups: string[] = [];
    const cancelledTurns: string[] = [];
    const jobFilters: (string | undefined)[] = [];
    const wakeupFilters: unknown[] = [];

    const JOBS: Record<string, { id: string; command: string }[]> = {
      "session-a": [{ id: "job-a", command: "a" }],
      "session-b": [{ id: "job-b", command: "b" }],
    };
    const WAKEUPS: Record<string, { id: string; reason: string }[]> = {
      "session-a": [{ id: "wake-a", reason: "a" }],
      "session-b": [{ id: "wake-b", reason: "b" }],
    };

    vi.doMock("../src/wakeup-scheduler", () => ({
      listWakeups: (f: { marvinSessionId?: string }) => {
        wakeupFilters.push(f);
        return WAKEUPS[f?.marvinSessionId ?? ""] ?? [];
      },
      cancelWakeup: (id: string) => {
        cancelledWakeups.push(id);
        return true;
      },
    }));
    vi.doMock("../src/background-jobs", () => ({
      listBackgroundJobs: (sid?: string) => {
        jobFilters.push(sid);
        return JOBS[sid ?? ""] ?? [];
      },
      cancelBackgroundJob: (id: string) => {
        cancelledJobs.push(id);
        return true;
      },
    }));
    vi.doMock("../src/turn-registry", () => ({
      getLiveTurn: () => ({}),
      cancelLiveTurn: (sid: string) => {
        cancelledTurns.push(sid);
        return true;
      },
    }));
    vi.resetModules();
    const { stopAll, previewStopAll } = await import("../src/stop-all");

    const scope = previewStopAll({ marvinSessionId: "session-a" });
    expect(scope.jobs.map((j) => j.id)).toEqual(["job-a"]);
    expect(scope.wakeups.map((w) => w.id)).toEqual(["wake-a"]);

    stopAll({ marvinSessionId: "session-a", projectId: "p" });

    expect(cancelledJobs).toEqual(["job-a"]);
    expect(cancelledWakeups).toEqual(["wake-a"]);
    expect(cancelledTurns).toEqual(["session-a"]);
    // Nothing of session-b was even looked up unfiltered — an unfiltered
    // list call is how "stop this session" quietly becomes "stop them all".
    expect(jobFilters.every((f) => f === "session-a")).toBe(true);
    expect(
      wakeupFilters.every(
        (f) => (f as { marvinSessionId?: string })?.marvinSessionId === "session-a",
      ),
    ).toBe(true);

    vi.doUnmock("../src/wakeup-scheduler");
    vi.doUnmock("../src/background-jobs");
    vi.doUnmock("../src/turn-registry");
  });
});
