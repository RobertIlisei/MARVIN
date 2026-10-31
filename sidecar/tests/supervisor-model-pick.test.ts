import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRoleModels, writeRoleModels } from "@marvin/runtime/role-models";
import { readLedger } from "@marvin/runtime/supervisor-ledger";
import { supervisorModelInfo } from "@marvin/runtime/supervisor-status";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  resetSupervisorStateForTests,
} from "@marvin/runtime/supervisor-state";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { supervisorToolDefs } from "../packages/runtime/src/supervisor-mcp";
import * as rolesRoute from "../src/app/api/models/roles/route";

// The user could not change the supervisor's model. The save path worked; the
// Settings block never found out (a role-model write moved no supervisor
// revision, so the status the block reads stayed stale), the Models dialog
// buried the row, and the wake line named no model. These pin the repaired
// contract: one single-key write, both write paths announce a change to every
// enabled supervisor, the status carries the stored choice, and a wake says
// which model it ran on.

vi.mock("../packages/runtime/src/models", () => ({
  activeProvider: () => "anthropic",
  ensureProviderModelId: (id: string | null) => id ?? null,
  latestForTier: async (tier: string) => ({ opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" })[tier] ?? null,
  listModelsCached: async () => ({
    models: [
      { id: "claude-opus-5-5", displayName: "Opus 5.5", tier: "opus", live: true },
      { id: "claude-sonnet-5-5", displayName: "Sonnet 5.5", tier: "sonnet", live: true },
    ],
    source: "anthropic-api",
    error: null,
    fetchedAt: "",
  }),
}));

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-model-"));
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

const enable = (projectId: string) => applySupervisorAction({ projectId, action: "start" }, currentSupervisorToken());
const patch = (body: unknown) =>
  new NextRequest("http://localhost:3030/x", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-marvin-client": "1" },
    body: JSON.stringify(body),
  });
const put = (roles: unknown) =>
  new NextRequest("http://localhost:3030/x", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-marvin-client": "1" },
    body: JSON.stringify({ roles }),
  });
const modelLines = (projectId: string) => readLedger(projectId).filter((e) => e.kind === "control" && e.verb === "model");

describe("PATCH — one role, one key", () => {
  it("writes only that role and leaves every other choice alone", async () => {
    writeRoleModels({ scout: "claude-haiku-5-5" });
    const r = await rolesRoute.PATCH(patch({ role: "supervisor", model: "claude-opus-5-5" }));
    expect(r.status).toBe(200);
    expect(readRoleModels()).toEqual({ scout: "claude-haiku-5-5", supervisor: "claude-opus-5-5" });
  });

  it("null puts the role back on its default", async () => {
    writeRoleModels({ supervisor: "claude-opus-5-5", scout: "claude-haiku-5-5" });
    const r = await rolesRoute.PATCH(patch({ role: "supervisor", model: null }));
    expect(r.status).toBe(200);
    expect(readRoleModels()).toEqual({ scout: "claude-haiku-5-5" });
  });

  it("refuses an unknown role, a non-id, and a missing model, and writes nothing", async () => {
    for (const body of [{ role: "root", model: "claude-opus-5-5" }, { role: "supervisor", model: "has spaces" }, { role: "supervisor" }, { model: "claude-opus-5-5" }]) {
      expect((await rolesRoute.PATCH(patch(body))).status).toBe(400);
    }
    expect(readRoleModels()).toEqual({});
  });

  it("needs the marvin client header", async () => {
    const req = new NextRequest("http://localhost:3030/x", { method: "PATCH", body: JSON.stringify({ role: "supervisor", model: "claude-opus-5-5" }) });
    expect((await rolesRoute.PATCH(req)).status).toBe(403);
    expect(readRoleModels()).toEqual({});
  });
});

describe("a supervisor model change reaches every enabled supervisor", () => {
  it("PATCH bumps the revision and ledgers the change, so an open Settings block refetches", async () => {
    enable("proj");
    const before = getSupervisorState("proj").revision;
    await rolesRoute.PATCH(patch({ role: "supervisor", model: "claude-opus-5-5" }));
    expect(getSupervisorState("proj").revision).toBeGreaterThan(before);
    const lines = modelLines("proj");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.reason).toMatch(/claude-opus-5-5/);
  });

  it("the Models dialog's PUT does the same when it changes the supervisor row", async () => {
    enable("proj");
    const before = getSupervisorState("proj").revision;
    await rolesRoute.PUT(put({ supervisor: "claude-opus-5-5" }));
    expect(getSupervisorState("proj").revision).toBeGreaterThan(before);
    expect(modelLines("proj")).toHaveLength(1);
  });

  it("a write that leaves the supervisor's choice alone is silent", async () => {
    enable("proj");
    writeRoleModels({ supervisor: "claude-opus-5-5" });
    const before = getSupervisorState("proj").revision;
    await rolesRoute.PUT(put({ supervisor: "claude-opus-5-5", scout: "claude-haiku-5-5" }));
    await rolesRoute.PATCH(patch({ role: "scout", model: "claude-sonnet-5-5" }));
    expect(getSupervisorState("proj").revision).toBe(before);
    expect(modelLines("proj")).toHaveLength(0);
  });

  it("a project whose supervisor is off is not touched", async () => {
    enable("on");
    applySupervisorAction({ projectId: "off", action: "start" }, currentSupervisorToken());
    applySupervisorAction({ projectId: "off", action: "disable" }, currentSupervisorToken());
    const before = getSupervisorState("off").revision;
    await rolesRoute.PATCH(patch({ role: "supervisor", model: "claude-opus-5-5" }));
    expect(getSupervisorState("off").revision).toBe(before);
    expect(modelLines("off")).toHaveLength(0);
    expect(modelLines("on")).toHaveLength(1);
  });
});

describe("the supervisor cannot change its own model", () => {
  it("none of its verbs names a model or a role: the pick is the user's click, in the app", () => {
    const names = supervisorToolDefs({} as never).map((t) => t.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => /model|role/i.test(n))).toEqual([]);
  });

  it("set_posture, the one verb that carries a model, takes it for a tab, never for the supervisor role", async () => {
    const src = (await import("node:fs")).readFileSync(path.join(__dirname, "../packages/runtime/src/supervisor-mcp.ts"), "utf8");
    expect(src).not.toMatch(/setRoleModel|writeRoleModels|role-models/);
  });
});

describe("the status says what was chosen, not only what it resolved to", () => {
  it("choice is null on the default and the stored id once picked", async () => {
    expect(await supervisorModelInfo()).toMatchObject({ resolved: expect.stringMatching(/^claude-sonnet-5/), choice: null });
    writeRoleModels({ supervisor: "claude-opus-5-5" });
    expect(await supervisorModelInfo()).toMatchObject({ resolved: "claude-opus-5-5", label: expect.stringContaining("Opus 5.5"), choice: "claude-opus-5-5" });
  });
});
