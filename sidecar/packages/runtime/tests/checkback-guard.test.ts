import { describe, expect, it } from "vitest";

import {
  buildCheckBackWakeup,
  detectUncoveredCheckBack,
  isCheckBackCovered,
  parseDelaySeconds,
} from "../src/checkback-guard";

// ADR-0055 — the mechanical backstop for unbacked "I'll check back" promises.

describe("detectUncoveredCheckBack", () => {
  it("catches the observed 2026-07-23 failure and parses ~7 minutes → 420s", () => {
    const text =
      "Verified ModularityTests 4/4 green locally, committed as `7fd1a7c6`, " +
      "and pushed. New pipeline `#2701545119` is running — I'll check back in ~7 minutes.";
    const d = detectUncoveredCheckBack(text);
    expect(d).not.toBeNull();
    expect(d!.delaySeconds).toBe(420);
    expect(d!.quote.toLowerCase()).toContain("check back");
  });

  it.each([
    "I'll check back once CI finishes.",
    "Kicking off the deploy — I'll report back when it's done.",
    "I'll keep an eye on the build and let you know.",
    "I'll be monitoring the pipeline.",
    "I'll continue when it reports green.",
    "Check back in a few minutes for the result.",
  ])("flags a check-back promise: %s", (text) => {
    expect(detectUncoveredCheckBack(text)).not.toBeNull();
  });

  it("defaults to 300s when the promise names no time", () => {
    const d = detectUncoveredCheckBack("I'll check back once it's done.");
    expect(d?.delaySeconds).toBe(300);
  });

  it.each([
    "Done — ModularityTests are 4/4 green and pushed. Anything else?",
    "You could check back later if you want, but it's already merged.",
    "The build takes about 7 minutes to run in CI.",
    "I checked the logs and fixed the missing import.",
    "",
  ])("does NOT trip on non-promise text: %s", (text) => {
    expect(detectUncoveredCheckBack(text)).toBeNull();
  });

  it("clamps a named delay into the scheduler window", () => {
    expect(detectUncoveredCheckBack("I'll check back in 30 seconds.")?.delaySeconds).toBe(60);
    expect(detectUncoveredCheckBack("I'll check back in 48 hours.")?.delaySeconds).toBe(86_400);
  });
});

describe("parseDelaySeconds", () => {
  it("parses units", () => {
    expect(parseDelaySeconds("~7 minutes")).toBe(420);
    expect(parseDelaySeconds("in 2 hours")).toBe(7200);
    expect(parseDelaySeconds("90 seconds")).toBe(90);
    expect(parseDelaySeconds("in 3 min")).toBe(180);
  });
  it("returns null when no duration is present", () => {
    expect(parseDelaySeconds("once it's done")).toBeNull();
  });
});

describe("buildCheckBackWakeup", () => {
  it("quotes the promise and tells the fired turn to follow through, not re-promise", () => {
    const { reason, prompt } = buildCheckBackWakeup({
      quote: "I'll check back in ~7 minutes",
      delaySeconds: 420,
      hasExplicitDelay: true,
    });
    expect(reason).toMatch(/ADR-0055/);
    expect(prompt).toContain("I'll check back in ~7 minutes");
    expect(prompt).toMatch(/do not simply\s+re-promise/i);
  });
});

// ── ADR-0055 addendum (2026-08-07) ──────────────────────────────────────────
// Second observed failure, verbatim from the user's screenshot:
//
//   "Steps [5]-[7] landed (…). Dev stack is starting in the background;
//    I'll check readiness and run the Playwright verification in ~2.5 minutes."
//
// The turn ended and nothing followed. TWO independent defects had to be fixed;
// either one alone would have swallowed the promise.

const REAL_2026_08_07 =
  "Steps [5]-[7] landed (TENANT_ADMIN/MANAGER reconcile flows + ACCOUNTANT " +
  "disabled-button check). Dev stack is starting in the background; I'll check " +
  "readiness and run the Playwright verification in ~2.5 minutes.";

describe("detectUncoveredCheckBack — the 2026-08-07 miss", () => {
  it("detects the real sentence and parses ~2.5 minutes → 150s", () => {
    const d = detectUncoveredCheckBack(REAL_2026_08_07);
    expect(d).not.toBeNull();
    expect(d?.delaySeconds).toBe(150);
    expect(d?.hasExplicitDelay).toBe(true);
    expect(d?.quote).toContain("Playwright verification");
  });

  it("matches a promise too WORDY for the old 40-char gap", () => {
    // The clause between "I'll" and "in" is 51 chars. A promise is not less
    // binding for being verbose.
    expect(
      detectUncoveredCheckBack("I'll check readiness and run the Playwright verification in ~2 minutes."),
    ).not.toBeNull();
  });

  it("matches a DECIMAL duration, which the promise pattern used to reject", () => {
    // parseDelaySeconds always handled decimals; the promise regex did not, so
    // the delay was parseable while the promise itself was invisible.
    expect(detectUncoveredCheckBack("I'll verify in ~1.5 hours.")?.delaySeconds).toBe(5400);
  });

  it("matches follow-through verbs a coding session actually uses", () => {
    for (const t of [
      "I'll re-run the suite once the stack is up.",
      "I'll verify the flows after the build finishes.",
      "I'll confirm the fix when CI goes green.",
      "I'll kick off the e2e run once the server is listening.",
    ]) {
      expect(detectUncoveredCheckBack(t), t).not.toBeNull();
    }
  });

  it("still ignores a bare mention that promises nothing", () => {
    expect(detectUncoveredCheckBack("You could check back later if you want.")).toBeNull();
    expect(detectUncoveredCheckBack("The pipeline takes about 7 minutes to run.")).toBeNull();
  });
});

