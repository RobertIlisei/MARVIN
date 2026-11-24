import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before any import that reads the data dir: session metas and the practice rows live there.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skills-first-data-"));

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTurnDesignContext,
  type DesignTurnContext,
  recordAllowedTool,
  runDesignHooks,
} from "../src/design-hooks";
import { __resetBuiltinCacheForTests, BUILTIN_RULE_IDS, ensureBuiltinRules, readRules, updateRule } from "../src/practice";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { seedTurnSkills } from "../src/skill-brief";
import { saveSlashCommands } from "../src/slash-commands";

// ADR-0138 addendum: a start skill gates the session's first change.
const posture = { model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
const project = "p-skills-first";
const root = mkdtempSync(join(tmpdir(), "marvin-skills-first-root-"));
const prev = process.env.MARVIN_DESIGN_HOOKS;
let n = 0;

afterAll(() => {
  rmSync(process.env.MARVIN_DATA_DIR as string, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function session(brief: string | null): { sessionId: string; ctx: () => DesignTurnContext } {
  const sessionId = `s${++n}`;
  upsertSessionMeta(project, sessionId, { workDir: root, tree: { mode: "shared" }, posture });
  if (brief) seedTurnSkills({ projectId: project, sessionId, message: brief, turnId: "t", isFirstTurn: () => true, workDir: root });
  // A fresh context per turn, as the runner makes one: nothing but the meta carries over.
  return { sessionId, ctx: () => createTurnDesignContext(`t-${++n}`, root, { spineSession: { projectId: project, sessionId } }) };
}

const edit = (rel = "src/a.ts") => ({ toolName: "Edit", toolInput: { file_path: join(root, rel), old_string: "a", new_string: "b" } });
const commit = { toolName: "Bash", toolInput: { command: 'git commit -m "x"' } };
const run = (c: DesignTurnContext, call: { toolName: string; toolInput: Record<string, unknown> }, mode: "enforce" | "measure" = "enforce", agentId?: string) =>
  runDesignHooks({ ctx: c, ...call, mode, ...(agentId ? { agentId } : {}) });
const ran = (c: DesignTurnContext, skill: string) => recordAllowedTool(c, "Skill", { skill });

beforeEach(() => {
  delete process.env.MARVIN_DESIGN_HOOKS;
  ensureBuiltinRules();
  updateRule("builtin:skills-first", { tier: "deny", status: "active" });
  __resetBuiltinCacheForTests();
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DESIGN_HOOKS;
  else process.env.MARVIN_DESIGN_HOOKS = prev;
});

const BRIEF = "Skills: `ponytail` (full, first), `ponytail-review`, `pr-review`";

describe("the skills-first gate", () => {
  it("has a built-in row, native tier deny", () => {
    expect(BUILTIN_RULE_IDS).toContain("builtin:skills-first");
    expect(readRules().find((r) => r.id === "builtin:skills-first")?.tier).toBe("deny");
  });

  it("refuses the first Edit and the first commit, naming the start skill to run now", () => {
    const { ctx } = session(BRIEF);
    const e = run(ctx(), edit());
    expect(e?.behavior).toBe("deny");
    expect(e?.message).toContain("`ponytail`");
    expect(e?.message).toContain('Skill { skill: "ponytail" }');
    expect(e?.message).not.toContain("`pr-review`");
    expect(run(ctx(), { toolName: "Write", toolInput: { file_path: join(root, "new.ts"), content: "x" } })?.behavior).toBe("deny");
    const c = run(session(BRIEF).ctx(), commit);
    expect(c?.behavior).toBe("deny");
    expect(c?.message).toContain("`ponytail`");
  });

  it("never refuses a read, a search, the graph, TodoWrite, Skill itself, memory or backlog tools", () => {
    const { ctx } = session(BRIEF);
    const c = ctx();
    for (const call of [
      { toolName: "Read", toolInput: { file_path: join(root, "src/a.ts") } },
      { toolName: "Grep", toolInput: { pattern: "x", path: root } },
      { toolName: "Glob", toolInput: { pattern: "**/*.ts" } },
      { toolName: "Bash", toolInput: { command: "git status" } },
      { toolName: "mcp__marvin-graph__graph_search", toolInput: { query: "x" } },
      { toolName: "TodoWrite", toolInput: { todos: [] } },
      { toolName: "Skill", toolInput: { skill: "ponytail" } },
      { toolName: "mcp__marvin-memory__remember", toolInput: { name: "x" } },
      { toolName: "mcp__marvin-backlog__backlog_add", toolInput: { title: "x" } },
    ]) {
      expect(run(c, call), call.toolName).toBeNull();
    }
  });

  it("does not refuse a write outside the session's checkout", () => {
    const { ctx } = session(BRIEF);
    expect(run(ctx(), { toolName: "Write", toolInput: { file_path: "/tmp/elsewhere/notes.md", content: "x" } })).toBeNull();
  });

  it("running the start skill lifts it, in the same turn and in a later one", () => {
    const { ctx } = session(BRIEF);
    const c = ctx();
    expect(run(c, edit())?.behavior).toBe("deny");
    ran(c, "ponytail:ponytail");
    expect(run(c, edit())).toBeNull();
    expect(run(ctx(), commit)).toBeNull();
  });

  it("only a start skill gates: another named skill that has not run does not", () => {
    const { ctx } = session(BRIEF);
    const c = ctx();
    ran(c, "ponytail");
    expect(run(c, edit())).toBeNull();
  });

  it("brakes after two refusals per session, counted on the meta so a restart does not reset it", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { sessionId, ctx } = session(BRIEF);
    expect(run(ctx(), edit())?.behavior).toBe("deny");
    expect(run(ctx(), edit())?.behavior).toBe("deny");
    expect(readSessionMeta(project, sessionId)?.skills?.firstBlocks).toBe(2);
    // A new turn context (a restart builds one the same way) is still past the brake.
    expect(run(ctx(), edit())).toBeNull();
    expect(run(ctx(), commit)).toBeNull();
    const kinds = log.mock.calls.map((x) => String(x[0])).join("\n");
    log.mockRestore();
    expect(kinds).toContain("skills.first.block");
    expect(kinds).toContain("skills.first.bypass");
  });

  it("a start skill the project cannot invoke is not blocked on", () => {
    const { ctx } = session("Skills: `zzz-not-installed` (first)");
    // No catalog captured yet: availability is unknown, so it still blocks (the close gate's rule).
    expect(run(ctx(), edit())?.behavior).toBe("deny");
    const s = session("Skills: `zzz-not-installed` (first)");
    saveSlashCommands(project, [{ name: "ponytail:ponytail", description: "", argumentHint: "" }]);
    expect(run(s.ctx(), edit())).toBeNull();
    // Of two start skills, only the invokable one still blocks.
    const t = session("Skills: `zzz-not-installed` (first), `ponytail` (first)");
    const d = run(t.ctx(), edit());
    expect(d?.message).toContain("`ponytail`");
    expect(d?.message).not.toContain("zzz-not-installed");
  });

  it("a session with no start skill, or no seeded list, is never touched", () => {
    expect(run(session("Skills: `ponytail`, `pr-review`").ctx(), edit())).toBeNull();
    expect(run(session(null).ctx(), edit())).toBeNull();
    expect(run(session(null).ctx(), commit)).toBeNull();
  });

  it("a session seeded before this build (no `first` on the meta) is never touched", () => {
    const { sessionId, ctx } = session(null);
    upsertSessionMeta(project, sessionId, { workDir: root, tree: { mode: "shared" }, posture });
    // Written the way ADR-0138's build wrote it: required and seededAt only.
    const metaPath = join(process.env.MARVIN_DATA_DIR as string, "sessions", project, `${sessionId}.meta.json`);
    const raw = JSON.parse(readFileSync(metaPath, "utf-8"));
    raw.skills = { required: ["ponytail"], seededAt: "2026-11-24T08:00:00.000Z" };
    writeFileSync(metaPath, JSON.stringify(raw));
    expect(run(ctx(), edit())).toBeNull();
  });

  it("leaves a subagent's calls to their own rules", () => {
    const { ctx } = session(BRIEF);
    expect(run(ctx(), edit(), "enforce", "agent-1")).toBeNull();
  });

  it("measure mode logs and lets it through; the row can lower or switch it off", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { ctx } = session(BRIEF);
    expect(run(ctx(), edit(), "measure")).toBeNull();
    expect(log.mock.calls.map((x) => String(x[0])).join("\n")).toContain("skills.first.measured");
    log.mockRestore();

    updateRule("builtin:skills-first", { tier: "nudge" });
    __resetBuiltinCacheForTests();
    expect(run(session(BRIEF).ctx(), edit())).toBeNull();

    updateRule("builtin:skills-first", { tier: "deny", status: "retired" });
    __resetBuiltinCacheForTests();
    expect(run(session(BRIEF).ctx(), edit())).toBeNull();
  });
});
