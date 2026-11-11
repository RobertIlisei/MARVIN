import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readNotices } from "@marvin/runtime/notices";
import { addProject } from "@marvin/runtime/projects";
import { bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DELETE, GET, POST } from "../src/app/api/notices/route";

// ADR-0131 — the user's notices route: token-gated and client-header-guarded,
// and (see supervisor-boundary.test.ts) a path a tab's shell cannot name.

const BASE = "http://localhost:3030";
let dataDir: string;
let workDir: string;
let P: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;

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

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-notices-route-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-notices-route-work-")));
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

describe("/api/notices", () => {
  it("posts, lists and retires a user notice in the project root's store", async () => {
    const posted = await POST(req("POST", "/api/notices", { projectId: P, text: "the test machine moved", ttlHours: 2 }));
    expect(posted.status).toBe(200);
    const { notice } = (await posted.json()) as { notice: { id: string; author: string } };
    expect(notice.author).toBe("user");
    expect(readNotices(workDir)).toHaveLength(1);
    const listed = (await (await GET(req("GET", `/api/notices?projectId=${P}`))).json()) as { notices: unknown[] };
    expect(listed.notices).toHaveLength(1);
    expect((await DELETE(req("DELETE", `/api/notices?projectId=${P}&id=${notice.id}`))).status).toBe(200);
    expect(readNotices(workDir)).toEqual([]);
    expect((await DELETE(req("DELETE", `/api/notices?projectId=${P}&id=${notice.id}`))).status).toBe(404);
  });

  it("refuses without the capability token, and a write without the client header", async () => {
    expect((await GET(req("GET", `/api/notices?projectId=${P}`, undefined, { token: null }))).status).toBe(403);
    expect((await POST(req("POST", "/api/notices", { projectId: P, text: "x" }, { token: null }))).status).toBe(403);
    expect((await POST(req("POST", "/api/notices", { projectId: P, text: "x" }, { client: false }))).status).toBe(403);
    expect((await DELETE(req("DELETE", `/api/notices?projectId=${P}&id=n-1`, undefined, { token: "wrong" }))).status).toBe(403);
    expect(readNotices(workDir)).toEqual([]);
  });

  it("refuses over-long, secret-shaped and unknown-project posts", async () => {
    expect((await POST(req("POST", "/api/notices", { projectId: P, text: "x".repeat(401) }))).status).toBe(400);
    expect((await POST(req("POST", "/api/notices", { projectId: P, text: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }))).status).toBe(400);
    expect((await POST(req("POST", "/api/notices", { projectId: P, text: "ok", ttlHours: 24 * 30 }))).status).toBe(400);
    expect((await POST(req("POST", "/api/notices", { projectId: "nope", text: "ok" }))).status).toBe(404);
    expect(readNotices(workDir)).toEqual([]);
  });
});
