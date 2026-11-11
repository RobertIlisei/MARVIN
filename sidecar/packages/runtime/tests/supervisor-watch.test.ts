import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { buildSessionWatch } from "../src/session-watch";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "../src/supervisor-state";
import { markTurnTouched, resetTouchesForTests } from "../src/supervisor-touch";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";
import { __resetSchedulerForTests, scheduleWakeup } from "../src/wakeup-scheduler";

// Design brief §10.4 — the watch row carries what the delegation chip and the
// tab rows read: delegation, the shared checkout, the touched turn, what the
// tab waits on of its own, and whether the user stopped it. And the live
// turn's author (§10.7).

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const POSTURE = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sw-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sw-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  resetTouchesForTests();
  bootSupervisor();
  upsertSessionMeta("proj", "tab-w", { workDir, tree: { mode: "shared" }, posture: POSTURE });
});
afterEach(() => {
  __resetSchedulerForTests();
  resetSupervisorStateForTests();
  resetTouchesForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const row = async () => (await buildSessionWatch({ projectId: "proj", workDir, sessionIds: ["tab-w"], fresh: true }))[0];

describe("the watch row's `supervisor` object (brief §10.4)", () => {
  it("an undelegated, quiet tab", async () => {
    expect((await row())?.supervisor).toEqual({ delegation: "off", sharedCheckout: true, touchedTurn: null, waitingOnOwn: null, stoppedByUser: false, lastActAt: null, openEscalations: 0 });
  });

  it("carries the delegation, the touched turn, a pending wakeup of its own, and a user stop", async () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, currentSupervisorToken());
    applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-w", level: "answer-questions" }, currentSupervisorToken());
    const touched = markTurnTouched({ projectId: "proj", marvinSessionId: "tab-w", turnId: "turn-1", by: "answer" });
    scheduleWakeup({ marvinSessionId: "tab-w", projectId: "proj", cwd: workDir, workDir, model: POSTURE.model, advisorModel: null, personality: "ultron", permissionStrategy: "auto", thinkingMode: "high", delaySeconds: 600, schedulingDepth: 0, prompt: "check", reason: "build" });
    updateSessionMeta("proj", "tab-w", { lastTurn: { turnId: "turn-1", startedAt: new Date().toISOString(), outcome: "stopped" } });
    expect((await row())?.supervisor).toEqual({ delegation: "answer-questions", sharedCheckout: true, touchedTurn: touched, waitingOnOwn: "wakeup", stoppedByUser: true, lastActAt: null, openEscalations: 0 });
  });

  // ADR-0130 — the row says what the tab waits on, and whether it closed scope-met.
  it("a pending wakeup reads waiting, with its reason and creation time; the marker stays null", async () => {
    const res = scheduleWakeup({ marvinSessionId: "tab-w", projectId: "proj", cwd: workDir, workDir, model: POSTURE.model, advisorModel: null, personality: "ultron", permissionStrategy: "auto", thinkingMode: "high", delaySeconds: 600, schedulingDepth: 0, prompt: "check", reason: "build" });
    if (!res.ok) throw new Error(res.error);
    updateSessionMeta("proj", "tab-w", { lastTurn: { turnId: "turn-1", startedAt: new Date().toISOString(), outcome: "completed" } });
    const r = await row();
    expect(r?.state).toBe("waiting");
    expect(r?.waitingOn).toEqual({ kind: "wakeup", label: "build", since: res.record.createdAt });
    expect(r?.lastTurn?.marker).toBeNull();
  });

  it("scopeMetAt reads done and marks the last turn scope-met", async () => {
    updateSessionMeta("proj", "tab-w", { lastTurn: { turnId: "turn-1", startedAt: new Date().toISOString(), outcome: "completed" }, scopeMetAt: new Date().toISOString() });
    const r = await row();
    expect(r?.state).toBe("done");
    expect(r?.waitingOn).toBeNull();
    expect(r?.lastTurn?.marker).toBe("scope-met");
  });

  it("a pending job reads waiting, labelled by its reason or the first 60 characters of its command", async () => {
    const { __resetBackgroundJobsForTests, __setJobsFileForTests, cancelBackgroundJob, startBackgroundJob } = await import("../src/background-jobs");
    __setJobsFileForTests(path.join(dataDir, "background-jobs.json"));
    const ctx = { marvinSessionId: "tab-w", projectId: "proj", cwd: workDir, model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "high", depth: 0 };
    try {
      const withReason = startBackgroundJob({ command: "sleep 30", reason: "long build", ctx });
      if (!withReason.ok) throw new Error(withReason.error);
      expect((await row())?.waitingOn).toMatchObject({ kind: "job", label: "long build", since: expect.any(String) });
      const command = `sleep 30 # ${"x".repeat(80)}`;
      const noReason = startBackgroundJob({ command, reason: "", ctx: { ...ctx, marvinSessionId: "tab-j2" } });
      if (!noReason.ok) throw new Error(noReason.error);
      const other = (await buildSessionWatch({ projectId: "proj", workDir, sessionIds: ["tab-j2"] }))[0];
      expect(other?.waitingOn?.label).toBe(command.slice(0, 60));
      cancelBackgroundJob(withReason.id);
      cancelBackgroundJob(noReason.id);
    } finally {
      __resetBackgroundJobsForTests();
      __setJobsFileForTests(null);
    }
  });

  it("the live turn row names a supervisor author", async () => {
    const t = registerLiveTurn({ turnId: "turn-s", marvinSessionId: "tab-w", projectId: "proj", kind: "machine", author: "supervisor" });
    expect((await row())?.turn).toMatchObject({ turnId: "turn-s", kind: "machine", author: "supervisor" });
    endLiveTurn(t, { event: "turn.completed", data: {} });
  });
});

