import { describe, expect, it } from "vitest";

import { type GhRun, interpretCiRuns, renderCiStatus } from "../src/ci-status";

// ADR-0059 follow-up — CI as audit evidence, so "shipped on a red build"
// becomes detectable. The interpreter is pure, so every case here runs with no
// network, no repo, and no `gh` installed.

const HEAD = "abc1234def5678";
const OTHER = "999888777666";

const run = (over: Partial<GhRun> = {}): GhRun => ({
  headSha: HEAD,
  status: "completed",
  conclusion: "success",
  workflowName: "test",
  url: "https://gh/run/1",
  ...over,
});

describe("interpretCiRuns — verdicts for THIS commit", () => {
  it("green when the newest run passed for HEAD", () => {
    expect(interpretCiRuns([run()], HEAD).state).toBe("green");
  });

  it("red on failure, timeout, cancellation and startup failure", () => {
    for (const conclusion of ["failure", "timed_out", "cancelled", "startup_failure"]) {
      expect(interpretCiRuns([run({ conclusion })], HEAD).state, conclusion).toBe("red");
    }
  });

  it("running when the run for HEAD hasn't finished", () => {
    expect(interpretCiRuns([run({ status: "in_progress", conclusion: null })], HEAD).state)
      .toBe("running");
  });

  it("does not call an ambiguous conclusion green", () => {
    // neutral / skipped / action_required are real outcomes; guessing "pass"
    // is how a red build hides.
    for (const conclusion of ["neutral", "skipped", "action_required", ""]) {
      expect(interpretCiRuns([run({ conclusion })], HEAD).state, conclusion).not.toBe("green");
    }
  });
});

describe("interpretCiRuns — when CI says nothing about this commit", () => {
  it("THE LOAD-BEARING CASE: a green run for a DIFFERENT commit is stale, not green", () => {
    // Otherwise an older pass vouches for a commit it never built — exactly the
    // failure this evidence exists to catch.
    const s = interpretCiRuns([run({ headSha: OTHER })], HEAD);
    expect(s.state).toBe("stale");
    expect(s.runSha).toBe(OTHER);
    expect(s.headSha).toBe(HEAD);
  });

  it("a RED run for a different commit is also just stale", () => {
    // Symmetry matters: it must not be reported as a failure of this commit.
    expect(interpretCiRuns([run({ headSha: OTHER, conclusion: "failure" })], HEAD).state)
      .toBe("stale");
  });

  it("unknown when there are no runs, or HEAD can't be resolved", () => {
    expect(interpretCiRuns([], HEAD).state).toBe("unknown");
    expect(interpretCiRuns([run()], null).state).toBe("unknown");
  });

  it("tolerates malformed rows instead of throwing", () => {
    expect(() => interpretCiRuns([{} as GhRun], HEAD)).not.toThrow();
    expect(interpretCiRuns([{ headSha: 42, status: null } as unknown as GhRun], HEAD).state)
      .toBe("stale");
  });
});

describe("renderCiStatus — what the auditor is told", () => {
  it("red says the claim contradicts the build", () => {
    const text = renderCiStatus(interpretCiRuns([run({ conclusion: "failure" })], HEAD));
    expect(text).toMatch(/CI RED/);
    expect(text).toMatch(/contradicts the build/i);
  });

  it("stale explicitly forbids reading it as a pass", () => {
    const text = renderCiStatus(interpretCiRuns([run({ headSha: OTHER })], HEAD));
    expect(text).toMatch(/says NOTHING about the current commit/i);
    expect(text).toMatch(/do not treat it as a pass/i);
  });

  it("unknown is framed as absence of evidence, not a pass", () => {
    const text = renderCiStatus({ state: "unknown", reason: "gh CLI unavailable" });
    expect(text).toMatch(/absence of evidence, not evidence of a pass/i);
  });

  it("running calls a 'verified' claim premature", () => {
    const text = renderCiStatus(interpretCiRuns([run({ status: "queued", conclusion: null })], HEAD));
    expect(text).toMatch(/premature/i);
  });
});
