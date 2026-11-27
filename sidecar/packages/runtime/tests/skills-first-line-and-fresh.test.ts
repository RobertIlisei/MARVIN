import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skills-fresh-data-"));

import { afterAll, describe, expect, it } from "vitest";

import { readSessionMeta, updateSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { setEnabledSkills } from "../src/skill-enablement";
import {
  noteLastEdit,
  noteSkillRun,
  parseSkillsBrief,
  readProjectAfterLastEdit,
  seedTurnSkills,
  skillCloseFacts,
} from "../src/skill-brief";

const posture = { model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
const project = "p-skills-fresh";

afterAll(() => rmSync(process.env.MARVIN_DATA_DIR as string, { recursive: true, force: true }));

// 2026-11-28 — a real brief's `Skills first:` line names its skills WITHOUT backticks,
// which the parser read as naming nothing; only the project's `first` setting seeded.
describe("a `Skills first:` line with bare names", () => {
  const BRIEF = [
    "Do the screen.",
    "",
    "Skills: `ponytail`, `agricore-design-system`, `impeccable`, `unslop`, `ux-review`, `ux-laws-auditor`, `apple-design`, `frontend-design`, `pr-review`",
    "Skills first: ponytail, agricore-design-system, impeccable, unslop, ux-review, ux-laws-auditor, apple-design, frontend-design",
    "(27.11 owner: every UI tab runs these before the first edit.)",
    "",
    "Steps: ...",
  ].join("\n");
  const FIRST = ["ponytail", "agricore-design-system", "impeccable", "unslop", "ux-review", "ux-laws-auditor", "apple-design", "frontend-design"];

  it("marks every bare name on the line as a start skill, in order, never pr-review", () => {
    const b = parseSkillsBrief(BRIEF)!;
    expect(b.first).toEqual(FIRST);
    expect(b.required).toContain("pr-review");
    expect(b.first).not.toContain("pr-review");
  });

  it("a bare name the brief does not also list under `Skills:` is not added", () => {
    const b = parseSkillsBrief("Skills: `ponytail`\nSkills first: ponytail, stranger\n")!;
    expect(b.required).toEqual(["ponytail"]);
    expect(b.first).toEqual(["ponytail"]);
  });

  it("prose after the label names nothing", () => {
    const b = parseSkillsBrief("Skills: `ponytail`\nSkills first: whatever is needed, then the rest\n")!;
    expect(b.first).toEqual([]);
  });

  it("seeds first = the brief's list united with the project's `first`, deduplicated, brief order kept", () => {
    const w = mkdtempSync(join(tmpdir(), "marvin-skill-first-union-"));
    try {
      mkdirSync(join(w, ".marvin"), { recursive: true });
      writeFileSync(join(w, ".marvin", "skills.json"), JSON.stringify({ first: ["ponytail", "pr-review", "not-in-brief"] }));
      upsertSessionMeta(project, "s-first-union", { workDir: w, tree: { mode: "shared" }, posture });
      const r = seedTurnSkills({ projectId: project, sessionId: "s-first-union", message: BRIEF, turnId: "t", isFirstTurn: () => true, workDir: w });
      expect(r.seeded).toBe(true);
      expect(readSessionMeta(project, "s-first-union")?.skills?.first).toEqual([...FIRST, "pr-review"]);
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });

  it("seeds the brief's list even when the project has no setting", () => {
    upsertSessionMeta(project, "s-first-nosetting", { workDir: "/w", tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: project, sessionId: "s-first-nosetting", message: BRIEF, turnId: "t", isFirstTurn: () => true });
    expect(readSessionMeta(project, "s-first-nosetting")?.skills?.first).toEqual(FIRST);
  });
});

// 2026-11-28 — closing reviews must be fresh: `after_last_edit` in skills.json.
describe("after_last_edit (fresh closing reviews)", () => {
  const w = mkdtempSync(join(tmpdir(), "marvin-skill-fresh-"));
  mkdirSync(join(w, ".marvin"), { recursive: true });
  const put = (v: unknown) => writeFileSync(join(w, ".marvin", "skills.json"), typeof v === "string" ? v : JSON.stringify(v));
  const seed = (id: string) => {
    upsertSessionMeta(project, id, { workDir: w, tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: project, sessionId: id, message: "Skills: `ponytail`, `pr-review`", turnId: "t", isFirstTurn: () => true });
  };
  afterAll(() => rmSync(w, { recursive: true, force: true }));

  it("reads at a validating boundary: a clean name list, anything else is none", () => {
    expect(readProjectAfterLastEdit(w)).toEqual([]);
    put("{not json");
    expect(readProjectAfterLastEdit(w)).toEqual([]);
    for (const bad of ["pr-review", 1, null, true, {}]) {
      put({ after_last_edit: bad });
      expect(readProjectAfterLastEdit(w), JSON.stringify(bad)).toEqual([]);
    }
    put({ after_last_edit: ["PR-Review", 7, null, "a b", "../../x", "pr-review", ...Array.from({ length: 40 }, (_, i) => `s${i}`)] });
    const got = readProjectAfterLastEdit(w);
    expect(got[0]).toBe("pr-review");
    expect(got.filter((n) => n === "pr-review")).toHaveLength(1);
    expect(got.length).toBeLessThanOrEqual(20);
    expect(got).not.toContain("a b");
  });

  it("a skill run before the last edit is stale; run after it is fresh", () => {
    put({ after_last_edit: ["pr-review"] });
    seed("fresh-1");
    noteSkillRun(project, "fresh-1", "pr-review", "2026-11-28T10:00:00.000Z");
    noteSkillRun(project, "fresh-1", "ponytail", "2026-11-28T10:00:00.000Z");
    noteLastEdit(project, "fresh-1", "2026-11-28T10:05:00.000Z");
    const stale = skillCloseFacts(project, "fresh-1", w)!;
    expect(stale.used).toEqual(["ponytail"]);
    expect(stale.stale).toEqual([{ name: "pr-review", ranAt: "2026-11-28T10:00:00.000Z", editAt: "2026-11-28T10:05:00.000Z" }]);
    noteSkillRun(project, "fresh-1", "pr-review", "2026-11-28T10:06:00.000Z");
    const fresh = skillCloseFacts(project, "fresh-1", w)!;
    expect([...fresh.used].sort()).toEqual(["ponytail", "pr-review"]);
    expect(fresh.stale ?? []).toEqual([]);
  });

  it("skills not in the list are unaffected by a later edit; setting absent changes nothing", () => {
    put({ after_last_edit: ["pr-review"] });
    seed("fresh-2");
    noteSkillRun(project, "fresh-2", "ponytail", "2026-11-28T10:00:00.000Z");
    noteLastEdit(project, "fresh-2", "2026-11-28T11:00:00.000Z");
    expect(skillCloseFacts(project, "fresh-2", w)!.used).toEqual(["ponytail"]);
    put({ enabled: [] });
    seed("fresh-3");
    noteSkillRun(project, "fresh-3", "pr-review", "2026-11-28T10:00:00.000Z");
    noteLastEdit(project, "fresh-3", "2026-11-28T11:00:00.000Z");
    const f = skillCloseFacts(project, "fresh-3", w)!;
    expect(f.used).toEqual(["pr-review"]);
    expect(f.stale ?? []).toEqual([]);
  });

  it("no edit at all leaves a run fresh, and the last run time is kept on every run", () => {
    put({ after_last_edit: ["pr-review"] });
    seed("fresh-4");
    noteSkillRun(project, "fresh-4", "pr-review", "2026-11-28T10:00:00.000Z");
    expect(skillCloseFacts(project, "fresh-4", w)!.used).toEqual(["pr-review"]);
    noteSkillRun(project, "fresh-4", "pr-review", "2026-11-28T10:30:00.000Z");
    expect(readSessionMeta(project, "fresh-4")?.skillsRunAt?.["pr-review"]).toBe("2026-11-28T10:30:00.000Z");
    expect(readSessionMeta(project, "fresh-4")?.skillsRun).toEqual(["pr-review"]);
  });

  it("a legacy run with no recorded time cannot be shown fresh once an edit exists", () => {
    put({ after_last_edit: ["pr-review"] });
    seed("fresh-5");
    updateSessionMeta(project, "fresh-5", { skillsRun: ["pr-review"] });
    noteLastEdit(project, "fresh-5", "2026-11-28T11:00:00.000Z");
    expect(skillCloseFacts(project, "fresh-5", w)!.stale?.map((s) => s.name)).toEqual(["pr-review"]);
  });

  it("an Edit/Write inside the tree records the edit time; .marvin/ and outside paths do not; a Skill run records its time", async () => {
    const { createTurnDesignContext, recordAllowedTool } = await import("../src/design-hooks");
    put({ after_last_edit: ["pr-review"] });
    seed("fresh-hook");
    const ctx = createTurnDesignContext("t-hook", w, { spineSession: { projectId: project, sessionId: "fresh-hook" } });
    recordAllowedTool(ctx, "Skill", { skill: "pr-review" });
    expect(readSessionMeta(project, "fresh-hook")?.skillsRunAt?.["pr-review"]).toBeTypeOf("string");
    recordAllowedTool(ctx, "Write", { file_path: join(w, ".marvin", "plans", "p.md"), content: "x" });
    recordAllowedTool(ctx, "Edit", { file_path: "/tmp/elsewhere.txt", old_string: "a", new_string: "b" });
    expect(readSessionMeta(project, "fresh-hook")?.lastEditAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
    recordAllowedTool(ctx, "Edit", { file_path: join(w, "src", "a.ts"), old_string: "a", new_string: "b" });
    expect(readSessionMeta(project, "fresh-hook")?.lastEditAt).toBeTypeOf("string");
    expect(skillCloseFacts(project, "fresh-hook", w)!.stale?.map((s) => s.name)).toEqual(["pr-review"]);
  });

  it("the Skills pane's own write keeps `after_last_edit`", () => {
    put({ enabled: ["a"], after_last_edit: ["pr-review"] });
    setEnabledSkills(w, ["a", "b"]);
    expect(readProjectAfterLastEdit(w)).toEqual(["pr-review"]);
  });
});
