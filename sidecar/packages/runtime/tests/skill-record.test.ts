import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The rule table is read from the data dir; keep these tests off the user's real one.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skill-record-data-"));

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkPracticeRules,
  createTurnDesignContext,
  hasSkillRunInTree,
  hydrateSkillRuns,
  recordAllowedTool,
  resetShipReviewState,
  type ShipDiff,
} from "../src/design-hooks";
import { createSkillRule, readRules, writeRules } from "../src/practice";
import { slugifyWorkDir } from "../src/projects";

// ADR-0138 — every Skill run is recorded, and a practice rule may name any
// skill and the paths it applies to.
describe("any skill is recorded; a practice rule can require it on a path (ADR-0138)", () => {
  const cwd = "/proj-skills";
  const now = new Date().toISOString();
  const pathRule = (over: Record<string, unknown> = {}) => ({
    id: "r-skill-path",
    fingerprint: "manual:skill-on-paths",
    title: "Run ponytail on migrations",
    tier: "deny" as const,
    trigger: {
      tool: "^Bash$",
      field: "command",
      pattern: "\\bgit\\b[^|;&\\n]*\\bcommit\\b",
      paths: ["db/migrations/**"],
      requireSkillThisSession: ["ponytail"],
    },
    message: "practice rule: run ponytail before committing a migration.",
    status: "active" as const,
    scope: { projectId: null },
    provenance: { findingId: "manual", distinctSessions: 0, costTotal: 0, value: 0 },
    metrics: { fired: 0, lastFiredAt: null, bypasses: 0 },
    createdAt: now,
    acceptedAt: now,
    updatedAt: now,
    ...over,
  });
  const filesOf =
    (files: string[]) =>
    (): ShipDiff => ({ files, changedLines: 3 });
  const commit = { command: "git commit -m x" };

  beforeEach(() => resetShipReviewState());
  afterEach(() => {
    resetShipReviewState();
    writeRules([]);
  });

  it("records a skill that is not a review skill, under its normalised name, per checkout", () => {
    const ctx = createTurnDesignContext("t-sk-1", cwd);
    expect(hasSkillRunInTree(ctx, "ponytail")).toBe(false);
    recordAllowedTool(ctx, "Skill", { skill: "ponytail:Ponytail" });
    expect(hasSkillRunInTree(ctx, "ponytail")).toBe(true);
    expect(hasSkillRunInTree(ctx, "Marvin-Project-Local:PONYTAIL")).toBe(true);
    expect(hasSkillRunInTree(ctx, "ux-review")).toBe(false);
    // Another checkout does not inherit it.
    expect(hasSkillRunInTree(createTurnDesignContext("t-sk-2", cwd, { sessionCwd: "/other-tree" }), "ponytail")).toBe(false);
  });

  it("keeps the ADR-0104 freshness rule for the review skills while a non-review skill stays run for the session", () => {
    const a = createTurnDesignContext("t-sk-3", cwd);
    recordAllowedTool(a, "Skill", { skill: "pr-review" });
    recordAllowedTool(a, "Skill", { skill: "ponytail" });
    expect(hasSkillRunInTree(a, "pr-review")).toBe(true);
    recordAllowedTool(a, "Bash", { command: "git commit -m x" });
    const b = createTurnDesignContext("t-sk-4", cwd);
    expect(hasSkillRunInTree(b, "pr-review")).toBe(false); // a review before the last commit is stale in a later turn
    expect(hasSkillRunInTree(b, "ponytail")).toBe(true); // once per session is enough for any other skill
  });

  it("hydrates the record from what a persisted session says already ran; a review skill is not restored", () => {
    const ctx = createTurnDesignContext("t-sk-5", cwd);
    hydrateSkillRuns(ctx, ["ponytail", "pr-review", "ux-review"]);
    expect(hasSkillRunInTree(ctx, "ponytail")).toBe(true);
    expect(hasSkillRunInTree(ctx, "ux-review")).toBe(true);
    expect(hasSkillRunInTree(ctx, "pr-review")).toBe(false);
  });

  it("a rule with paths and a skill denies a matching commit, then allows it once the skill ran", () => {
    writeRules([pathRule()]);
    const ctx = createTurnDesignContext("t-sk-6", cwd);
    const hit = checkPracticeRules(ctx, "Bash", commit, false, filesOf(["db/migrations/002_add.sql", "src/a.ts"]));
    expect(hit.deny?.ruleId).toBe("r-skill-path");
    recordAllowedTool(ctx, "Skill", { skill: "ponytail:ponytail" });
    expect(checkPracticeRules(ctx, "Bash", commit, false, filesOf(["db/migrations/002_add.sql"])).deny).toBeNull();
  });

  it("does not fire when the commit touches none of the rule's paths, or is not a commit", () => {
    writeRules([pathRule()]);
    const ctx = createTurnDesignContext("t-sk-7", cwd);
    expect(checkPracticeRules(ctx, "Bash", commit, false, filesOf(["src/a.ts", "docs/x.md"])).deny).toBeNull();
    expect(checkPracticeRules(ctx, "Bash", { command: "ls db/migrations" }, false, filesOf(["db/migrations/1.sql"])).deny).toBeNull();
    // An unreadable diff never fires a rule that needs paths.
    expect(checkPracticeRules(ctx, "Bash", commit, false, () => null).deny).toBeNull();
  });

  it("keeps the ADR-0104 brake: two refusals a turn, then the commit passes and the bypass is counted", () => {
    writeRules([pathRule()]);
    const ctx = createTurnDesignContext("t-sk-8", cwd);
    const collect = filesOf(["db/migrations/002_add.sql"]);
    expect(checkPracticeRules(ctx, "Bash", commit, false, collect).deny).not.toBeNull();
    expect(checkPracticeRules(ctx, "Bash", commit, false, collect).deny).not.toBeNull();
    const third = checkPracticeRules(ctx, "Bash", commit, false, collect);
    expect(third.deny).toBeNull();
    expect(third.bypassed).toEqual(["r-skill-path"]);
  });

  it("a rule created through createSkillRule is the same row, validated, and enforces end to end", () => {
    expect(createSkillRule("p", { skills: [] })).toMatchObject({ ok: false });
    expect(createSkillRule("p", { skills: ["bad name!"] })).toMatchObject({ ok: false });
    expect(createSkillRule("p", { skills: ["ponytail"], paths: ["", "x".repeat(400)] })).toMatchObject({ ok: false });
    const made = createSkillRule(slugifyWorkDir(cwd), { skills: ["ponytail", "ponytail", "ponytail-review"], paths: ["db/**", "./docs/"] });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.rule.tier).toBe("deny");
    expect(made.rule.trigger?.requireSkillThisSession).toEqual(["ponytail", "ponytail-review"]);
    expect(made.rule.trigger?.paths).toEqual(["db/**", "docs"]);
    expect(made.rule.message).toContain('Skill { skill: "ponytail" }');
    const ctx = createTurnDesignContext("t-sk-9", cwd);
    expect(checkPracticeRules(ctx, "Bash", commit, false, filesOf(["db/seed.sql"])).deny?.ruleId).toBe(made.rule.id);
    recordAllowedTool(ctx, "Skill", { skill: "marvin-project-local:ponytail-review" });
    expect(checkPracticeRules(ctx, "Bash", commit, false, filesOf(["db/seed.sql"])).deny).toBeNull();
  });

  it("a rule whose lists hold nothing valid never fires instead of widening", () => {
    writeRules([pathRule({ trigger: { tool: "^Bash$", field: "command", pattern: "commit", paths: ["x".repeat(400)], requireSkillThisSession: ["ponytail"] } })]);
    const ctx = createTurnDesignContext("t-sk-10", cwd);
    expect(checkPracticeRules(ctx, "Bash", commit, false, filesOf(["anything.ts"])).deny).toBeNull();
  });

  it("clamps a rule file's own lists at the read boundary", () => {
    writeRules([
      pathRule({
        trigger: {
          tool: "^Bash$",
          paths: Array.from({ length: 60 }, (_, i) => `d${i}/**`).concat([7 as unknown as string]),
          requireSkillThisSession: ["ponytail", "bad name!", 5 as unknown as string],
        },
      }),
    ]);
    const t = readRules()[0]?.trigger;
    expect(t?.paths).toHaveLength(20);
    expect(t?.requireSkillThisSession).toEqual(["ponytail"]);
  });
});
