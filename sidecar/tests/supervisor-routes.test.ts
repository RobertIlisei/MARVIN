import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendLedgerEntry,
} from "@marvin/runtime/supervisor-ledger";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  resetSupervisorStateForTests,
} from "@marvin/runtime/supervisor-state";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as ledgerGET } from "../src/app/api/supervisor/ledger/route";
import { GET, POST } from "../src/app/api/supervisor/route";

// ADR-0127 §5 — every supervisor route needs the per-boot token (GET too);
// POST is CSRF-guarded like every mutating route; and the chat route never
// runs the supervisor's own session as an ordinary tab.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const URL_BASE = "http://localhost:3030";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-routes-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const token = () => currentSupervisorToken() as string;

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${URL_BASE}/api/supervisor`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-marvin-client": "1", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/supervisor", () => {
  it("POST without the token is refused and changes nothing", async () => {
    const r = await POST(post({ projectId: "proj", action: "start" }));
    expect(r.status).toBe(403);
    expect(getSupervisorState("proj").mode).toBe("off");
  });

  it("POST with a wrong token is refused", async () => {
    const r = await POST(post({ projectId: "proj", action: "start" }, { "x-marvin-supervisor-token": "0".repeat(64) }));
    expect(r.status).toBe(403);
  });

  it("POST without the CSRF header is refused even with the token", async () => {
    const req = new NextRequest(`${URL_BASE}/api/supervisor`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-marvin-supervisor-token": token() },
      body: JSON.stringify({ projectId: "proj", action: "start" }),
    });
    expect((await POST(req)).status).toBe(403);
  });

  it("POST with the token starts the supervisor in shadow mode", async () => {
    const r = await POST(post({ projectId: "proj", action: "start" }, { "x-marvin-supervisor-token": token() }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { state: { mode: string } }).state.mode).toBe("shadow");
  });

  it("POST refuses autonomy in milestone 1", async () => {
    const r = await POST(post({ projectId: "proj", action: "mode", mode: "autonomous" }, { "x-marvin-supervisor-token": token() }));
    expect(r.status).toBe(400);
  });

  it("GET needs the token too", async () => {
    expect((await GET(new NextRequest(`${URL_BASE}/api/supervisor?projectId=proj`))).status).toBe(403);
    const ok = await GET(new NextRequest(`${URL_BASE}/api/supervisor?projectId=proj`, { headers: { "x-marvin-supervisor-token": token() } }));
    expect(ok.status).toBe(200);
  });
});

describe("/api/supervisor/ledger", () => {
  it("needs the token, then returns the entries", async () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "t", wakeId: "w", mode: "shadow", decision: "propose", reason: "r", grounds: [] });
    expect((await ledgerGET(new NextRequest(`${URL_BASE}/api/supervisor/ledger?projectId=proj`))).status).toBe(403);
    const r = await ledgerGET(
      new NextRequest(`${URL_BASE}/api/supervisor/ledger?projectId=proj&tab=t`, { headers: { "x-marvin-supervisor-token": token() } }),
    );
    expect(r.status).toBe(200);
    const { entries } = (await r.json()) as { entries: Array<{ verb: string; decision?: string }> };
    expect(entries.map((e) => `${e.verb}:${e.decision}`)).toEqual(["answer:propose"]);
  });
});

describe("/api/chat refuses the supervisor's own session", () => {
  it("answers 409 before doing anything else", async () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    const own = getSupervisorState("proj").supervisorSessionId as string;
    const { POST: chatPOST } = await import("../src/app/api/chat/route");
    const r = await chatPOST(
      new NextRequest(`${URL_BASE}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-marvin-client": "1" },
        body: JSON.stringify({ message: "hello", cwd: dataDir, marvinSessionId: own }),
      }),
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe("supervisor-session");
  });
});
