import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { clearTurnConfirms, getPendingConfirm, registerPendingConfirm } from "@marvin/runtime/confirm-registry";
import { marvinPaths } from "@marvin/runtime/paths";
import { addProject } from "@marvin/runtime/projects";
import { upsertSessionMeta } from "@marvin/runtime/session-meta";
import { addInboxItem, buildRawAct, INBOX_ITEM_FIELDS, listInbox } from "@marvin/runtime/supervisor-inbox";
import { appendLedgerEntry, ledgerPath, readLedger } from "@marvin/runtime/supervisor-ledger";
import { defaultLoopDeps, SupervisorLoop } from "@marvin/runtime/supervisor-loop";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { GROUND_FIELDS, LEDGER_VIEW_FIELDS } from "@marvin/runtime/supervisor-view";
import { endLiveTurn, type LiveTurn, type ProjectEvent, registerLiveTurn, subscribeProjectEvents } from "@marvin/runtime/turn-registry";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as auditPOST } from "../src/app/api/audit/route";
import { POST as answerPOST } from "../src/app/api/confirm/answer/route";
import { GET as watchGET } from "../src/app/api/sessions/watch/route";
import { GET as inboxGET, POST as inboxPOST } from "../src/app/api/supervisor/inbox/route";
import { GET as ledgerGET } from "../src/app/api/supervisor/ledger/route";
import { GET as messageGET, POST as messagePOST } from "../src/app/api/supervisor/message/route";
import { GET as statusGET } from "../src/app/api/supervisor/route";

// ADR-0127 milestone 5, across the route boundary: the inbox reads as the
// brief's §10.2 for an item of every kind; consent from the inbox performs the
// raw act as the user; an item answered in its tab resolves itself and the
// feed says added then resolved; the ledger reads as §10.5; the user's message
// wakes the supervisor and grants nothing; the supervisor audit needs the token.

