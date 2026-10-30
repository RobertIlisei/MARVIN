import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerQuestion, HEADLESS_QUESTION_FALLBACK, HEADLESS_SUPERVISOR_WAIT_MS, headlessQuestion } from "../src/confirm-answer";
import { clearTurnConfirms, getPendingConfirm, listPendingConfirms } from "../src/confirm-registry";
import { makeAutoModeLogger } from "../src/sdk-runner";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "../src/supervisor-state";
import { resetTouchesForTests } from "../src/supervisor-touch";
import { type ProjectEvent, subscribeProjectEvents } from "../src/turn-registry";

// ADR-0127 milestone 4 — a question from a turn with no UI wired. ADR-0040
// denies it at once with "proceed on your own recommendation". In a tab
// delegated at answer-questions whose supervisor answers questions
// autonomously, it now waits a bounded time for the supervisor, and falls back
// to exactly that deny when the window passes. Everywhere else, unchanged.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const QUESTION = { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] };
const session = { projectId: "proj", marvinSessionId: "tab-1" };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4h-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4h-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({ action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
});
afterEach(() => {
  vi.useRealTimers();
  clearTurnConfirms("turn-h");
  resetTouchesForTests();
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("headless questions", () => {
  it("through the gate with no UI: a delegated tab waits, the supervisor's answer resolves it", async () => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => seen.push(e));
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: "turn-h", checkpoint: session });
    const pending = gate("AskUserQuestion", QUESTION, { toolUseID: "tu-h", signal: new AbortController().signal } as never);
    await Promise.resolve();
    expect(getPendingConfirm("turn-h", "tu-h")?.raisedBy).toBe("ask-user-question");
    // The watch row can show what the tab asked.
    expect(listPendingConfirms("turn-h")[0]?.reason).toBe("MARVIN needs you to choose.");
    // The loop hears it like any other question.
    expect(seen.some((e) => e.event === "confirm.pending" && e.data.toolUseId === "tu-h")).toBe(true);
    off();
    const r = answerQuestion({ turnId: "turn-h", toolUseId: "tu-h", answers: { "Which database?": "Postgres" }, other: {}, answeredBy: "supervisor" });
    expect(r.ok).toBe(true);
    const result = (await pending) as { behavior: string; updatedInput: { answers: Record<string, string> } };
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput.answers["Which database?"]).toMatch(/^Postgres.*supervisor/);
  });

  it("falls back to ADR-0040's proceed-on-your-recommendation deny when the window passes", async () => {
    vi.useFakeTimers();
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    const p = headlessQuestion({ session, turnId: "turn-h", toolUseId: "tu-h", input: QUESTION, waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_001);
    const r = (await p) as { behavior: string; message: string };
    expect(r).toMatchObject({ behavior: "deny", message: HEADLESS_QUESTION_FALLBACK });
    expect(getPendingConfirm("turn-h", "tu-h")).toBeNull();
  });

  it.each([
    ["the questions category is in shadow", () => {}],
    ["the tab is only observed", () => act({ action: "delegate", marvinSessionId: "tab-1", level: "observe" })],
    ["the supervisor is paused", () => (act({ action: "autonomy", category: "questions", value: "autonomous" }), act({ action: "pause" }))],
    ["the supervisor is off", () => act({ action: "disable" })],
  ])("denies at once, exactly as before, when %s", async (_n, setup) => {
    setup();
    const r = (await headlessQuestion({ session, turnId: "turn-h", toolUseId: "tu-h", input: QUESTION })) as { behavior: string; message: string };
    expect(r).toMatchObject({ behavior: "deny", message: HEADLESS_QUESTION_FALLBACK });
    expect(getPendingConfirm("turn-h", "tu-h")).toBeNull();
  });

  it("waits long enough to outlast a wake already running", () => {
    expect(HEADLESS_SUPERVISOR_WAIT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it("a turn with no session identity denies at once", async () => {
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    const gate = makeAutoModeLogger({ cwd: workDir, workDir, turnId: "turn-h" });
    const r = (await gate("AskUserQuestion", QUESTION, { toolUseID: "tu-h", signal: new AbortController().signal } as never)) as { behavior: string };
    expect(r.behavior).toBe("deny");
  });
});
