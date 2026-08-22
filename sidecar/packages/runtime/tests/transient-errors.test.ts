import { describe, expect, it } from "vitest";

import {
  autoContinueDelaySeconds,
  autoContinuePrompt,
  classifyTurnError,
  MAX_AUTO_CONTINUES,
} from "../src/transient-errors";

// ADR-0067. The measured failure: 5.1 h across 4 incidents where a turn died on
// `API Error: Stream idle timeout` and the session sat dead until a human
// noticed — one gap was 4.5 h, starting at 01:47. The risk in fixing it is the
// mirror image: auto-continuing something that genuinely failed. These tests
// pin both edges.

describe("classifyTurnError — the real observed failure", () => {
  it("treats the exact production error as transient", () => {
    const r = classifyTurnError("API Error: Stream idle timeout - partial response received");
    expect(r.transient).toBe(true);
  });

  it.each([
    "socket hang up",
    "read ECONNRESET",
    "fetch failed",
    "Error 529: overloaded",
    "503 Service Unavailable",
    "Gateway timeout",
    "connection reset by peer",
    "request timeout",
  ])("recognises transport failure: %s", (msg) => {
    expect(classifyTurnError(msg).transient).toBe(true);
  });
});

describe("classifyTurnError — things that must NEVER auto-continue", () => {
  it("does NOT retry a context overflow (the same prompt cannot fit twice)", () => {
    // Retrying bills for a request that is guaranteed to fail identically.
    expect(classifyTurnError("Prompt is too long: 210000 tokens").transient).toBe(false);
    expect(classifyTurnError("context length exceeded").transient).toBe(false);
  });

  it("does NOT restart work the user just cancelled", () => {
    expect(classifyTurnError("AbortError: The operation was aborted").transient).toBe(false);
    expect(classifyTurnError("cancelled by user").transient).toBe(false);
  });

  it("does NOT retry auth, permission or billing failures", () => {
    for (const m of [
      "401 Unauthorized",
      "invalid API key",
      "permission denied",
      "Your credit balance is too low",
      "quota exceeded",
    ]) {
      expect(classifyTurnError(m).transient, m).toBe(false);
    }
  });

  it("treats an unrecognised error as terminal rather than guessing", () => {
    const r = classifyTurnError("TypeError: cannot read property 'x' of undefined");
    expect(r.transient).toBe(false);
    expect(r.reason).toMatch(/unrecognised/);
  });

  it("treats a missing error message as terminal — silence is not evidence", () => {
    expect(classifyTurnError(undefined).transient).toBe(false);
    expect(classifyTurnError("").transient).toBe(false);
    expect(classifyTurnError("   ").transient).toBe(false);
  });
});

describe("terminal patterns win over transient ones", () => {
  it("does not auto-continue an abort that also mentions a timeout", () => {
    // Both signals present; the deliberate stop must win, or cancelling a
    // hung turn would restart it.
    const r = classifyTurnError("AbortError: stream idle timeout, operation aborted");
    expect(r.transient).toBe(false);
    expect(r.reason).toMatch(/^terminal:/);
  });

  it("does not auto-continue an overflow reported as a 400-style API error", () => {
    expect(
      classifyTurnError("API Error 400: prompt is too long, connection closed").transient,
    ).toBe(false);
  });
});

describe("bounding the loop", () => {
  it("backs off across attempts and never exceeds the last step", () => {
    const d = [0, 1, 2, 3, 99].map(autoContinueDelaySeconds);
    expect(d[0]).toBe(60);
    expect(d[1]).toBe(180);
    expect(d[2]).toBe(420);
    // Beyond the table it clamps rather than returning undefined/NaN — an
    // unattended retry must never schedule at an unbounded or invalid delay.
    expect(d[3]).toBe(420);
    expect(d[4]).toBe(420);
    for (const v of d) expect(Number.isFinite(v) && v >= 60).toBe(true);
  });

  it("caps auto-continues so an outage cannot bill all night", () => {
    expect(MAX_AUTO_CONTINUES).toBe(3);
  });
});

describe("autoContinuePrompt", () => {
  it("tells the model to resume, explicitly NOT to restart", () => {
    const p = autoContinuePrompt("Stream idle timeout", 1);
    expect(p).toMatch(/Pick up exactly where you left off/);
    expect(p).toMatch(/[Dd]o not restart the task/);
    expect(p).toMatch(/may have completed some of its work/);
  });

  it("marks the attempt so an unattended loop is visible in the transcript", () => {
    expect(autoContinuePrompt("boom", 2)).toContain(`[auto-continue 2/${MAX_AUTO_CONTINUES}]`);
  });

  it("truncates a huge error so the resume prompt stays small", () => {
    const p = autoContinuePrompt("x".repeat(5000), 1);
    expect(p.length).toBeLessThan(700);
  });
});
