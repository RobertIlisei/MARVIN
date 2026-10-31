import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRoleEfforts, resolveRoleEffort, roleEffortsPath, setRoleEffort } from "@marvin/runtime/role-efforts";
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

// The supervisor's model could be picked inline; its effort could not be
// chosen at all (a wake set no `effort`, so it ran on the SDK default). These
// pin the contract: one user-click write path, persisted across a restart,
// shown on the status and the ledger, valid only for the model it will run on,
// and never reachable from a supervisor verb.

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
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-effort-"));
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
const effortLines = (projectId: string) => readLedger(projectId).filter((e) => e.kind === "control" && e.verb === "effort");

describe("PATCH {role, effort} — the user's click", () => {
  it("stores the effort in its own file and leaves the model map alone", async () => {
    writeRoleModels({ supervisor: "claude-opus-5-5", scout: "claude-sonnet-5-5" });
    const r = await rolesRoute.PATCH(patch({ role: "supervisor", effort: "xhigh" }));
    expect(r.status).toBe(200);
    expect(readRoleEfforts()).toEqual({ supervisor: "xhigh" });
    expect(readRoleModels()).toEqual({ supervisor: "claude-opus-5-5", scout: "claude-sonnet-5-5" });
    expect(JSON.parse(readFileSync(roleEffortsPath(), "utf8")).efforts).toEqual({ supervisor: "xhigh" });
  });

  it("null puts it back on Default", async () => {
    setRoleEffort("supervisor", "high");
    expect((await rolesRoute.PATCH(patch({ role: "supervisor", effort: null }))).status).toBe(200);
    expect(readRoleEfforts()).toEqual({});
  });

  it("refuses a non-rung, a role that has no effort, and a body that sets both, and writes nothing", async () => {
    for (const body of [
      { role: "supervisor", effort: "ludicrous" },
      { role: "supervisor", effort: 3 },
      { role: "scout", effort: "high" },
      { role: "supervisor", effort: "high", model: "claude-opus-5-5" },
    ]) {
      expect((await rolesRoute.PATCH(patch(body))).status).toBe(400);
    }
    expect(readRoleEfforts()).toEqual({});
    expect(readRoleModels()).toEqual({});
  });

  it("needs the marvin client header", async () => {
    const req = new NextRequest("http://localhost:3030/x", { method: "PATCH", body: JSON.stringify({ role: "supervisor", effort: "high" }) });
    expect((await rolesRoute.PATCH(req)).status).toBe(403);
    expect(readRoleEfforts()).toEqual({});
  });

  it("survives a restart: a fresh read of the file returns the choice", () => {
    setRoleEffort("supervisor", "medium");
    resetSupervisorStateForTests();
    expect(readRoleEfforts()).toEqual({ supervisor: "medium" });
  });

  it("a hand-edited file with a bad rung costs nothing but that rung", () => {
    setRoleEffort("supervisor", "high");
    writeFileSync(roleEffortsPath(), JSON.stringify({ version: 1, efforts: { supervisor: "nope", scout: "high" } }));
    expect(readRoleEfforts()).toEqual({});
  });
});

describe("an effort change reaches every enabled supervisor", () => {
  it("bumps the revision and ledgers the effort, so an open Settings block refetches", async () => {
    enable("proj");
    const before = getSupervisorState("proj").revision;
    await rolesRoute.PATCH(patch({ role: "supervisor", effort: "high" }));
    expect(getSupervisorState("proj").revision).toBeGreaterThan(before);
    const lines = effortLines("proj");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.reason).toMatch(/high/);
    expect(lines[0]?.effort).toBe("high");
  });

  it("a write that changes nothing is silent", async () => {
    enable("proj");
    setRoleEffort("supervisor", "high");
    const before = getSupervisorState("proj").revision;
    await rolesRoute.PATCH(patch({ role: "supervisor", effort: "high" }));
    expect(getSupervisorState("proj").revision).toBe(before);
    expect(effortLines("proj")).toHaveLength(0);
  });
});

describe("which efforts a model can run", () => {
  it("offers low, medium and high on any model; xhigh and max only on Opus", () => {
    expect(resolveRoleEffort("supervisor", "claude-sonnet-5-5").options).toEqual(["low", "medium", "high"]);
    expect(resolveRoleEffort("supervisor", "claude-opus-5-5").options).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(resolveRoleEffort("supervisor", null).options).toEqual(["low", "medium", "high"]);
  });

  it("a stored rung the model cannot run falls back to Default and says so — it is not quietly lowered", () => {
    setRoleEffort("supervisor", "max");
    expect(resolveRoleEffort("supervisor", "claude-sonnet-5-5")).toMatchObject({ choice: "max", resolved: null, fellBack: true });
    expect(resolveRoleEffort("supervisor", "claude-opus-5-5")).toMatchObject({ choice: "max", resolved: "max", fellBack: false });
  });

  it("Default is Default: no choice, nothing resolved, no fallback", () => {
    expect(resolveRoleEffort("supervisor", "claude-sonnet-5-5")).toMatchObject({ choice: null, resolved: null, fellBack: false });
  });
});

describe("the status carries the effort beside the model", () => {
  it("is the stored choice, the options for the model it will run on, and whether it fell back", async () => {
    expect((await supervisorModelInfo()).effort).toEqual({ choice: null, resolved: null, options: ["low", "medium", "high"], fellBack: false });
    writeRoleModels({ supervisor: "claude-opus-5-5" });
    setRoleEffort("supervisor", "xhigh");
    expect((await supervisorModelInfo()).effort).toEqual({ choice: "xhigh", resolved: "xhigh", options: ["low", "medium", "high", "xhigh", "max"], fellBack: false });
    writeRoleModels({ supervisor: "claude-sonnet-5-5" });
    expect((await supervisorModelInfo()).effort).toEqual({ choice: "xhigh", resolved: null, options: ["low", "medium", "high"], fellBack: true });
  });
});

describe("the supervisor cannot change its own effort", () => {
  it("none of its verbs names an effort, a model or a role", () => {
    const names = supervisorToolDefs({} as never).map((t) => t.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => /effort|thinking|model|role/i.test(n))).toEqual([]);
  });

  it("its verb source never reaches either store", () => {
    const src = readFileSync(path.join(__dirname, "../packages/runtime/src/supervisor-mcp.ts"), "utf8");
    expect(src).not.toMatch(/setRoleEffort|role-efforts|writeRoleEfforts|setRoleModel|writeRoleModels|role-models/);
  });
});
