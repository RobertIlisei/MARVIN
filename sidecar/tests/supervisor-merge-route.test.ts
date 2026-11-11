import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addProject } from "@marvin/runtime/projects";
import { listInbox } from "@marvin/runtime/supervisor-inbox";
import { approveMerge, holdBranch, readMerge } from "@marvin/runtime/supervisor-merge";
import { bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "../src/app/api/supervisor/merge/route";

// ADR-0134 — the user's side of the standing merge: token-gated and client-header
// guarded, under /api/supervisor (a control path a tab cannot name —
// supervisor-boundary.test.ts). It raises the authorisation CARD, revokes it and
// lifts a hold; it never creates an authorisation.

const BASE = "http://localhost:3030";
let dataDir: string;
let workDir: string;
let P: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, stdio: "ignore" });

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
const post = (body: Record<string, unknown>, opts?: { token?: string | null; client?: boolean }) => POST(req("POST", "/api/supervisor/merge", { projectId: P, ...body }, opts));
const PROPOSE = { action: "propose", target: "integration", gate: "pnpm test:full", timeoutSeconds: 3000, validForHours: 48 };
const authorise = () => approveMerge(P, { target: "integration", gate: "true", timeoutMs: 600_000, holds: [], validForHours: 24, timeZone: "UTC" });

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-merge-route-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-merge-route-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("branch", "integration");
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

describe("/api/supervisor/merge", () => {
  it("propose raises a card showing the target and the gate in full, with the zone, and authorises NOTHING until the user clicks it", async () => {
    const r = await post(PROPOSE);
    expect(r.status).toBe(200);
    expect(readMerge(P).authorisation).toBeNull();
    const [item] = listInbox(P);
    expect(item).toMatchObject({ kind: "queue", act: { type: "queue", what: "merge" }, queue: { kind: "merge", proposal: { target: "integration", gate: "pnpm test:full", timeoutMs: 3_000_000, validForHours: 48 }, previous: null } });
    expect((item?.queue as { proposal: { timeZone: string } }).proposal.timeZone.length).toBeGreaterThan(0);
    expect(item?.rawAct?.summary).toContain("pnpm test:full");
    expect(item?.rawAct?.summary).toContain("integration");
  });

  it("refuses a target that is not a local branch, a bad gate, an over-long validity and a wild timeout", async () => {
    for (const bad of [{ target: "nope" }, { target: "marvin/tab/x" }, { gate: " " }, { gate: "x".repeat(1001) }, { validForHours: 14 * 24 + 1 }, { timeoutSeconds: 1 }, { holds: [{ pathGlob: "a", window: { from: "1", to: "2" } }] }]) {
      expect((await post({ ...PROPOSE, ...bad })).status).toBe(400);
    }
    expect(listInbox(P)).toEqual([]);
  });

  it("revoke ends the authorisation in one call; with none it is a 409", async () => {
    expect((await post({ action: "revoke" })).status).toBe(409);
    authorise();
    expect((await post({ action: "revoke" })).status).toBe(200);
    expect(readMerge(P).authorisation).toBeNull();
    expect(readMerge(P).ended?.why).toBe("revoked");
  });

  it("shows the authorisation, the holds and who placed them", async () => {
    authorise();
    holdBranch(P, "marvin/tab/a", "wait for the schema");
    const v = (await (await GET(req("GET", `/api/supervisor/merge?projectId=${P}`))).json()) as { authorisation: { target: string; gate: string }; holds: Array<{ by: string; reason: string }> };
    expect(v.authorisation).toMatchObject({ target: "integration", gate: "true" });
    expect(v.holds).toMatchObject([{ by: "supervisor", reason: "wait for the schema" }]);
  });

  it("the user lifts a hold", async () => {
    authorise();
    holdBranch(P, "marvin/tab/a", "r");
    expect((await post({ action: "release-hold", branch: "marvin/tab/a" })).status).toBe(200);
    expect(readMerge(P).holds).toEqual([]);
    expect((await post({ action: "release-hold", branch: "marvin/tab/a" })).status).toBe(404);
  });

  it("has no way to approve: only the inbox click does", async () => {
    expect((await post({ ...PROPOSE, action: "approve" })).status).toBe(400);
    expect((await post({ action: "set", authorisation: { approvedBy: "user" } })).status).toBe(400);
    expect(readMerge(P).authorisation).toBeNull();
  });

  it("refuses without the capability token and a write without the client header; an unknown project", async () => {
    expect((await GET(req("GET", `/api/supervisor/merge?projectId=${P}`, undefined, { token: null }))).status).toBe(403);
    expect((await post(PROPOSE, { token: null })).status).toBe(403);
    expect((await post(PROPOSE, { token: "wrong" })).status).toBe(403);
    expect((await post(PROPOSE, { client: false })).status).toBe(403);
    expect((await POST(req("POST", "/api/supervisor/merge", { projectId: "nope", ...PROPOSE }))).status).toBe(404);
    expect(listInbox(P)).toEqual([]);
  });
});
