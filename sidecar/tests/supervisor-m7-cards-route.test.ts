import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test imports the route and runtime graph afresh (`vi.resetModules`); cold, that exceeds the 5 s default.
vi.setConfig({ testTimeout: 30_000 });

// ADR-0128 §3–§4, plan milestone [7.2], through the routes: a card a message
// wake raised is the same inbox item in the conversation (`GET
// /api/supervisor/message` → `items`) and in Needs you (`GET
// /api/supervisor/inbox`, with its origin); an edited send card is delivered
// as the supervisor's words, marked `editedByUser` in the tab's transcript
// and in the ledger.

type RunInput = Record<string, unknown>;
let captured: RunInput[];
let dataDir: string;
let repo: string;
const prev = process.env.MARVIN_DATA_DIR;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "medium", mode: "agent" as const };

beforeEach(() => {
  vi.resetModules();
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m72r-data-"));
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-m72r-repo-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@x");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  captured = [];
  vi.doMock("@marvin/runtime/sdk-runner", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@marvin/runtime/sdk-runner")>();
    return {
      ...orig,
      runAgent: async (input: RunInput) => {
        captured.push(input);
        return { ok: true, costUsd: 0 };
      },
    };
  });
});
afterEach(async () => {
  const { __resetSchedulerForTests } = await import("@marvin/runtime/wakeup-scheduler");
  __resetSchedulerForTests();
  (await import("@marvin/runtime/supervisor-state")).resetSupervisorStateForTests();
  vi.doUnmock("@marvin/runtime/sdk-runner");
  vi.resetModules();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function setup() {
  const st = await import("@marvin/runtime/supervisor-state");
  st.resetSupervisorStateForTests();
  st.bootSupervisor();
  const token = st.currentSupervisorToken() as string;
  const projectId = (await import("@marvin/runtime/projects")).addProject({ name: "repo", workDir: repo }).id;
  const meta = await import("@marvin/runtime/session-meta");
  meta.upsertSessionMeta(projectId, "obs-tab", { workDir: repo, tree: { mode: "shared" }, posture: POSTURE }, { title: "fix-flags" });
  st.applySupervisorAction({ projectId, action: "start", delegations: [{ sessionId: "obs-tab", level: "observe" }] }, token);
  await import("../src/lib/turn-orchestrator"); // wires the fire handler
  const { NextRequest } = await import("next/server");
  const headers = { "content-type": "application/json", "x-marvin-client": "1", "x-marvin-supervisor-token": token };
  const inbox = await import("../src/app/api/supervisor/inbox/route");
  const message = await import("../src/app/api/supervisor/message/route");
  return {
    projectId,
    consent: (body: Record<string, unknown>) => inbox.POST(new NextRequest("http://localhost:3030/api/supervisor/inbox", { method: "POST", headers, body: JSON.stringify({ projectId, ...body }) })),
    listInbox: () => inbox.GET(new NextRequest(`http://localhost:3030/api/supervisor/inbox?projectId=${projectId}`, { headers })),
    conversation: () => message.GET(new NextRequest(`http://localhost:3030/api/supervisor/message?projectId=${projectId}`, { headers })),
  };
}

/** One message wake: the user asks for a send to the observe tab; the supervisor raises the card and replies with it. */
async function askForASend(projectId: string) {
  const { addUserMessage } = await import("@marvin/runtime/supervisor-messages");
  const { createSupervisorVerbs } = await import("../packages/runtime/src/supervisor-mcp");
  const { defaultVerbDeps } = await import("@marvin/runtime/supervisor-loop");
  const { ActionLimiter } = await import("../packages/runtime/src/supervisor-policy");
  const { getSupervisorState } = await import("@marvin/runtime/supervisor-state");
  const { setWakeOrigin } = await import("@marvin/runtime/supervisor-ledger");
  const { listInbox } = await import("@marvin/runtime/supervisor-inbox");
  const m = addUserMessage(projectId, "Tell fix-flags to run the tests before it commits.");
  const conversation = { wakeId: "w-chat", messageIds: [m.id] };
  setWakeOrigin("w-chat", { kind: "message", messageIds: [m.id] });
  const verbs = createSupervisorVerbs({
    projectId,
    workDir: repo,
    wakeId: "w-chat",
    wake: { acts: 0 },
    limiter: new ActionLimiter(() => getSupervisorState(projectId).caps),
    deps: defaultVerbDeps(projectId, repo, conversation),
    conversation: { messageIds: [m.id] },
  });
  const out = await verbs.send({ marvinSessionId: "obs-tab", message: "Run the tests before you commit.", kind: "instruction", grounds: [{ kind: "message", ref: `${m.id}#run the tests before it commits` }] });
  expect(out).toMatch(/^Escalated/);
  const item = listInbox(projectId, { state: "open" })[0] as NonNullable<ReturnType<typeof listInbox>[number]>;
  await verbs.reply({ text: "fix-flags is at observe, so here is the message as a card.", items: [item.id] });
  setWakeOrigin("w-chat", null);
  return { m, item };
}

describe("the card is the inbox item, in both places", () => {
  it("the reply carries it; Needs you lists it with the message's origin and the server's actions", async () => {
    const { projectId, listInbox, conversation } = await setup();
    const { m, item } = await askForASend(projectId);
    const { messages } = (await (await conversation()).json()) as { messages: Array<{ from: string; items?: string[] }> };
    expect(messages.find((x) => x.from === "supervisor")?.items).toEqual([item.id]);
    const { items } = (await (await listInbox()).json()) as { items: Array<Record<string, unknown>> };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: item.id, sessionId: "obs-tab", escalatedBecause: { code: "delegation-observe" }, origin: { kind: "message", messageIds: [m.id] } });
    expect((items[0]?.actions as Array<{ id: string }>).map((a) => a.id)).toEqual(["perform", "edit", "dismiss"]);
  });
});

describe("an edited send card", () => {
  it("reaches the tab as the supervisor's words, editedByUser in the transcript and the ledger", async () => {
    const { projectId, consent } = await setup();
    const { item } = await askForASend(projectId);
    const r = await consent({ id: item.id, actionId: "edit", edits: { text: "Run the full test suite before you commit, then stop." } });
    expect(r.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(String(captured[0]?.message)).toContain("Run the full test suite before you commit, then stop.");
    expect(String(captured[0]?.message)).toMatch(/not from the user/);
    const { marvinPaths } = await import("@marvin/runtime/paths");
    const lines = readFileSync(marvinPaths.sessionFile(projectId, "obs-tab"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.find((t) => t.type === "turn.user")).toMatchObject({ author: "supervisor", supervisor: { kind: "instruction", editedByUser: true } });
    const { readLedger } = await import("@marvin/runtime/supervisor-ledger");
    expect(readLedger(projectId).find((e) => e.kind === "inbox")).toMatchObject({ inboxItemId: item.id, editedByUser: true });
    // Settled once: a second click is refused.
    expect((await consent({ id: item.id, actionId: "perform" })).status).toBe(409);
  });

  it("an edit carrying a secret is refused at perform time and sends nothing", async () => {
    const { projectId, consent } = await setup();
    const { item } = await askForASend(projectId);
    const r = await consent({ id: item.id, actionId: "edit", edits: { text: "Use sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA to deploy" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code?: string }).code).toBe("secret");
    expect(captured).toEqual([]);
  });
});
