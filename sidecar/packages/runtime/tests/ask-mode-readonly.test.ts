import { describe, expect, it } from "vitest";

import { classifyToolCall } from "../src/sdk-runner";

// ADR-0036: Ask mode is read-only, enforced at the gate via the `readOnly`
// flag on classifyToolCall — the same collapse as the ADR-0030 subagent
// invariant, applied to the whole turn. These pin that a mutating tool is
// hard-denied under readOnly while reads stay allowed, and that the flag is
// what flips the decision (without it, a write is `confirm`, not `deny`).

describe("Ask mode read-only gate", () => {
  it("denies Write under readOnly with an Ask-mode reason", () => {
    const r = classifyToolCall(
      "Write",
      { file_path: "/tmp/x.ts", content: "x" },
      { readOnly: true },
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/read-only/i);
  });

  it("denies Edit and NotebookEdit under readOnly", () => {
    expect(
      classifyToolCall("Edit", { file_path: "/tmp/x.ts" }, { readOnly: true }).decision,
    ).toBe("deny");
    expect(
      classifyToolCall("NotebookEdit", { notebook_path: "/tmp/x.ipynb" }, { readOnly: true })
        .decision,
    ).toBe("deny");
  });

  it("still allows reads under readOnly", () => {
    expect(
      classifyToolCall("Read", { file_path: "/tmp/x.ts" }, { readOnly: true }).decision,
    ).toBe("allow");
  });

  it("readOnly is what flips a write from confirm to deny", () => {
    // Without the flag, a write is the usual gated `confirm`; the flag (and
    // only the flag) collapses it to `deny`. Proves Ask mode isn't just the
    // default gate behaviour.
    const agent = classifyToolCall("Write", { file_path: "/tmp/x.ts", content: "x" });
    expect(agent.decision).not.toBe("deny");
    const ask = classifyToolCall(
      "Write",
      { file_path: "/tmp/x.ts", content: "x" },
      { readOnly: true },
    );
    expect(ask.decision).toBe("deny");
  });
});
