import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readSessionMeta, updateSessionMeta, upsertSessionMeta } from "@marvin/runtime/session-meta";
import { supervisorBoundaryDenial } from "@marvin/tools/policy";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../src/app/api/sessions/attention/route";

// ADR-0130 / milestone 2.4 — the user dismisses a session's attention item;
// a tab's shell cannot reach the route (the ADR-0127 §5 side-door rule).

const POSTURE = { model: "claude-opus-5-5", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };
let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-attention-route-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  upsertSessionMeta("proj", "tab-a", { workDir: dataDir, tree: { mode: "shared" }, posture: POSTURE });
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (body: unknown, headers: Record<string, string> = { "x-marvin-client": "1" }) =>
  POST(new NextRequest("http://localhost:3030/api/sessions/attention", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

describe("POST /api/sessions/attention", () => {
  it("clears the item and reports it", async () => {
    updateSessionMeta("proj", "tab-a", { attention: { kind: "prose-question", excerpt: "q?", since: "2026-11-11T10:00:00Z", turnId: "t1" } });
    const r = await post({ projectId: "proj", marvinSessionId: "tab-a" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, dismissed: true });
    expect(readSessionMeta("proj", "tab-a")?.attention).toBeUndefined();
    expect(await (await post({ projectId: "proj", marvinSessionId: "tab-a" })).json()).toEqual({ ok: true, dismissed: false });
  });

  it("refuses a request without the client header, a bad body and an unknown session", async () => {
    expect((await post({ projectId: "proj", marvinSessionId: "tab-a" }, {})).status).toBeGreaterThanOrEqual(400);
    expect((await post({ projectId: "proj" })).status).toBe(400);
    expect((await post({ projectId: "proj", marvinSessionId: "../x" })).status).toBe(400);
    expect((await post({ projectId: "proj", marvinSessionId: "nope" })).status).toBe(404);
  });
});

describe("a tab cannot reach the dismiss route", () => {
  it.each([
    "curl -s -X POST http://localhost:3030/api/sessions/attention -H 'x-marvin-client: 1' -d '{}'",
    "curl -X POST http://127.0.0.1:3030/api/sessions/attention",
  ])("denies %s", (command) => {
    expect(supervisorBoundaryDenial("Bash", { command })?.class).toBe("deny");
  });
});
