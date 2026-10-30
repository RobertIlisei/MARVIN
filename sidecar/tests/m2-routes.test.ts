import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "@marvin/runtime/confirm-registry";
import { loadSession } from "@marvin/runtime/session";
import { readSessionMeta, upsertSessionMeta } from "@marvin/runtime/session-meta";
import { bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { endLiveTurn, getLiveTurn, type LiveTurn, registerLiveTurn } from "@marvin/runtime/turn-registry";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as answerPOST } from "../src/app/api/confirm/answer/route";
import { POST as confirmPOST } from "../src/app/api/confirm/route";
import { PUT as posturePUT } from "../src/app/api/sessions/posture/route";

// ADR-0127 milestone 2 — the two API gaps, through their routes.

const BASE = "http://localhost:3030";
const QUESTIONS = [
  { question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] },
  { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "lint" }, { label: "test" }] },
];
const POSTURE = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };

let dataDir: string;
let turn: LiveTurn | null;
const prev = process.env.MARVIN_DATA_DIR;
const resolver = vi.fn();

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-m2-routes-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  resolver.mockReset();
  turn = null;
});
afterEach(() => {
  clearTurnConfirms("turn-r");
  if (turn) endLiveTurn(turn, { event: "turn.completed", data: {} });
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

function json(url: string, method: string, body: unknown, headers: Record<string, string> = { "x-marvin-client": "1" }) {
  return new NextRequest(`${BASE}${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
function liveQuestion() {
  turn = registerLiveTurn({ turnId: "turn-r", marvinSessionId: "tab-r", projectId: "proj" });
  registerPendingConfirm("turn-r", "q1", resolver, { questions: QUESTIONS }, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
}

describe("POST /api/confirm/answer — answer by label", () => {
  it("builds updatedInput exactly as the sheet does and records answeredBy", async () => {
    liveQuestion();
    const r = await answerPOST(json("/api/confirm/answer", "POST", { marvinSessionId: "tab-r", toolUseId: "q1", answers: { "Which checks?": ["test", "lint"] }, other: { "Which database?": " DuckDB " } }));
    expect(r.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({
      behavior: "allow",
      updatedInput: { answers: { "Which database?": "DuckDB", "Which checks?": "lint,test" }, questions: QUESTIONS },
    });
    const decision = loadSession("proj", "tab-r")?.turns.find((t) => t.type === "confirm.decision");
    expect(decision).toMatchObject({ decision: "allow", answeredBy: "user" });
  });

  it("an unknown label answers 400 listing the valid ones, and nothing resolves", async () => {
    liveQuestion();
    const r = await answerPOST(json("/api/confirm/answer", "POST", { marvinSessionId: "tab-r", toolUseId: "q1", answers: { "Which database?": "MongoDB" } }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/Postgres, SQLite/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("an already-answered question answers 409", async () => {
    liveQuestion();
    const body = { marvinSessionId: "tab-r", toolUseId: "q1", answers: { "Which database?": "Postgres" } };
    expect((await answerPOST(json("/api/confirm/answer", "POST", body))).status).toBe(200);
    expect((await answerPOST(json("/api/confirm/answer", "POST", body))).status).toBe(409);
  });

  it("a turnId that disagrees with the session's live turn answers 409; no live turn answers 409", async () => {
    liveQuestion();
    expect((await answerPOST(json("/api/confirm/answer", "POST", { marvinSessionId: "tab-r", turnId: "other", toolUseId: "q1", answers: { "Which database?": "Postgres" } }))).status).toBe(409);
    expect((await answerPOST(json("/api/confirm/answer", "POST", { marvinSessionId: "tab-none", toolUseId: "q1", answers: { "Which database?": "Postgres" } }))).status).toBe(409);
    expect(getPendingConfirm("turn-r", "q1")).not.toBeNull();
  });

  it("is CSRF-guarded", async () => {
    liveQuestion();
    expect((await answerPOST(json("/api/confirm/answer", "POST", { marvinSessionId: "tab-r", toolUseId: "q1", answers: { "Which database?": "Postgres" } }, {}))).status).toBe(403);
  });
});

describe("POST /api/confirm — an allow on a question must carry an answer", () => {
  it("refuses an allow with no answers and leaves the question pending", async () => {
    liveQuestion();
    const r = await confirmPOST(json("/api/confirm", "POST", { turnId: "turn-r", toolUseId: "q1", decision: "allow" }));
    expect(r.status).toBe(400);
    expect(getPendingConfirm("turn-r", "q1")).not.toBeNull();
  });

  it("accepts the sheet's payload and records answeredBy user", async () => {
    liveQuestion();
    const r = await confirmPOST(json("/api/confirm", "POST", { turnId: "turn-r", toolUseId: "q1", decision: "allow", updatedInput: { answers: { "Which database?": "SQLite", "Which checks?": "" }, questions: QUESTIONS } }));
    expect(r.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({ behavior: "allow", updatedInput: { answers: { "Which database?": "SQLite", "Which checks?": "" }, questions: QUESTIONS } });
    expect(loadSession("proj", "tab-r")?.turns.find((t) => t.type === "confirm.decision")).toMatchObject({ answeredBy: "user" });
  });

  it("a deny is unaffected — Skip still works", async () => {
    liveQuestion();
    const r = await confirmPOST(json("/api/confirm", "POST", { turnId: "turn-r", toolUseId: "q1", decision: "deny", message: "you decide" }));
    expect(r.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
  });
});

describe("PUT /api/sessions/posture — posture without a turn", () => {
  const put = (body: unknown, headers?: Record<string, string>) => posturePUT(json("/api/sessions/posture", "PUT", body, headers));

  it("changes the stored posture and starts no turn", async () => {
    upsertSessionMeta("proj", "tab-p", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
    const r = await put({ projectId: "proj", marvinSessionId: "tab-p", posture: { mode: "ask", permissionStrategy: "gated" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { postureRevision: number }).postureRevision).toBe(1);
    expect(readSessionMeta("proj", "tab-p")?.posture).toMatchObject({ mode: "ask", permissionStrategy: "gated" });
    expect(getLiveTurn("tab-p")).toBeNull();
    expect(loadSession("proj", "tab-p")?.turns ?? []).toEqual([]);
  });

  it("accepts a user widening now that the app shows API-set posture (milestone 6), with a revision the app echoes", async () => {
    upsertSessionMeta("proj", "tab-p", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
    const r = await put({ projectId: "proj", marvinSessionId: "tab-p", posture: { permissionStrategy: "full", mode: "ask" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { postureRevision: number; postureSource: string; changes: { field: string; direction: string }[] };
    expect(body.postureRevision).toBe(1);
    expect(body.postureSource).toBe("user");
    expect(body.changes.find((c) => c.field === "permissionStrategy")?.direction).toBe("widen");
    expect(readSessionMeta("proj", "tab-p")?.posture).toMatchObject({ permissionStrategy: "full", mode: "ask" });
  });

  it("a supervisor widening is still refused with the widened dimensions named", async () => {
    upsertSessionMeta("proj", "tab-p", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
    const token = { "x-marvin-client": "1", "x-marvin-supervisor-token": currentSupervisorToken() as string };
    const r = await put({ projectId: "proj", marvinSessionId: "tab-p", actor: "supervisor", posture: { permissionStrategy: "full", mode: "ask" } }, token);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; widened: string[] };
    expect(body.widened).toEqual(["permissionStrategy"]);
    expect(body.error).toContain("permissionStrategy auto → full");
    expect(readSessionMeta("proj", "tab-p")?.posture).toMatchObject({ permissionStrategy: "auto", mode: POSTURE.mode });
    expect(readSessionMeta("proj", "tab-p")?.postureRevision).toBeUndefined();
  });

  it("400 on an invalid patch, 404 on an unknown session", async () => {
    upsertSessionMeta("proj", "tab-p", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
    expect((await put({ projectId: "proj", marvinSessionId: "tab-p", posture: { personality: "marvin" } })).status).toBe(400);
    expect((await put({ projectId: "proj", marvinSessionId: "nope", posture: { mode: "ask" } })).status).toBe(404);
  });

  it("the supervisor actor needs the token, may narrow, and may not widen", async () => {
    upsertSessionMeta("proj", "tab-p", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
    const token = { "x-marvin-client": "1", "x-marvin-supervisor-token": currentSupervisorToken() as string };
    expect((await put({ projectId: "proj", marvinSessionId: "tab-p", actor: "supervisor", posture: { mode: "ask" } })).status).toBe(403);
    expect((await put({ projectId: "proj", marvinSessionId: "tab-p", actor: "supervisor", posture: { permissionStrategy: "full" } }, token)).status).toBe(409);
    expect(readSessionMeta("proj", "tab-p")?.posture.permissionStrategy).toBe("auto");
    expect((await put({ projectId: "proj", marvinSessionId: "tab-p", actor: "supervisor", posture: { mode: "ask" } }, token)).status).toBe(200);
    expect(readSessionMeta("proj", "tab-p")?.postureSource).toBe("supervisor");
  });

  it("is CSRF-guarded", async () => {
    upsertSessionMeta("proj", "tab-p", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
    expect((await put({ projectId: "proj", marvinSessionId: "tab-p", posture: { mode: "ask" } }, {})).status).toBe(403);
  });
});
