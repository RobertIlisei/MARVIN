import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addProject } from "@marvin/runtime/projects";
import { listInbox } from "@marvin/runtime/supervisor-inbox";
import { approveEntries, holdEntry, readQueue } from "@marvin/runtime/supervisor-queue";
import { bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "../src/app/api/supervisor/queue/route";

// ADR-0133 — the user's side of the queue: token-gated and client-header-guarded,
// under /api/supervisor (a control path a tab cannot name — supervisor-boundary.test.ts).
// It sets the cap, releases a hold and proposes a guard CARD; it approves no entry.

const BASE = "http://localhost:3030";
let dataDir: string;
let workDir: string;
let P: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "plan" as const, personality: "marvin" as const };

const req = (method: string, url: string, body?: unknown, opts: { token?: string | null; client?: boolean } = {}) =>
  new NextRequest(`${BASE}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token === null ? {} : { "x-marvin-supervisor-token": opts.token ?? token() }),
      ...(opts.client === false ? {} : { "x-marvin-client": "1" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const post = (body: Record<string, unknown>, opts?: { token?: string | null; client?: boolean }) => POST(req("POST", "/api/supervisor/queue", { projectId: P, ...body }, opts));

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-queue-route-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-queue-route-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  P = addProject({ name: "proj", workDir }).id;
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("/api/supervisor/queue", () => {
  it("shows the queue: order, cap, each hold with its reason, the first lines of each brief", async () => {
    approveEntries(P, [
      { id: "A", title: "A", brief: "line1\nline2\nline3\nline4 secret-ish tail", posture: POSTURE, wider: [] },
      { id: "B", title: "B", brief: "b", posture: POSTURE, wider: [] },
    ]);
    holdEntry(P, "B", "the plan deferred it");
    const q = (await (await GET(req("GET", `/api/supervisor/queue?projectId=${P}`))).json()) as { cap: number; entries: Array<{ id: string; position: number; briefHead: string; hold: { reason: string } | null }> };
    expect(q.cap).toBe(1);
    expect(q.entries.map((e) => [e.id, e.position])).toEqual([["A", 1], ["B", 2]]);
    expect(q.entries[0]?.briefHead).toBe("line1\nline2\nline3");
    expect(q.entries[1]?.hold?.reason).toBe("the plan deferred it");
  });

  it("the user sets the cap (0-20); a bad number is refused", async () => {
    expect((await post({ action: "cap", cap: 4 })).status).toBe(200);
    expect(readQueue(P).cap).toBe(4);
    for (const bad of [21, -1, 1.5, "3", null]) expect((await post({ action: "cap", cap: bad })).status).toBe(400);
    expect(readQueue(P).cap).toBe(4);
  });

  it("restores the cap the supervisor lowered, and refuses when it is not lowered", async () => {
    expect((await post({ action: "restore-cap" })).status).toBe(409);
  });

  it("releases a held entry and removes one; an unknown id is a 404", async () => {
    approveEntries(P, [{ id: "A", title: "A", brief: "b", posture: POSTURE, wider: [] }]);
    holdEntry(P, "A", "why");
    expect((await post({ action: "release", id: "A" })).status).toBe(200);
    expect(readQueue(P).entries[0]?.hold).toBeUndefined();
    expect((await post({ action: "remove", id: "A" })).status).toBe(200);
    expect((await post({ action: "remove", id: "A" })).status).toBe(404);
    expect((await post({ action: "release", id: "ghost" })).status).toBe(404);
  });

  it("propose-guard raises a card showing the command in full and sets NOTHING until the user clicks it", async () => {
    const command = `ssh runner true # ${"x".repeat(300)}`;
    const r = await post({ action: "propose-guard", command });
    expect(r.status).toBe(200);
    expect(readQueue(P).guard).toBeNull();
    const [item] = listInbox(P);
    expect(item).toMatchObject({ kind: "queue", act: { type: "queue", what: "guard" }, queue: { kind: "guard", command, previous: null } });
    expect(item?.rawAct?.summary).toContain(command);
  });

  it("refuses an empty, over-long or secret-shaped command", async () => {
    for (const command of ["  ", "x".repeat(1001), "curl -H 'x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' u"]) {
      expect((await post({ action: "propose-guard", command })).status).toBe(400);
    }
    expect(listInbox(P)).toEqual([]);
  });

  it("refuses without the capability token and a write without the client header; an unknown action or project", async () => {
    expect((await GET(req("GET", `/api/supervisor/queue?projectId=${P}`, undefined, { token: null }))).status).toBe(403);
    expect((await post({ action: "cap", cap: 3 }, { token: null })).status).toBe(403);
    expect((await post({ action: "cap", cap: 3 }, { token: "wrong" })).status).toBe(403);
    expect((await post({ action: "cap", cap: 3 }, { client: false })).status).toBe(403);
    expect((await post({ action: "approve" })).status).toBe(400);
    expect((await POST(req("POST", "/api/supervisor/queue", { projectId: "nope", action: "cap", cap: 2 }))).status).toBe(404);
    expect(readQueue(P).cap).toBe(1);
  });

  it("has no way to approve an entry: only the inbox click does", async () => {
    const r = await post({ action: "approve", entries: [{ id: "A", title: "t", brief: "b" }] });
    expect(r.status).toBe(400);
    expect(readQueue(P).entries).toEqual([]);
  });
});