describe("isCheckBackCovered — a background job is not a clock", () => {
  const timed = detectUncoveredCheckBack(REAL_2026_08_07)!;
  const openEnded = detectUncoveredCheckBack("I'll continue once the build finishes.")!;

  it("THE REGRESSION: a background job does NOT cover a timed promise", () => {
    // The dev stack was started with run_background_job — a server that never
    // exits, so ADR-0038's completion turn can never fire. Treating that as
    // coverage is exactly why the user waited and nothing came.
    expect(isCheckBackCovered(timed, { scheduleWakeup: false, backgroundJob: true })).toBe(false);
  });

  it("a background job DOES cover an open-ended promise", () => {
    expect(openEnded.hasExplicitDelay).toBe(false);
    expect(isCheckBackCovered(openEnded, { scheduleWakeup: false, backgroundJob: true })).toBe(true);
  });

  it("a scheduled wakeup covers either kind", () => {
    expect(isCheckBackCovered(timed, { scheduleWakeup: true, backgroundJob: false })).toBe(true);
    expect(isCheckBackCovered(openEnded, { scheduleWakeup: true, backgroundJob: false })).toBe(true);
  });

  it("nothing armed covers nothing", () => {
    expect(isCheckBackCovered(timed, { scheduleWakeup: false, backgroundJob: false })).toBe(false);
    expect(isCheckBackCovered(openEnded, { scheduleWakeup: false, backgroundJob: false })).toBe(false);
  });
});

// ── The 2026-08-22 miss: "I'll act on its real completion output" ──────────
// A backup finished at 17:17; MARVIN promised to act on completion; the turn
// ended at 17:22; the user chased it at 22:02. The backstop exists to arm a
// wakeup when a promise has no watcher, and it saw nothing — "act" was not a
// follow-through verb, and the sentence carries no when/once/after/in cue.
describe("check-back detection — completion-referencing promises", () => {
  it("catches the exact sentence that was missed", () => {
    const real =
      "It's running as tracked background task b8ey1tvp0; " +
      "I'll act on its real completion output rather than guess.";
    expect(detectUncoveredCheckBack(real)).not.toBeNull();
  });

  it("catches the same promise with a temporal cue", () => {
    expect(detectUncoveredCheckBack("I'll act on the result when it finishes.")).not.toBeNull();
    expect(detectUncoveredCheckBack("I'll respond once the job exits.")).not.toBeNull();
    expect(detectUncoveredCheckBack("I'll handle it on completion.")).not.toBeNull();
  });

  it("does NOT fire on completion words without a first-person promise", () => {
    // False positives arm spurious wakeups, so the negative edge matters as
    // much as the positive one.
    for (const t of [
      "The job completes in about an hour.",
      "You could check the completion output yourself.",
      "I acted on the completion output already.",
      "Completion is expected shortly.",
    ]) {
      expect(detectUncoveredCheckBack(t), t).toBeNull();
    }
  });
});

// ── The 2026-08-23 miss: a FALSE CLAIM of coverage ─────────────────────────
// MARVIN called the harness's foreign `ScheduleWakeup` (not its own
// `schedule_wakeup`), which armed nothing, then told the user it had
// "scheduled a check in ~2 minutes". Every prior pattern required a
// future-tense "I'll", so a sentence asserting the watcher ALREADY EXISTS —
// a stronger and more misleading claim — was invisible.
describe("check-back detection — past-tense claims of having armed a watcher", () => {
  it("catches the exact sentence that was missed", () => {
    const real =
      "Restarted the stale dev API in the background and scheduled a check " +
      "in ~2 minutes before re-running the Playwright spec.";
    expect(detectUncoveredCheckBack(real)).not.toBeNull();
  });

  it("catches the same claim in other phrasings", () => {
    for (const t of [
      "I scheduled a check in ~2 minutes.",
      "armed a wakeup for 5 minutes",
      "set up a recheck after the build",
    ]) {
      expect(detectUncoveredCheckBack(t), t).not.toBeNull();
    }
  });

  it("does NOT fire on scheduling talk that is not a self-claimed watcher", () => {
    for (const t of [
      "The user scheduled a meeting in the morning.",
      "I scheduled the backup to run nightly.",
      "A check was already scheduled by the runtime.",
      "scheduled maintenance in production",
    ]) {
      expect(detectUncoveredCheckBack(t), t).toBeNull();
    }
  });
});
