import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { clearTurnConfirms, registerPendingConfirm } from "@marvin/runtime/confirm-registry";
import { addProject } from "@marvin/runtime/projects";
import { upsertSessionMeta } from "@marvin/runtime/session-meta";
import { appendLedgerEntry, readLedger } from "@marvin/runtime/supervisor-ledger";
import { defaultLoopDeps, SupervisorLoop } from "@marvin/runtime/supervisor-loop";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  noteSupervisorTabSpend,
  resetSupervisorStateForTests,
} from "@marvin/runtime/supervisor-state";
import { STATUS_FIELDS } from "@marvin/runtime/supervisor-status";
import { endLiveTurn, registerLiveTurn } from "@marvin/runtime/turn-registry";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as answerPOST } from "../src/app/api/confirm/answer/route";
import { POST as revealPOST } from "../src/app/api/supervisor/reveal/route";
import { GET, POST } from "../src/app/api/supervisor/route";
import { GET as statsGET } from "../src/app/api/supervisor/stats/route";
import { GET as watchGET } from "../src/app/api/sessions/watch/route";

// ADR-0127 milestone 4, across the route boundary: GET /api/supervisor is
// `{state, status}` with every §10.1 field for an idle, a waking, a
// paused-by-budget and a stale fixture; the §10.1 mutations; the stats route;
// and the watch row's shadow proposal — hidden until revealed, the reveal then
// recorded on the pairing when the user answers.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const URL_BASE = "http://localhost:3030";
const token = () => currentSupervisorToken() as string;
const G = globalThis as typeof globalThis & { __marvinSupervisorLoop?: SupervisorLoop };
const realLoop = G.__marvinSupervisorLoop;
const POSTURE = { model: "claude-opus-5-5", advisorModel: null, thinkingMode: "high", permissionStrategy: "auto" as const, mode: "agent" as const, personality: "marvin" as const };
const QUESTION = { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4r-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-m4r-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: "proj", action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
});
afterEach(() => {
  G.__marvinSupervisorLoop = realLoop;
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const get = (url: string) => new NextRequest(`${URL_BASE}${url}`, { headers: { "x-marvin-supervisor-token": token() } });
const post = (url: string, body: unknown) =>
  new NextRequest(`${URL_BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-marvin-client": "1", "x-marvin-supervisor-token": token() },
    body: JSON.stringify(body),
  });
async function status(): Promise<Record<string, unknown>> {
  const r = await GET(get("/api/supervisor?projectId=proj"));
  expect(r.status).toBe(200);
  const j = (await r.json()) as { state: unknown; status: Record<string, unknown> };
  expect(j.state).toBeTruthy();
  for (const f of STATUS_FIELDS) expect(j.status, f).toHaveProperty(f);
  return j.status;
}
function fakeLoop(snapshot: ReturnType<SupervisorLoop["snapshot"]>) {
  G.__marvinSupervisorLoop = { snapshot: () => snapshot } as unknown as SupervisorLoop;
}

describe("GET /api/supervisor → { state, status }", () => {
  it("idle", async () => {
    fakeLoop({ currentWake: null, queuedEvents: 0, oldestQueuedAt: null });
    const s = await status();
    expect(s).toMatchObject({ run: "idle", health: "ok", mode: "shadow", watchedTabs: 1, openEscalations: 0 });
  });

  it("waking", async () => {
    fakeLoop({ currentWake: { wakeId: "w1", startedAt: new Date().toISOString(), itemCount: 3 }, queuedEvents: 2, oldestQueuedAt: Date.now() });
    const s = await status();
    expect(s).toMatchObject({ run: "waking", currentWake: { itemCount: 3 }, queuedEvents: 2 });
  });

  it("paused by budget", async () => {
    fakeLoop({ currentWake: null, queuedEvents: 0, oldestQueuedAt: null });
    applySupervisorAction({ projectId: "proj", action: "cap", capUsd: 1 }, token());
    noteSupervisorTabSpend("proj", 1.5);
    const s = await status();
    expect(s).toMatchObject({ run: "paused", pause: { reason: "budget" }, budget: { level: "reached", capUsd: 1 } });
  });

  it("stale", async () => {
    fakeLoop({ currentWake: null, queuedEvents: 4, oldestQueuedAt: Date.now() - 30 * 60_000 });
    const s = await status();
    expect(s.health).toBe("stale");
  });

  it("refuses a request without the token", async () => {
    const r = await GET(new NextRequest(`${URL_BASE}/api/supervisor?projectId=proj`));
    expect(r.status).toBe(403);
  });
});

describe("POST /api/supervisor — the §10.1 mutations", () => {
  it("autonomy, cap and disable return the new state with a higher revision", async () => {
    const r1 = await POST(post("/api/supervisor", { projectId: "proj", action: "autonomy", category: "questions", value: "autonomous" }));
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { state: { revision: number; mode: string }; status: { autonomy: Record<string, string> } };
    expect(j1.state.mode).toBe("autonomous");
    expect(j1.status.autonomy.questions).toBe("autonomous");
    const r2 = await POST(post("/api/supervisor", { projectId: "proj", action: "cap", capUsd: 3 }));
    const j2 = (await r2.json()) as { state: { revision: number } };
    expect(j2.state.revision).toBeGreaterThan(j1.state.revision);
    const r3 = await POST(post("/api/supervisor", { projectId: "proj", action: "autonomy", category: "confirms", value: "autonomous" }));
    expect(r3.status).toBe(409);
    const r4 = await POST(post("/api/supervisor", { projectId: "proj", action: "disable" }));
    expect(((await r4.json()) as { state: { mode: string } }).state.mode).toBe("off");
  });
});

describe("the watch row's shadow proposal, reveal and pairing — end to end", () => {
  it("hidden until revealed; the user's answer then pairs it with proposalSeenBeforeAnswer", async () => {
    // A loop of its own on this module graph: with `isolate: false` the global one may be
    // subscribed to another file's (reset) event bus. It pairs on confirm.resolved.
    const own = new SupervisorLoop(defaultLoopDeps());
    own.start();
    G.__marvinSupervisorLoop = own;
    const project = addProject({ name: "p", workDir });
    applySupervisorAction({ projectId: project.id, action: "start", delegations: [{ sessionId: "tab-m4-reveal", level: "answer-questions" }] }, token());
    upsertSessionMeta(project.id, "tab-m4-reveal", { workDir, tree: { mode: "shared" }, posture: POSTURE });
    const live = registerLiveTurn({ turnId: "turn-m4-reveal", marvinSessionId: "tab-m4-reveal", projectId: project.id });
    const resolver = vi.fn();
    registerPendingConfirm("turn-m4-reveal", "tu-1", resolver, QUESTION, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
    const proposal = appendLedgerEntry(project.id, {
      kind: "verb", verb: "answer", tab: "tab-m4-reveal", wakeId: "w", mode: "shadow", decision: "propose", reason: "grounded",
      grounds: [{ kind: "charter", ref: "Postgres", provenance: "strong" }], turnId: "turn-m4-reveal", toolUseId: "tu-1", answer: ["Postgres"],
    });

    const row = async () => {
      const r = await watchGET(new NextRequest(`${URL_BASE}/api/sessions/watch?projectId=${project.id}&ids=tab-m4-reveal`));
      const j = (await r.json()) as { rows: Array<{ pending: Array<Record<string, unknown>>; supervisor: Record<string, unknown> }> };
      return j.rows[0];
    };
    const blind = (await row())?.pending[0];
    expect(blind?.proposalRevealed).toBe(false);
    expect(blind?.supervisorProposal).toEqual({ ledgerId: proposal.id, actionId: "answer", grounds: [] });

    const rv = await revealPOST(post("/api/supervisor/reveal", { projectId: project.id, ledgerId: proposal.id }));
    expect(rv.status).toBe(200);
    const seen = (await row())?.pending[0];
    expect(seen?.proposalRevealed).toBe(true);
    expect(seen?.supervisorProposal).toMatchObject({ answer: ["Postgres"] });

    const a = await answerPOST(post("/api/confirm/answer", { marvinSessionId: "tab-m4-reveal", toolUseId: "tu-1", answers: { "Which database?": "Postgres" } }));
    expect(a.status).toBe(200);
    const pairing = readLedger(project.id).find((e) => e.kind === "pairing");
    expect(pairing?.pairing).toEqual({ actualAnswer: ["Postgres"], answeredBy: "user", agreement: "agree", proposalSeenBeforeAnswer: true });

    const st = await statsGET(get(`/api/supervisor/stats?projectId=${project.id}`));
    const stats = (await st.json()) as { stats: { questions: { agreed: number; agreedBlind: number; agreementRate: number } } };
    expect(stats.stats.questions).toMatchObject({ agreed: 1, agreedBlind: 0, agreementRate: 1 });

    endLiveTurn(live, { event: "turn.completed", data: {} });
    clearTurnConfirms("turn-m4-reveal");
    own.stop();
  });

  it("reveal refuses without the token, and for an unknown ledger id", async () => {
    const noToken = await revealPOST(new NextRequest(`${URL_BASE}/api/supervisor/reveal`, { method: "POST", headers: { "content-type": "application/json", "x-marvin-client": "1" }, body: JSON.stringify({ projectId: "proj", ledgerId: "x" }) }));
    expect(noToken.status).toBe(403);
    const unknown = await revealPOST(post("/api/supervisor/reveal", { projectId: "proj", ledgerId: "nope" }));
    expect(unknown.status).toBe(404);
  });
});