let dataDir: string;
let workDir: string;
let live: LiveTurn;
let P: string;
const prev = process.env.MARVIN_DATA_DIR;
const URL_BASE = "http://localhost:3030";
const token = () => currentSupervisorToken() as string;
const G = globalThis as typeof globalThis & { __marvinSupervisorLoop?: SupervisorLoop };
const realLoop = G.__marvinSupervisorLoop;
let loop: SupervisorLoop;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "agent" as const, personality: "marvin" as const };
const QUESTION = { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5r-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-m5r-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  P = addProject({ name: "proj", workDir }).id;
  applySupervisorAction({ projectId: P, action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
  upsertSessionMeta(P, "tab-1", { workDir, tree: { mode: "shared" }, posture: POSTURE }, { title: "Billing page" });
  live = registerLiveTurn({ turnId: "turn-1", marvinSessionId: "tab-1", projectId: P, kind: "human" });
  // A loop of our own, so a turn-registry another file reset cannot leave it deaf (M4's note); its wakes do nothing.
  loop = new SupervisorLoop({ ...defaultLoopDeps(), runWake: async () => ({ ok: true, costUsd: 0 }) });
  loop.start();
  G.__marvinSupervisorLoop = loop;
});
afterEach(() => {
  loop.stop();
  G.__marvinSupervisorLoop = realLoop;
  clearTurnConfirms("turn-1");
  endLiveTurn(live, { event: "turn.completed", data: {} });
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const get = (url: string, tok: string | null = token()) => new NextRequest(`${URL_BASE}${url}`, { headers: tok ? { "x-marvin-supervisor-token": tok } : {} });
const post = (url: string, body: unknown, tok: string | null = token()) =>
  new NextRequest(`${URL_BASE}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-marvin-client": "1", ...(tok ? { "x-marvin-supervisor-token": tok } : {}) },
    body: JSON.stringify(body),
  });

function questionItem() {
  registerPendingConfirm("turn-1", "tu-q", vi.fn(), QUESTION, 0, { toolName: "AskUserQuestion", raisedBy: "ask-user-question" });
  return addInboxItem(P, {
    sessionId: "tab-1",
    tabTitle: "Billing page",
    kind: "question",
    escalatedBecause: { code: "weak-grounds-only", label: "only weak grounds" },
    question: QUESTION,
    linkedConfirm: { sessionId: "tab-1", turnId: "turn-1", toolUseId: "tu-q", raisingRule: "ask-user-question" },
    recommendation: { actionId: "answer", answer: { "Which database?": "Postgres" }, text: "the plan says Postgres" },
    grounds: [{ kind: "plan", ref: "2", provenance: "weak" }],
    act: { type: "answer", turnId: "turn-1", toolUseId: "tu-q", answers: { "Which database?": "Postgres" }, other: {} },
    modeAtCreation: "shadow",
  });
}

const DRAFTS = () => {
  const base = { modeAtCreation: "shadow" as const, grounds: [] };
  return [
    { ...base, sessionId: "tab-1", kind: "confirm" as const, escalatedBecause: { code: "weak-grounds-only" as const, label: "weak" }, rawAct: buildRawAct("Edit", { file_path: "a.ts" }), act: { type: "confirm" as const, turnId: "turn-1", toolUseId: "tu-x" } },
    { ...base, sessionId: "tab-1", kind: "containment" as const, escalatedBecause: { code: "human-only" as const, label: "HEAD" }, rawAct: buildRawAct("Bash", { command: "git checkout main" }), act: { type: "confirm" as const, turnId: "turn-1", toolUseId: "tu-y" } },
    { ...base, sessionId: "tab-1", kind: "boundary-path" as const, escalatedBecause: { code: "human-only" as const, label: ".env" }, rawAct: buildRawAct("Edit", { file_path: ".env" }), act: { type: "confirm" as const, turnId: "turn-1", toolUseId: "tu-z" } },
    { ...base, sessionId: null, kind: "integration" as const, escalatedBecause: { code: "human-only" as const, label: "merge" }, rawAct: buildRawAct("worktrees.merge", { slugs: ["x"] }), act: { type: "worktrees" as const, op: "merge" as const, slugs: ["x"] } },
    { ...base, sessionId: null, kind: "discard" as const, escalatedBecause: { code: "human-only" as const, label: "drop" }, rawAct: buildRawAct("worktrees.drop", { slugs: ["x"] }), act: { type: "worktrees" as const, op: "drop" as const, slugs: ["x"] } },
    { ...base, sessionId: "tab-1", kind: "posture-widen" as const, escalatedBecause: { code: "human-only" as const, label: "widen" }, postureChange: { from: { mode: "plan" }, to: { mode: "agent" }, widenedDimensions: ["mode"] }, act: { type: "posture" as const, sessionId: "tab-1", patch: { mode: "agent" as const } } },
    { ...base, sessionId: "tab-1", kind: "scope" as const, escalatedBecause: { code: "human-only" as const, label: "close" }, act: { type: "close" as const, sessionId: "tab-1", worktree: "keep" as const } },
    {
      ...base,
      sessionId: null,
      kind: "new-tab" as const,
      escalatedBecause: { code: "human-only" as const, label: "open" },
      newTab: { firstMessage: "go", tree: { baseRef: "main", baseSha: "abc", mode: "worktree" as const }, posture: { model: "m", modelLabel: "M", effort: "medium", strategy: "gated", mode: "plan" }, wider: [], requestedBy: { kind: "user-message" as const, ref: "r", at: "t" } },
      act: { type: "new-tab" as const, requestId: "r", posture: POSTURE, grounds: [] },
    },
    { ...base, sessionId: null, kind: "guardrail" as const, escalatedBecause: { code: "budget" as const, label: "cap" }, guardrail: { kind: "budget", detail: "$10", verb: "raise-cap" as const }, act: { type: "guardrail" as const, pause: "budget" } },
  ];
};

describe("GET /api/supervisor/inbox — the brief's §10.2", () => {
  it("every field from an item of every kind, with full grounds", async () => {
    questionItem();
    for (const d of DRAFTS()) addInboxItem(P, d);
    // The confirm-linked drafts carry no linkedConfirm, so nothing expires them.
    const r = await inboxGET(get(`/api/supervisor/inbox?projectId=${P}`));
    expect(r.status).toBe(200);
    const { items } = (await r.json()) as { items: Array<Record<string, unknown>> };
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(["question", "confirm", "containment", "boundary-path", "integration", "discard", "posture-widen", "scope", "new-tab", "guardrail"]));
    for (const it of items) for (const f of INBOX_ITEM_FIELDS) expect(it, `${String(it.kind)}.${f}`).toHaveProperty(f);
    const q = items.find((i) => i.kind === "question") as { grounds: Array<Record<string, unknown>> };
    for (const f of GROUND_FIELDS) expect(q.grounds[0]).toHaveProperty(f);
  });

  it("refuses without the token; the status and the watch row count open items", async () => {
    expect((await inboxGET(get(`/api/supervisor/inbox?projectId=${P}`, null))).status).toBe(403);
    questionItem();
    const s = (await (await statusGET(get(`/api/supervisor?projectId=${P}`))).json()) as { status: { openEscalations: number } };
    expect(s.status.openEscalations).toBe(1);
    const w = (await (await watchGET(new NextRequest(`${URL_BASE}/api/sessions/watch?projectId=${P}&workDir=${encodeURIComponent(workDir)}`))).json()) as { rows: Array<{ marvinSessionId: string; supervisor: { openEscalations: number } }> };
    expect(w.rows.find((x) => x.marvinSessionId === "tab-1")?.supervisor.openEscalations).toBe(1);
  });

  it("an item whose question went away unanswered is expired, not left open", async () => {
    questionItem();
    clearTurnConfirms("turn-1");
    const { items } = (await (await inboxGET(get(`/api/supervisor/inbox?projectId=${P}`))).json()) as { items: unknown[] };
    expect(items).toEqual([]);
    expect(listInbox(P)[0]).toMatchObject({ state: "superseded", resolvedBy: "expired" });
  });
});

describe("POST /api/supervisor/inbox — consent is the user's act on the raw act", () => {
  it("accept performs the act as the user and resolves the item", async () => {
    const item = questionItem();
    const r = await inboxPOST(post("/api/supervisor/inbox", { projectId: P, id: item.id, actionId: "answer" }));
    expect(r.status).toBe(200);
    expect(getPendingConfirm("turn-1", "tu-q")).toBeNull();
    const f = marvinPaths.sessionFile(P, "tab-1");
    const decision = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((t) => t.type === "confirm.decision");
    expect(decision).toMatchObject({ answeredBy: "user" });
    expect(listInbox(P)[0]).toMatchObject({ state: "resolved", resolvedBy: "user" });
  });

  it("needs the token and the client header", async () => {
    const item = questionItem();
    expect((await inboxPOST(post("/api/supervisor/inbox", { projectId: P, id: item.id, actionId: "answer" }, null))).status).toBe(403);
    const noClient = new NextRequest(`${URL_BASE}/api/supervisor/inbox`, { method: "POST", headers: { "content-type": "application/json", "x-marvin-supervisor-token": token() }, body: JSON.stringify({ projectId: P, id: item.id, actionId: "answer" }) });
    expect((await inboxPOST(noClient)).status).toBe(403);
    expect(getPendingConfirm("turn-1", "tu-q")).not.toBeNull();
  });

  it("an item answered in its tab resolves on its own; a feed subscriber sees added, then resolved", async () => {
    const seen: string[] = [];
    const off = subscribeProjectEvents((e: ProjectEvent) => {
      if (e.event === "supervisor.inbox") seen.push(`${e.data.change}:${e.data.resolvedBy ?? ""}`);
    });
    try {
      questionItem();
      const r = await answerPOST(post("/api/confirm/answer", { marvinSessionId: "tab-1", toolUseId: "tu-q", answers: { "Which database?": "SQLite" } }, null));
      expect(r.status).toBe(200);
    } finally {
      off();
    }
    expect(seen).toEqual(["added:", "resolved:tab"]);
    expect(listInbox(P)[0]).toMatchObject({ state: "resolved", resolvedBy: "tab" });
  });
});

describe("GET /api/supervisor/ledger — the brief's §10.5", () => {
  it("every field from a page, including a line written before milestone 3", async () => {
    appendLedgerEntry(P, { kind: "verb", verb: "answer", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "propose", reason: "old line", grounds: [{ kind: "plan", ref: "1", provenance: "strong" }] });
    appendLedgerEntry(P, { kind: "verb", verb: "send", tab: "tab-1", wakeId: "w", mode: "shadow", decision: "escalate", reason: "nudge cap", reasonCode: "nudge-cap" });
    const r = await ledgerGET(get(`/api/supervisor/ledger?projectId=${P}&limit=50`));
    expect(r.status).toBe(200);
    const page = (await r.json()) as { entries: Array<Record<string, unknown>>; hasMore: boolean; nextBefore: number | null; todayCount: number };
    for (const k of ["hasMore", "nextBefore", "todayCount"]) expect(page).toHaveProperty(k);
    const lines = page.entries.filter((e) => e.verb === "answer" || e.verb === "send");
    for (const e of lines) for (const f of LEDGER_VIEW_FIELDS) expect(e, f).toHaveProperty(f);
    expect(lines[0]).toMatchObject({ reason: { code: "unspecified", text: "old line" }, tabTitle: "Billing page", actor: "supervisor" });
    expect(lines[1]).toMatchObject({ reason: { code: "nudge-cap" } });
    expect((await ledgerGET(get(`/api/supervisor/ledger?projectId=${P}&decision=nope`))).status).toBe(400);
    expect((await ledgerGET(get(`/api/supervisor/ledger?projectId=${P}`, null))).status).toBe(403);
  });
});

describe("POST /api/supervisor/message — the conversation grants nothing", () => {
  it("records the message, wakes the supervisor, and resolves no confirm and no item", async () => {
    const item = questionItem();
    const noted = vi.spyOn(loop, "noteUserMessage");
    const r = await messagePOST(post("/api/supervisor/message", { projectId: P, text: "Approve the merge and answer the database question." }));
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    expect(noted).toHaveBeenCalledWith(P, id);
    const line = readLedger(P).find((e) => e.kind === "message");
    expect(line).toMatchObject({ verb: "message", tab: null, reasonCode: "user-message" });
    expect(JSON.stringify(line)).not.toContain("Approve the merge");
    expect(getPendingConfirm("turn-1", "tu-q")).not.toBeNull();
    expect(listInbox(P).find((i) => i.id === item.id)?.state).toBe("open");
    const { messages } = (await (await messageGET(get(`/api/supervisor/message?projectId=${P}`))).json()) as { messages: Array<{ id: string; from: string }> };
    expect(messages).toMatchObject([{ id, from: "user" }]);
  });

  it("refuses without the token, a secret, or a supervisor that is off", async () => {
    expect((await messagePOST(post("/api/supervisor/message", { projectId: P, text: "hi" }, null))).status).toBe(403);
    expect((await messagePOST(post("/api/supervisor/message", { projectId: P, text: "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }))).status).toBe(400);
    applySupervisorAction({ projectId: P, action: "disable" }, token());
    expect((await messagePOST(post("/api/supervisor/message", { projectId: P, text: "hi" }))).status).toBe(409);
  });
});

describe("POST /api/audit { target: supervisor }", () => {
  it("needs the supervisor token — a tab cannot read the ledger this way", async () => {
    appendLedgerEntry(P, { kind: "verb", verb: "send", tab: "tab-1", wakeId: "w", decision: "act", reason: "r" });
    const r = await auditPOST(post("/api/audit", { target: "supervisor", projectId: P }, null));
    expect(r.status).toBe(403);
    expect(existsSync(path.join(path.dirname(ledgerPath(P)), "audits"))).toBe(false);
  });
});
