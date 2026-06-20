import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  registerPendingConfirm,
  resolvePendingConfirm,
} from "../src/confirm-registry";

// ADR-0040 bug (2026-06-20): an AskUserQuestion confirm was registered with the
// default 5-minute auto-deny timeout. A human deliberating on a decision for
// >5 min was silently AUTO-DENIED — the turn proceeded ignoring their choice,
// and a later "Send choice" click hit a resolved/gone confirm (404) so the
// button "did nothing". Evidence: a transcript showed AskUserQuestion in
// `permission_denials` ~6m23s after the prompt (> the 300s timeout).
//
// The fix registers AskUserQuestion with NO auto-deny timer (timeoutMs = 0):
// the model is explicitly blocking on the human, and the turn's `finally`
// (clearTurnConfirms) + Stop are the escape hatches. These pin the registry
// contract that fix relies on.

describe("confirm-registry — auto-deny timeout contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("auto-denies once the timeout elapses when timeoutMs > 0 (permission confirms)", () => {
    let result: PermissionResult | undefined;
    registerPendingConfirm("t1", "u1", (r) => (result = r), {}, 300_000);

    vi.advanceTimersByTime(299_000);
    expect(result).toBeUndefined(); // still waiting just before the deadline

    vi.advanceTimersByTime(2_000);
    expect(result?.behavior).toBe("deny");
    if (result?.behavior === "deny") {
      expect(result.message).toMatch(/Auto-denied/i);
    }
  });

  it("does NOT auto-deny when timeoutMs is 0 — the decision waits for the human", () => {
    let result: PermissionResult | undefined;
    registerPendingConfirm("t2", "u2", (r) => (result = r), {}, 0);

    // An hour passes; a deliberating (or distracted) human must NOT be denied.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(result).toBeUndefined();

    // It resolves only on an explicit user action (their answer).
    const ok = resolvePendingConfirm("t2", "u2", {
      behavior: "allow",
      updatedInput: { answers: { q: "their choice" } },
    });
    expect(ok).toBe(true);
    expect(result?.behavior).toBe("allow");
  });

  it("a late timer after an explicit resolve is a no-op (no double-resolve)", () => {
    const calls: PermissionResult[] = [];
    registerPendingConfirm("t3", "u3", (r) => calls.push(r), {}, 300_000);

    // User answers before the timeout.
    resolvePendingConfirm("t3", "u3", { behavior: "allow", updatedInput: {} });
    // The (now-cleared) timer must not fire a second resolve.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.behavior).toBe("allow");
  });
});
