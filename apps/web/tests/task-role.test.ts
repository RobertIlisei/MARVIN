import { describe, expect, it } from "vitest";

import { taskRoleOf } from "../src/components/brain/task-role";

// ADR-0007 + ADR-0014 both hinge on the description prefix contract:
// MARVIN sets `description: "advisor: …"` or `"scout: …"` on Task
// tool calls, and the Brain orbs detect the role from that prefix.
// If this regex drifts, the orbs stop lighting — silently — and the
// user loses the "MARVIN forked into a subagent" visual signal.
// These tests pin the accepted prefix shapes so a future refactor
// can't relax the detection by accident.

describe("taskRoleOf", () => {
  it("identifies an advisor call with a colon separator", () => {
    expect(taskRoleOf({ description: "advisor: should we split this PR?" })).toEqual({
      role: "advisor",
      topic: "should we split this PR?",
    });
  });

  it("identifies a scout call with a colon separator", () => {
    expect(taskRoleOf({ description: "scout: every encoder of session IDs" })).toEqual({
      role: "scout",
      topic: "every encoder of session IDs",
    });
  });

  it("accepts em-dash / hyphen / space as role separators", () => {
    // personality.ts shows the colon form, but the regex was written
    // permissively so an over-eager em-dash in the description still
    // lights the orb. Confirms that flexibility.
    expect(taskRoleOf({ description: "scout — session-id audit" })?.role).toBe("scout");
    expect(taskRoleOf({ description: "advisor - design check" })?.role).toBe("advisor");
    expect(taskRoleOf({ description: "scout audit-call" })?.role).toBe("scout");
  });

  it("is case-insensitive on the prefix", () => {
    expect(taskRoleOf({ description: "ADVISOR: review" })?.role).toBe("advisor");
    expect(taskRoleOf({ description: "Scout: look it up" })?.role).toBe("scout");
  });

  it("tolerates leading whitespace", () => {
    expect(taskRoleOf({ description: "   advisor: ok" })?.role).toBe("advisor");
  });

  it("returns null for Task calls without a sanctioned role prefix", () => {
    // Generic Task calls (from the claude_code preset, not sanctioned
    // by personality.ts) should NOT light any orb — the orbs are
    // specifically for the two ADR-documented subagent patterns.
    expect(taskRoleOf({ description: "refactor the auth module" })).toBeNull();
    expect(taskRoleOf({ description: "" })).toBeNull();
    expect(taskRoleOf({ description: "advisory tone" })).toBeNull(); // no separator
  });

  it("returns null for non-string / missing description", () => {
    expect(taskRoleOf({ description: 42 })).toBeNull();
    expect(taskRoleOf({})).toBeNull();
    expect(taskRoleOf(null)).toBeNull();
    expect(taskRoleOf(undefined)).toBeNull();
    expect(taskRoleOf("not an object")).toBeNull();
  });

  it("strips the prefix and whitespace from the topic", () => {
    expect(taskRoleOf({ description: "scout:    leading spaces trimmed" })?.topic).toBe(
      "leading spaces trimmed",
    );
    expect(taskRoleOf({ description: "advisor:" })?.topic).toBe("");
  });
});