describe("pending confirms on the row say which only the user may answer", () => {
  it("a containment confirm in a touched turn reads userOnly; a question does not", async () => {
    const { registerPendingConfirm, clearTurnConfirms } = await import("../src/confirm-registry");
    const t = registerLiveTurn({ turnId: "turn-p", marvinSessionId: "tab-w", projectId: "proj" });
    registerPendingConfirm("turn-p", "c1", () => {}, { command: "git checkout main" }, 0, { toolName: "Bash", raisedBy: "shared-tree" });
    registerPendingConfirm("turn-p", "q1", () => {}, { questions: [] }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    markTurnTouched({ projectId: "proj", marvinSessionId: "tab-w", turnId: "turn-p", by: "answer" });
    const pending = (await row())?.pending ?? [];
    expect(pending.find((p) => p.toolUseId === "c1")?.userOnly).toBe(true);
    expect(pending.find((p) => p.toolUseId === "q1")?.userOnly).toBe(false);
    clearTurnConfirms("turn-p");
    endLiveTurn(t, { event: "turn.completed", data: {} });
  });
});

describe("a supervisor message that stays queued too long is ledgered as dropped (ADR-0127 §6)", () => {
  it("deferral exhaustion writes a `drop` line, not just a console warning", async () => {
    const { deferIfSessionBusy, MAX_FIRE_DEFERRALS } = await import("../src/wakeup-scheduler");
    const { readLedger } = await import("../src/supervisor-ledger");
    const t = registerLiveTurn({ turnId: "turn-busy", marvinSessionId: "tab-w", projectId: "proj" });
    const dropped = deferIfSessionBusy({
      id: "w-sup", marvinSessionId: "tab-w", projectId: "proj", cwd: workDir, workDir, model: POSTURE.model, advisorModel: null, personality: "ultron",
      permissionStrategy: "auto", thinkingMode: "high", prompt: "[Message from the MARVIN supervisor — not from the user]", reason: "supervisor nudge",
      createdAt: new Date().toISOString(), fireAt: Date.now(), depth: 0, deferrals: MAX_FIRE_DEFERRALS, author: "supervisor",
    });
    expect(dropped).toBe(true);
    expect(readLedger("proj").at(-1)).toMatchObject({ verb: "send", decision: "drop", reasonCode: "deferral-exhausted", tab: "tab-w" });
    endLiveTurn(t, { event: "turn.completed", data: {} });
  });
});

describe("readers of the transcript keep the supervisor's words apart from the user's", () => {
  it("the supervisor's own tail labels its messages, and the brief is the user's first message, never the supervisor's", async () => {
    const { appendSessionTurn } = await import("../src/session");
    const { defaultVerbDeps } = await import("../src/supervisor-loop");
    appendSessionTurn("proj", "tab-b", { type: "turn.user", at: new Date().toISOString(), message: "[Message from the MARVIN supervisor — not from the user]\nrun the tests", author: "supervisor" });
    appendSessionTurn("proj", "tab-b", { type: "turn.user", at: new Date().toISOString(), message: "Build the billing page." });
    const deps = defaultVerbDeps("proj", workDir);
    expect(deps.readBrief("tab-b")).toBe("Build the billing page.");
    const tail = deps.readTranscriptTail("tab-b");
    expect(tail).toMatch(/^supervisor \(you, earlier/m);
    expect(tail).toMatch(/^user: Build the billing page\./m);
  });

  it("the practice loop counts a supervisor-started turn as a machine turn", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(path.join(__dirname, "../src/practice-extractors.ts"), "utf8");
    expect(src).toMatch(/machine: \/\^\\\[\(scheduled wakeup\|queued \|\\d\+ messages queued\|Message from the MARVIN supervisor\)\//);
  });
});
