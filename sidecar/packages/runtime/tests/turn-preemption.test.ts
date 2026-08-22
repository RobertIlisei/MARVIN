import { beforeEach, describe, expect, it } from "vitest";

import {
  endLiveTurn,
  isPreemptible,
  markTurnMutated,
  registerLiveTurn,
} from "../src/turn-registry";
import { isMutatingToolCall } from "../src/sdk-runner";

// ADR-0069. Preemption is the risky half of the fix: the 409 it replaces was
// itself introduced to stop turns being evicted mid-work and left "silently
// orphaning a possibly-heavy in-flight turn". So the rule is narrow — only a
// MACHINE turn that has not yet been allowed a mutating call may be cut off.
// These tests pin both sides of that line.

let n = 0;
const session = () => `sess-${(n += 1)}`;

describe("isPreemptible — who may be interrupted", () => {
  it("a machine turn that has only read IS preemptible", () => {
    const s = session();
    const t = registerLiveTurn({ turnId: "t1", marvinSessionId: s, projectId: "p", kind: "machine" });
    expect(isPreemptible(t)).toBe(true);
  });

  it("a machine turn that has started WRITING is not", () => {
    // The exact case the 409 existed to protect: interrupting mid-edit.
    const s = session();
    const t = registerLiveTurn({ turnId: "t2", marvinSessionId: s, projectId: "p", kind: "machine" });
    markTurnMutated(s);
    expect(isPreemptible(t)).toBe(false);
  });

  it("a HUMAN turn is never preempted, even before it writes", () => {
    // The user's own earlier work must not be killed by their next message.
    const s = session();
    const t = registerLiveTurn({ turnId: "t3", marvinSessionId: s, projectId: "p", kind: "human" });
    expect(isPreemptible(t)).toBe(false);
  });

  it("defaults to human when the caller does not say", () => {
    // Fail safe: an un-migrated call site must never be treated as machine.
    const s = session();
    const t = registerLiveTurn({ turnId: "t4", marvinSessionId: s, projectId: "p" });
    expect(t.kind).toBe("human");
    expect(isPreemptible(t)).toBe(false);
  });

  it("an already-ended turn is not preemptible, and null is safe", () => {
    const s = session();
    const t = registerLiveTurn({ turnId: "t5", marvinSessionId: s, projectId: "p", kind: "machine" });
    endLiveTurn(t, { event: "turn.completed", data: {} });
    expect(isPreemptible(t)).toBe(false);
    expect(isPreemptible(null)).toBe(false);
  });

  it("markTurnMutated on an ended turn does not resurrect state", () => {
    const s = session();
    const t = registerLiveTurn({ turnId: "t6", marvinSessionId: s, projectId: "p", kind: "machine" });
    endLiveTurn(t, { event: "turn.completed", data: {} });
    markTurnMutated(s);
    expect(t.mutated).toBe(false);
  });

  it("markTurnMutated on an unknown session is a no-op, not a throw", () => {
    expect(() => markTurnMutated("no-such-session")).not.toThrow();
  });
});

describe("isMutatingToolCall — conservative by design", () => {
  it("treats the file-writing tools as mutating", () => {
    for (const t of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
      expect(isMutatingToolCall(t, {}), t).toBe(true);
    }
  });

  it("treats read-only tools as non-mutating", () => {
    for (const t of ["Read", "Grep", "Glob", "WebFetch"]) {
      expect(isMutatingToolCall(t, {}), t).toBe(false);
    }
  });

  it("allows a short list of clearly read-only Bash commands", () => {
    for (const c of ["git status", "git log --oneline", "ls -la", "rg foo", "cat x.ts", "pwd"]) {
      expect(isMutatingToolCall("Bash", { command: c }), c).toBe(false);
    }
  });

  it("treats any other Bash as mutating — a false positive only costs a queue", () => {
    for (const c of ["rm -rf build", "git commit -m x", "npm install", "make e2e", "./deploy.sh"]) {
      expect(isMutatingToolCall("Bash", { command: c }), c).toBe(true);
    }
  });

  it("treats Bash with no readable command as mutating", () => {
    // Unknown shape must never be assumed safe to interrupt.
    expect(isMutatingToolCall("Bash", {})).toBe(true);
    expect(isMutatingToolCall("Bash", { command: 42 as unknown as string })).toBe(true);
  });
});
