import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0127 §5 — a supervisor message enters a tab through the server-side
// send path: tagged at the source (transcript, turn registry, watch row),
// wrapped in an envelope, never injected into or preempting a live turn, and
// the turn it starts is supervisor-touched. Integration through the real
// orchestrator; only the SDK turn (`runAgent`) is stubbed.

type RunInput = Record<string, unknown>;
let captured: RunInput[];
let onRun: ((input: RunInput) => void) | null;
let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;

const POSTURE = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };
const GROUNDS = [{ kind: "plan" as const, ref: "3", provenance: "strong" as const }];

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-send-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-send-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  captured = [];
  onRun = null;
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return {
      ...orig,
      runAgent: async (input: RunInput) => {
        captured.push(input);
        onRun?.(input);
        return { ok: true, costUsd: 0.25 };
      },
    };
  });
});
afterEach(async () => {
  const { __resetSchedulerForTests } = await import("@marvin/runtime/wakeup-scheduler");
  __resetSchedulerForTests();
  vi.doUnmock("@marvin/runtime/sdk-runner");
  vi.resetModules();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

async function setup(tree: { mode: "shared" } = { mode: "shared" }) {
  const meta = await import("@marvin/runtime/session-meta");
  meta.upsertSessionMeta("proj", "tab-s", { workDir, tree, posture: POSTURE });
  await import("../src/lib/turn-orchestrator"); // wires the fire handler
  const send = await import("@marvin/runtime/supervisor-send");
  return { meta, send };
}

const message = { projectId: "proj", marvinSessionId: "tab-s", text: "Step 3 is still open — run the failing test and fix it.", kind: "nudge" as const, grounds: GROUNDS, ledgerId: "L-7" };

describe("sendAsSupervisor — an idle tab", () => {
  it("starts one turn, authored by the supervisor in the transcript, the registry and the turn record, inside the envelope", async () => {
    const { send } = await setup();
    const { getLiveTurn } = await import("@marvin/runtime/turn-registry");
    let liveAuthor: unknown;
    onRun = () => {
      liveAuthor = getLiveTurn("tab-s")?.author;
    };
    const r = await send.sendAsSupervisor(message);
    expect(r).toMatchObject({ ok: true });
    expect(captured).toHaveLength(1);
    const prompt = String(captured[0]?.message);
    expect(prompt).toMatch(/supervisor/i);
    expect(prompt).toMatch(/not from the user/i);
    expect(prompt).toContain(message.text);
    expect(prompt).not.toMatch(/^\[scheduled wakeup/);
    expect(liveAuthor).toBe("supervisor");

    const { loadSession } = await import("@marvin/runtime/session");
    const turns = loadSession("proj", "tab-s")?.turns ?? [];
    expect(turns.find((t) => t.type === "turn.user")).toMatchObject({ author: "supervisor", supervisor: { kind: "nudge", ledgerId: "L-7", grounds: GROUNDS } });
    expect(turns.find((t) => t.type === "turn.started")).toMatchObject({ author: "supervisor", mode: "agent" });
  });

  it("the turn it starts is supervisor-touched", async () => {
    const { send, meta } = await setup();
    const { isTurnTouched } = await import("@marvin/runtime/supervisor-touch");
    let touched = false;
    onRun = (input) => {
      touched = isTurnTouched(String(input.turnId));
    };
    await send.sendAsSupervisor(message);
    expect(touched).toBe(true);
    expect(meta.readSessionMeta("proj", "tab-s")?.supervisorTouched?.by).toBe("message");
  });

  it("runs in the tab's mode — an Ask tab stays Ask", async () => {
    const { send, meta } = await setup();
    meta.upsertSessionMeta("proj", "tab-s", { workDir, tree: { mode: "shared" }, posture: POSTURE }, { posture: { ...POSTURE, mode: "ask" } });
    await send.sendAsSupervisor(message);
    expect(captured[0]).toMatchObject({ mode: "ask" });
  });
});

describe("sendAsSupervisor — never talks over the user", () => {
  it("a tab with a live turn: nothing is injected, no turn starts; the message waits", async () => {
    const { send } = await setup();
    const { registerLiveTurn, endLiveTurn } = await import("@marvin/runtime/turn-registry");
    const live = registerLiveTurn({ turnId: "turn-user", marvinSessionId: "tab-s", projectId: "proj" });
    const inject = vi.fn(() => true);
    live.inject = inject;
    const r = await send.sendAsSupervisor(message);
    expect(r).toMatchObject({ ok: true, queued: true });
    expect(inject).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    const { listWakeups } = await import("@marvin/runtime/wakeup-scheduler");
    expect(listWakeups({ marvinSessionId: "tab-s" })).toEqual([expect.objectContaining({ author: "supervisor" })]);
    endLiveTurn(live, { event: "turn.completed", data: {} });
  });
});

describe("sendAsSupervisor — refused where it should be", () => {
  it("a tab the user stopped", async () => {
    const { send, meta } = await setup();
    meta.updateSessionMeta("proj", "tab-s", { lastTurn: { turnId: "t0", startedAt: new Date().toISOString(), outcome: "stopped" } });
    expect(await send.sendAsSupervisor(message)).toMatchObject({ ok: false, code: "stopped" });
    expect(captured).toHaveLength(0);
  });

  it("a tab waiting on its own wakeup", async () => {
    const { send } = await setup();
    const { scheduleWakeup } = await import("@marvin/runtime/wakeup-scheduler");
    scheduleWakeup({ marvinSessionId: "tab-s", projectId: "proj", cwd: workDir, workDir, model: POSTURE.model, advisorModel: null, personality: "ultron", permissionStrategy: "auto", thinkingMode: "high", delaySeconds: 600, schedulingDepth: 0, prompt: "check the build", reason: "build" });
    expect(await send.sendAsSupervisor(message)).toMatchObject({ ok: false, code: "waiting-on-own" });
  });

  it("a shared-checkout tab while another session's turn runs in the shared checkout", async () => {
    const { send, meta } = await setup();
    meta.upsertSessionMeta("proj", "tab-other", { workDir, tree: { mode: "shared" }, posture: POSTURE });
    const { registerLiveTurn, endLiveTurn } = await import("@marvin/runtime/turn-registry");
    const other = registerLiveTurn({ turnId: "turn-other", marvinSessionId: "tab-other", projectId: "proj" });
    expect(await send.sendAsSupervisor(message)).toMatchObject({ ok: false, code: "shared-busy" });
    endLiveTurn(other, { event: "turn.completed", data: {} });
  });

  it("a message carrying a secret-shaped string", async () => {
    const { send } = await setup();
    expect(await send.sendAsSupervisor({ ...message, text: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for the call" })).toMatchObject({ ok: false, code: "secret" });
  });

  it("a supervisor session is never a target", async () => {
    const { send } = await setup();
    const state = await import("@marvin/runtime/supervisor-state");
    state.resetSupervisorStateForTests();
    state.bootSupervisor();
    const r = state.applySupervisorAction({ projectId: "proj", action: "start" }, state.currentSupervisorToken());
    const sup = r.ok ? r.state.supervisorSessionId : null;
    expect(await send.sendAsSupervisor({ ...message, marvinSessionId: String(sup) })).toMatchObject({ ok: false, code: "supervisor-session" });
  });
});

describe("a queued supervisor message is checked again when it fires", () => {
  it("the user stopped the tab meanwhile: dropped, and the ledger says so", async () => {
    const { send, meta } = await setup();
    const { registerLiveTurn, endLiveTurn } = await import("@marvin/runtime/turn-registry");
    const live = registerLiveTurn({ turnId: "turn-user", marvinSessionId: "tab-s", projectId: "proj" });
    await send.sendAsSupervisor(message);
    endLiveTurn(live, { event: "turn.completed", data: {} });
    meta.updateSessionMeta("proj", "tab-s", { lastTurn: { turnId: "turn-user", startedAt: new Date().toISOString(), outcome: "stopped" } });
    const { listWakeups } = await import("@marvin/runtime/wakeup-scheduler");
    const [queued] = listWakeups({ marvinSessionId: "tab-s" });
    const { startScheduledTurn } = await import("../src/lib/turn-orchestrator");
    await startScheduledTurn(queued!);
    expect(captured).toHaveLength(0);
    const { readLedger } = await import("@marvin/runtime/supervisor-ledger");
    expect(readLedger("proj").at(-1)).toMatchObject({ verb: "send", decision: "drop", reasonCode: "stopped", tab: "tab-s" });
  });
});

describe("a resume after a restart keeps a touched turn touched", () => {
  it("the resumed turn of a touched, interrupted turn is touched", async () => {
    const { meta } = await setup();
    const { isTurnTouched, markTurnTouched, resetTouchesForTests } = await import("@marvin/runtime/supervisor-touch");
    markTurnTouched({ projectId: "proj", marvinSessionId: "tab-s", turnId: "turn-cut", by: "message" });
    meta.updateSessionMeta("proj", "tab-s", { lastTurn: { turnId: "turn-cut", startedAt: new Date().toISOString(), outcome: "interrupted" } });
    resetTouchesForTests(); // the restart
    let touched = false;
    onRun = (input) => {
      touched = isTurnTouched(String(input.turnId));
    };
    const { resumeSession } = await import("@marvin/runtime/session-recovery");
    await resumeSession("proj", "tab-s");
    expect(captured).toHaveLength(1);
    expect(touched).toBe(true);
  });
});

describe("spend: a supervisor-started tab turn counts against the supervisor's cap", () => {
  it("adds the turn's cost to the tabs' share; at the cap the supervisor pauses with reason budget and escalates", async () => {
    const { send } = await setup();
    const state = await import("@marvin/runtime/supervisor-state");
    state.resetSupervisorStateForTests();
    state.bootSupervisor();
    const token = state.currentSupervisorToken();
    state.applySupervisorAction({ projectId: "proj", action: "start" }, token);
    state.setSupervisorCapsForTests("proj", { dailyBudgetUsd: 0.2 });
    await send.sendAsSupervisor(message);
    const st = state.getSupervisorState("proj");
    expect(st.spend.tabsUsd).toBeCloseTo(0.25);
    expect(st.spend.usd).toBeCloseTo(0.25);
    expect(st.paused).toBe(true);
    expect(st.pause).toMatchObject({ reason: "budget" });
    const { readLedger } = await import("@marvin/runtime/supervisor-ledger");
    expect(readLedger("proj").at(-1)).toMatchObject({ decision: "escalate", reasonCode: "budget" });
  });

  it("a user's turn costs the supervisor nothing", async () => {
    const { send: _send } = await setup();
    const state = await import("@marvin/runtime/supervisor-state");
    state.resetSupervisorStateForTests();
    state.bootSupervisor();
    state.applySupervisorAction({ projectId: "proj", action: "start" }, state.currentSupervisorToken());
    const { startScheduledTurn } = await import("../src/lib/turn-orchestrator");
    const { buildResumeRecord } = await import("@marvin/runtime/session-recovery");
    const { readSessionMeta } = await import("@marvin/runtime/session-meta");
    await startScheduledTurn(buildResumeRecord(readSessionMeta("proj", "tab-s")!, { prompt: "go on" }));
    expect(state.getSupervisorState("proj").spend.tabsUsd ?? 0).toBe(0);
  });
});

describe("POST /api/chat with author: supervisor — the same path, token required", () => {
  async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../src/app/api/chat/route");
    return POST(
      new NextRequest("http://localhost:3030/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-marvin-client": "1", ...headers },
        body: JSON.stringify(body),
      }),
    );
  }
  async function token() {
    const state = await import("@marvin/runtime/supervisor-state");
    state.resetSupervisorStateForTests();
    state.bootSupervisor();
    return { "x-marvin-supervisor-token": state.currentSupervisorToken() as string };
  }
  const body = { author: "supervisor", message: "Run the failing test.", projectId: "proj", marvinSessionId: "tab-s", cwd: "", supervisor: { kind: "instruction", grounds: [{ kind: "charter", ref: "tests first" }] } };

  it("without the token it is refused, and nothing starts", async () => {
    await setup();
    await token();
    const r = await post({ ...body, cwd: workDir });
    expect(r.status).toBe(403);
    expect(captured).toHaveLength(0);
  });

  it("with the token it starts one turn authored by the supervisor, exactly as the send path does", async () => {
    await setup();
    const r = await post({ ...body, cwd: workDir }, await token());
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, queued: false });
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.message)).toMatch(/^\[Message from the MARVIN supervisor/);
    const { loadSession } = await import("@marvin/runtime/session");
    expect(loadSession("proj", "tab-s")?.turns.find((t) => t.type === "turn.user")).toMatchObject({
      author: "supervisor",
      supervisor: { kind: "instruction", grounds: [{ kind: "charter", ref: "tests first", provenance: "unresolved" }] },
    });
  });

  it("refusals answer 409 with the reason — a stopped tab", async () => {
    const { meta } = await setup();
    meta.updateSessionMeta("proj", "tab-s", { lastTurn: { turnId: "t0", startedAt: new Date().toISOString(), outcome: "stopped" } });
    const r = await post({ ...body, cwd: workDir }, await token());
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "stopped" });
  });

  it("an author that is neither user nor supervisor is a 400", async () => {
    await setup();
    expect((await post({ ...body, cwd: workDir, author: "auditor" }, await token())).status).toBe(400);
  });

  it("a user message during a supervisor-started turn preempts it (ADR-0069)", async () => {
    await setup();
    const { addProject } = await import("@marvin/runtime/projects");
    addProject({ workDir }); // the chat route runs a user turn only in a registered project
    const { registerLiveTurn } = await import("@marvin/runtime/turn-registry");
    const sup = registerLiveTurn({ turnId: "turn-sup", marvinSessionId: "tab-s", projectId: "proj", kind: "machine", author: "supervisor" });
    const r = await post({ message: "stop that, do this instead", cwd: workDir, projectId: "proj", marvinSessionId: "tab-s" });
    expect(sup.abortController.signal.aborted).toBe(true);
    expect(r.status).not.toBe(409);
  });
});
