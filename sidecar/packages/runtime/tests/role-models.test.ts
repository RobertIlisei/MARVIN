import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-0126 — every helper role resolves against the ACTIVE provider's
// catalogue. The catalogue and provider are mocked so each case states the
// world it runs in.
const state = vi.hoisted(() => ({
  provider: "anthropic" as "anthropic" | "openrouter",
  models: [] as Array<{ id: string; tier: string; live: boolean }>,
}));

vi.mock("../src/models", () => ({
  activeProvider: () => state.provider,
  ensureProviderModelId: (id: string | null) => id ?? null,
  latestForTier: async (tier: string) => state.models.find((m) => m.tier === tier)?.id ?? null,
  listModelsCached: async () => ({ models: state.models, source: "anthropic-api", error: null, fetchedAt: "" }),
}));

const {
  readRoleModels,
  resolveRoleModel,
  roleModelsPath,
  roleTurnOverrides,
  validateRoleModels,
  writeRoleModels,
} = await import("../src/role-models");

const ANTHROPIC = [
  { id: "claude-opus-5-5", tier: "opus", live: true },
  { id: "claude-sonnet-5-5", tier: "sonnet", live: true },
  { id: "claude-haiku-5-5", tier: "haiku", live: true },
];
const OPENROUTER = [
  { id: "anthropic/claude-sonnet-5.5", tier: "sonnet", live: true },
  { id: "anthropic/claude-haiku-5.5", tier: "haiku", live: true },
  { id: "qwen/qwen3-coder", tier: "other", live: true },
];

let prevDataDir: string | undefined;
beforeEach(() => {
  prevDataDir = process.env.MARVIN_DATA_DIR;
  process.env.MARVIN_DATA_DIR = mkdtempSync(path.join(tmpdir(), "role-models-"));
  state.provider = "anthropic";
  state.models = ANTHROPIC;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prevDataDir;
});

describe("defaults resolve against the active provider — no hardcoded id", () => {
  it("tier roles take the provider's newest of that tier", async () => {
    expect(await resolveRoleModel("graphExtractor")).toBe("claude-haiku-5-5");
    expect(await resolveRoleModel("commitMessage")).toBe("claude-haiku-5-5");
    expect(await resolveRoleModel("sessionAuditor")).toBe("claude-sonnet-5-5");
    state.provider = "openrouter";
    state.models = OPENROUTER;
    expect(await resolveRoleModel("graphExtractor")).toBe("anthropic/claude-haiku-5.5");
    expect(await resolveRoleModel("practiceDraft")).toBe("anthropic/claude-sonnet-5.5");
  });

  it("scout and background inherit; the server advisor is off", async () => {
    expect(await resolveRoleModel("scout")).toBe("inherit");
    expect(await resolveRoleModel("backgroundModel")).toBe("inherit");
    expect(await resolveRoleModel("serverAdvisor")).toBeNull();
  });
});

describe("a user's pick", () => {
  it("wins when the active catalogue lists it — any vendor, not just Claude", async () => {
    state.provider = "openrouter";
    state.models = OPENROUTER;
    writeRoleModels({ scout: "qwen/qwen3-coder" });
    expect(await resolveRoleModel("scout")).toBe("qwen/qwen3-coder");
  });

  it("falls back to the default when the provider changed under it", async () => {
    writeRoleModels({ graphExtractor: "claude-haiku-5-5" });
    state.provider = "openrouter";
    state.models = OPENROUTER;
    expect(await resolveRoleModel("graphExtractor")).toBe("anthropic/claude-haiku-5.5");
  });

  it("is kept on a fallback (non-live) catalogue, which cannot prove it stale", async () => {
    state.models = ANTHROPIC.map((m) => ({ ...m, live: false }));
    writeRoleModels({ scout: "claude-some-new-model" });
    expect(await resolveRoleModel("scout")).toBe("claude-some-new-model");
  });

  it("turns the server advisor on, on Anthropic only", async () => {
    writeRoleModels({ serverAdvisor: "claude-opus-5-5" });
    expect(await resolveRoleModel("serverAdvisor")).toBe("claude-opus-5-5");
    state.provider = "openrouter";
    state.models = OPENROUTER;
    expect(await resolveRoleModel("serverAdvisor")).toBeNull();
  });
});

describe("validation at the write and read boundary", () => {
  it("refuses unknown roles, non-strings, junk ids, and off where off means nothing", () => {
    const v = validateRoleModels({ nope: "x", scout: 3, graphExtractor: "rm -rf /", sessionAuditor: "off" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors).toHaveLength(4);
  });

  it("accepts ids, off for the server advisor, and null as reset", () => {
    const v = validateRoleModels({ scout: "anthropic/claude-haiku-5.5", serverAdvisor: "off", graphExtractor: null });
    expect(v).toEqual({ ok: true, roles: { scout: "anthropic/claude-haiku-5.5", serverAdvisor: "off" } });
  });

  it("a hand-edited file keeps its good entries and drops the bad", () => {
    writeFileSync(roleModelsPath(), JSON.stringify({ version: 1, roles: { scout: "claude-haiku-5-5", bogus: "x" } }));
    expect(readRoleModels()).toEqual({ scout: "claude-haiku-5-5" });
  });

  it("an unreadable file is the defaults, never a throw", () => {
    writeFileSync(roleModelsPath(), "{not json");
    expect(readRoleModels()).toEqual({});
  });
});

describe("roleTurnOverrides — the per-turn contract", () => {
  it("off: the advisor tool is disabled, so a Claude Code /advisor setting cannot leak in", () => {
    expect(roleTurnOverrides("inherit", null)).toEqual({
      env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" },
      settings: {},
    });
  });

  it("on: advisorModel goes to the flag layer and the tool is not disabled", () => {
    const o = roleTurnOverrides("inherit", "claude-fable-5-1");
    expect(o.settings).toEqual({ advisorModel: "claude-fable-5-1" });
    expect(o.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBeUndefined();
  });

  it("a background pick points Claude Code's haiku alias at it; inherit sets nothing", () => {
    expect(roleTurnOverrides("anthropic/claude-haiku-5.5", null).env).toMatchObject({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-5.5",
      ANTHROPIC_SMALL_FAST_MODEL: "anthropic/claude-haiku-5.5",
    });
    expect(roleTurnOverrides("inherit", null).env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });
});
