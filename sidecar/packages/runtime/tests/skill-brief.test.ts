import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skill-brief-data-"));

import { afterAll, describe, expect, it } from "vitest";

import { appendSessionTurn } from "../src/session";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { saveSlashCommands } from "../src/slash-commands";
import {
  noteSkillRun,
  normaliseSkillName,
  parseSkillsLine,
  parseSkillWaivers,
  seedTurnSkills,
  skillCloseFacts,
} from "../src/skill-brief";

const posture = { model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
const project = "p-skill-brief";

afterAll(() => rmSync(process.env.MARVIN_DATA_DIR as string, { recursive: true, force: true }));

describe("normaliseSkillName", () => {
  it("compares on the last `:` segment, case-insensitively", () => {
    expect(normaliseSkillName("ponytail:ponytail")).toBe("ponytail");
    expect(normaliseSkillName("marvin-project-local:Ponytail-Review")).toBe("ponytail-review");
    expect(normaliseSkillName("ux-review-toolkit:ux-review")).toBe("ux-review");
    expect(normaliseSkillName("/pr-review")).toBe("pr-review");
    expect(normaliseSkillName("  Test-Driven-Development ")).toBe("test-driven-development");
  });
});

describe("parseSkillsLine (ADR-0138)", () => {
  it("reads a real brief line, dropping parenthesised notes and the trailing full stop", () => {
    const msg = "Do the thing.\n\nSkills: `security-audit` (the complete workflow), `pr-review`, `ponytail` (full), `ponytail-review`.\n\nDone when: x";
    expect(parseSkillsLine(msg)).toEqual(["security-audit", "pr-review", "ponytail", "ponytail-review"]);
  });

  it("accepts the bold label and a list marker", () => {
    expect(parseSkillsLine("**Skills:** `test-driven-development`, `webapp-testing` (audit only)")).toEqual(["test-driven-development", "webapp-testing"]);
    expect(parseSkillsLine("- **Skills**: `a-skill`")).toEqual(["a-skill"]);
  });

  it("accepts a `## Skills` heading followed by a list", () => {
    const msg = "Brief\n\n## Skills\n\n- `ponytail` (full)\n- `ux-review-toolkit:ux-review`\n* `systematic-debugging`\n\n## Steps\n1. a\n";
    expect(parseSkillsLine(msg)).toEqual(["ponytail", "ux-review", "systematic-debugging"]);
  });

  it("a note holding backticks is ignored with its parentheses; names are deduplicated and normalised", () => {
    expect(parseSkillsLine("Skills: `Ponytail` (full, see `docs/x.md`), `ponytail:ponytail`")).toEqual(["ponytail"]);
  });

  it("returns null when there is no list: no line, `none`, prose, or a heading with no list", () => {
    expect(parseSkillsLine("just a task")).toBeNull();
    expect(parseSkillsLine("Skills: none")).toBeNull();
    expect(parseSkillsLine("Skills: whatever is needed")).toBeNull();
    expect(parseSkillsLine("## Skills\n\nUse your judgement.\n\n## Steps\n- `x`")).toBeNull();
    expect(parseSkillsLine("I have skills: `not-a-label` in the middle of a sentence")).toBeNull();
  });

  it("is bounded", () => {
    const many = Array.from({ length: 60 }, (_, i) => `\`s${i}\``).join(", ");
    expect(parseSkillsLine(`Skills: ${many}`)).toHaveLength(20);
    expect(parseSkillsLine(`Skills: \`${"x".repeat(200)}\`, \`ok\``)).toEqual(["ok"]);
  });
});

describe("parseSkillWaivers", () => {
  it("reads `Skill not used: <name> — <reason>` lines", () => {
    const text = "done.\n\nSkill not used: ponytail — the change is a one-line config edit\n- Skill not used: `webapp-testing` - no UI changed\n**Skill not used:** pr-review: docs only\nSkill not used: nothing";
    const w = parseSkillWaivers(text);
    expect([...w.keys()].sort()).toEqual(["ponytail", "pr-review", "webapp-testing"]);
    expect(w.get("ponytail")).toBe("the change is a one-line config edit");
  });

  it("requires a reason", () => {
    expect(parseSkillWaivers("Skill not used: ponytail —").size).toBe(0);
    expect(parseSkillWaivers("Skill not used: ponytail").size).toBe(0);
  });
});

describe("seeding and persistence", () => {
  const brief = "Skills: `ponytail`, `pr-review`\n\nDo it.";

  it("seeds the list from the first message and records the moment on the session meta", () => {
    upsertSessionMeta(project, "s1", { workDir: "/w", tree: { mode: "shared" }, posture });
    const r = seedTurnSkills({ projectId: project, sessionId: "s1", message: brief, turnId: "t1", isFirstTurn: () => true });
    expect(r).toMatchObject({ seeded: true, names: ["ponytail", "pr-review"] });
    const meta = readSessionMeta(project, "s1");
    expect(meta?.skills?.required).toEqual(["ponytail", "pr-review"]);
    expect(typeof meta?.skills?.seededAt).toBe("string");
  });

  it("seeds once: a later brief or a message that is not the first turn changes nothing", () => {
    upsertSessionMeta(project, "s2", { workDir: "/w", tree: { mode: "shared" }, posture });
    expect(seedTurnSkills({ projectId: project, sessionId: "s2", message: brief, turnId: "t", isFirstTurn: () => false }).seeded).toBe(false);
    expect(seedTurnSkills({ projectId: project, sessionId: "s2", message: brief, turnId: "t", isFirstTurn: () => true }).seeded).toBe(true);
    const again = seedTurnSkills({ projectId: project, sessionId: "s2", message: "Skills: `other`", turnId: "t2", isFirstTurn: () => true });
    expect(again.seeded).toBe(false);
    expect(readSessionMeta(project, "s2")?.skills?.required).toEqual(["ponytail", "pr-review"]);
  });

  it("never seeds from a wakeup or a queued replay", () => {
    upsertSessionMeta(project, "s3", { workDir: "/w", tree: { mode: "shared" }, posture });
    const r = seedTurnSkills({ projectId: project, sessionId: "s3", message: `[scheduled wakeup] ${brief}`, turnId: "t", isFirstTurn: () => true });
    expect(r.seeded).toBe(false);
  });

  it("a Skill run persists by normalised name and survives a fresh read of the meta (a restart)", () => {
    upsertSessionMeta(project, "s4", { workDir: "/w", tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: project, sessionId: "s4", message: brief, turnId: "t", isFirstTurn: () => true });
    noteSkillRun(project, "s4", "ponytail:Ponytail");
    noteSkillRun(project, "s4", "ponytail");
    expect(readSessionMeta(project, "s4")?.skillsRun).toEqual(["ponytail"]);
    const facts = skillCloseFacts(project, "s4", "/w");
    expect(facts).toMatchObject({ required: ["ponytail", "pr-review"], used: ["ponytail"], blocks: 0 });
  });

  it("a named skill the session cannot invoke is reported unavailable, but only once a catalog was captured", () => {
    upsertSessionMeta(project, "s8", { workDir: "/w", tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: project, sessionId: "s8", message: "Skills: `ponytail`, `zzz-not-installed-anywhere`", turnId: "t", isFirstTurn: () => true });
    // Nothing captured for this project yet: availability is unknown, so nothing is unavailable.
    expect(skillCloseFacts(project, "s8", "/w")?.unavailable).toEqual([]);
    saveSlashCommands(project, [{ name: "ponytail:ponytail", description: "", argumentHint: "" }]);
    expect(skillCloseFacts(project, "s8", "/w")?.unavailable).toEqual(["zzz-not-installed-anywhere"]);
  });

  it("a session with no seeded list has no close facts", () => {
    upsertSessionMeta(project, "s5", { workDir: "/w", tree: { mode: "shared" }, posture });
    expect(skillCloseFacts(project, "s5", "/w")).toBeNull();
    expect(skillCloseFacts(project, "no-such-session", "/w")).toBeNull();
  });

  it("the transcript decides `first turn`: one user turn is first, two are not", () => {
    upsertSessionMeta(project, "s6", { workDir: "/w", tree: { mode: "shared" }, posture });
    appendSessionTurn(project, "s6", { type: "turn.user", at: new Date().toISOString(), message: brief });
    const r = seedTurnSkills({ projectId: project, sessionId: "s6", message: brief, turnId: "t" });
    expect(r.seeded).toBe(true);
    upsertSessionMeta(project, "s7", { workDir: "/w", tree: { mode: "shared" }, posture });
    appendSessionTurn(project, "s7", { type: "turn.user", at: new Date().toISOString(), message: "hello" });
    appendSessionTurn(project, "s7", { type: "turn.user", at: new Date().toISOString(), message: brief });
    expect(seedTurnSkills({ projectId: project, sessionId: "s7", message: brief, turnId: "t" }).seeded).toBe(false);
  });
});
