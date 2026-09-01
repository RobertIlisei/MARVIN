import { describe, expect, it } from "vitest";

import { validateRememberPayload } from "../src/memory-mcp";

// ADR-0101 rests on the claim that an unevidenced practice lesson is rejected
// AT THE WRITE BOUNDARY, not merely discouraged in a prompt — this repo has
// measured prompt-only guidance firing ~0×. These pin the boundary.

const EVIDENCE =
  "Three fixes reasoned from source were wrong; a geometry probe found the " +
  "container at y=52 and the tree at y=0 — 52pt, exactly the title bar.";

describe("practice lessons must cite evidence", () => {
  it("rejects a lesson with no body", () => {
    const out = validateRememberPayload({
      hook: "Prefer measuring over reasoning about layout bugs",
      type: "practice",
    });
    expect(out).toContain("must cite the evidence");
  });

  it("rejects a lesson whose body is too thin to be evidence", () => {
    // The failure mode is not a WRONG lesson, it is a plausible one nobody can
    // check. "Prefer X over Y" with nothing behind it is advice.
    const out = validateRememberPayload({
      hook: "Measure first",
      body: "It works better.",
      type: "practice",
    });
    expect(out).toContain("advice, not a lesson");
  });

  it("accepts a lesson that says what happened", () => {
    expect(
      validateRememberPayload({
        hook: "Measure a layout bug before theorising about it",
        body: EVIDENCE,
        type: "practice",
      }),
    ).toBeNull();
  });

  it("does not impose the evidence floor on other content classes", () => {
    // A codebase fact is often one line, and always has been. The floor is
    // specific to the class ADR-0101 added, not a new tax on `remember`.
    expect(
      validateRememberPayload({ hook: "The API listens on 8080", type: "project" }),
    ).toBeNull();
    expect(validateRememberPayload({ hook: "Prefers prose to bullet lists", type: "user" })).toBeNull();
  });

  it("still rejects activity/status dressed up as a practice lesson", () => {
    // The evidence floor must not become a way in for the content class the
    // store already refuses — 419 KB of it, once (ADR-0042).
    const out = validateRememberPayload({
      hook: "Always run the suite before pushing",
      body: `${EVIDENCE} All 4262/4262 tests passing and tsc clean.`,
      type: "practice",
    });
    expect(out).toContain("activity/status");
  });
});
