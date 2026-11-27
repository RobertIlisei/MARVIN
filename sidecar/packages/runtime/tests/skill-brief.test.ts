import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skill-brief-data-"));

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { appendSessionTurn } from "../src/session";
import { setEnabledSkills } from "../src/skill-enablement";
import { readSessionMeta, updateSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { saveSlashCommands } from "../src/slash-commands";
import {
  noteSkillRun,
  normaliseSkillName,
  parseSkillsBrief,
  parseSkillsLine,
  parseSkillWaivers,
  readProjectFirstSkills,
  readProjectSkillsStrict,
  seedTurnSkills,
  skillCloseFacts,
  skillsFirstFacts,
  skillsReminder,
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

describe("start skills: the `first` marker (ADR-0138 addendum)", () => {
  it("reads a real brief line: only the skill marked first is a start skill", () => {
    const msg = "Skills: `ponytail` (full, first), `ponytail-review`, `pr-review`, `test-driven-development`.";
    expect(parseSkillsBrief(msg)).toEqual({
      required: ["ponytail", "ponytail-review", "pr-review", "test-driven-development"],
      first: ["ponytail"],
    });
    // The list a brief without markers always produced is unchanged.
    expect(parseSkillsLine(msg)).toEqual(["ponytail", "ponytail-review", "pr-review", "test-driven-development"]);
  });

  it("accepts the note in either order, with other words, and on a list item", () => {
    expect(parseSkillsBrief("Skills: `a` (first), `b` (first, full), `c` (full, first), `d` (full)")?.first).toEqual(["a", "b", "c"]);
    expect(parseSkillsBrief("## Skills\n\n- `a` (full, first)\n- `b`\n")).toEqual({ required: ["a", "b"], first: ["a"] });
  });

  it("a note that only contains the letters inside another word, or sits on another skill, does not mark", () => {
    expect(parseSkillsBrief("Skills: `a` (firstly), `b` (first), `d`")?.first).toEqual(["b"]);
    expect(parseSkillsBrief("Skills: `a` (see `c` first), `d`")?.first).toEqual(["a"]);
    expect(parseSkillsBrief("Skills: `a`, `b`")?.first).toEqual([]);
  });

  it("accepts a separate `Skills first:` line, plain or bold, whose names also count as named", () => {
    expect(parseSkillsBrief("Skills first: `x`, `y`\nSkills: `y`, `z`")).toEqual({ required: ["x", "y", "z"], first: ["x", "y"] });
    expect(parseSkillsBrief("**Skills first:** `x` (full)")).toEqual({ required: ["x"], first: ["x"] });
    expect(parseSkillsBrief("- **Skills first**: `q`")).toEqual({ required: ["q"], first: ["q"] });
  });

  it("normalises, deduplicates and bounds the start list", () => {
    expect(parseSkillsBrief("Skills: `Ponytail:ponytail` (first), `ponytail` (first)")).toEqual({ required: ["ponytail"], first: ["ponytail"] });
    const many = Array.from({ length: 60 }, (_, i) => `\`s${i}\` (first)`).join(", ");
    const r = parseSkillsBrief(`Skills: ${many}`);
    expect(r?.required).toHaveLength(20);
    expect(r?.first).toHaveLength(20);
  });

  it("returns null when the brief names no skill at all", () => {
    expect(parseSkillsBrief("Skills first: none")).toBeNull();
    expect(parseSkillsBrief("just a task")).toBeNull();
  });
});

describe("start skills on the session meta", () => {
  const sproject = "p-skill-first";
  const root = mkdtempSync(join(tmpdir(), "marvin-skill-first-root-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const brief = "Skills: `ponytail` (first), `pr-review`\n\nDo it.";

  it("stores `first` with the seeded list; an old meta without it keeps working", () => {
    upsertSessionMeta(sproject, "a1", { workDir: root, tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: sproject, sessionId: "a1", message: brief, turnId: "t", isFirstTurn: () => true, workDir: root });
    expect(readSessionMeta(sproject, "a1")?.skills?.first).toEqual(["ponytail"]);

    upsertSessionMeta(sproject, "old", { workDir: root, tree: { mode: "shared" }, posture });
    updateSessionMeta(sproject, "old", { skills: { required: ["ponytail", "pr-review"], seededAt: "2026-11-24T08:00:00.000Z" } });
    expect(skillCloseFacts(sproject, "old", root)).toMatchObject({ required: ["ponytail", "pr-review"], blocks: 0 });
    expect(skillsFirstFacts(sproject, "old", root)).toBeNull();
    expect(skillsReminder(sproject, "old", root)).toContain("`ponytail`");
    expect(skillsReminder(sproject, "old", root)).not.toContain("before your first change");
  });

  it("the project's `first` setting marks a skill only when the brief names it", () => {
    mkdirSync(join(root, ".marvin"), { recursive: true });
    writeFileSync(join(root, ".marvin", "skills.json"), JSON.stringify({ first: ["pr-review", "Not-Named-In-Brief"] }));
    upsertSessionMeta(sproject, "a2", { workDir: root, tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: sproject, sessionId: "a2", message: "Skills: `ponytail`, `pr-review`", turnId: "t", isFirstTurn: () => true, workDir: root });
    const meta = readSessionMeta(sproject, "a2");
    expect(meta?.skills?.required).toEqual(["ponytail", "pr-review"]);
    expect(meta?.skills?.first).toEqual(["pr-review"]);
    // A brief that names nothing the setting lists gets no start skill from it.
    upsertSessionMeta(sproject, "a3", { workDir: root, tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: sproject, sessionId: "a3", message: "Skills: `ponytail`", turnId: "t", isFirstTurn: () => true, workDir: root });
    expect(readSessionMeta(sproject, "a3")?.skills?.first).toEqual([]);
  });

  it("the setting is read at a validating boundary", () => {
    const w = mkdtempSync(join(tmpdir(), "marvin-skill-first-w-"));
    try {
      expect(readProjectFirstSkills(w)).toEqual([]); // no file
      mkdirSync(join(w, ".marvin"), { recursive: true });
      writeFileSync(join(w, ".marvin", "skills.json"), "{not json");
      expect(readProjectFirstSkills(w)).toEqual([]);
      writeFileSync(join(w, ".marvin", "skills.json"), JSON.stringify({ first: "ponytail" }));
      expect(readProjectFirstSkills(w)).toEqual([]);
      const hostile = ["Ponytail:Ponytail", 7, null, "", "a b", "x".repeat(200), "../../etc", "`rm`", ...Array.from({ length: 40 }, (_, i) => `s${i}`)];
      writeFileSync(join(w, ".marvin", "skills.json"), JSON.stringify({ first: hostile }));
      const got = readProjectFirstSkills(w);
      expect(got[0]).toBe("ponytail");
      expect(got.length).toBeLessThanOrEqual(20);
      expect(got).not.toContain("a b");
      expect(got).not.toContain("../../etc");
      expect(got.every((n) => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(n))).toBe(true);
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });

  it("strict mode is read at a validating boundary: only a literal true, optional as a clean name list", () => {
    const w = mkdtempSync(join(tmpdir(), "marvin-skill-strict-w-"));
    const put = (v: unknown) => writeFileSync(join(w, ".marvin", "skills.json"), typeof v === "string" ? v : JSON.stringify(v));
    try {
      expect(readProjectSkillsStrict(w)).toEqual({ strict: false, optional: [] }); // no file
      mkdirSync(join(w, ".marvin"), { recursive: true });
      put("{not json");
      expect(readProjectSkillsStrict(w).strict).toBe(false);
      for (const bad of ["true", 1, "yes", null, [], {}]) {
        put({ strict: bad, optional: ["pr-review"] });
        expect(readProjectSkillsStrict(w), JSON.stringify(bad)).toEqual({ strict: false, optional: [] });
      }
      put({ strict: true });
      expect(readProjectSkillsStrict(w)).toEqual({ strict: true, optional: [] });
      put({ strict: true, optional: "pr-review" });
      expect(readProjectSkillsStrict(w)).toEqual({ strict: true, optional: [] });
      put({ strict: true, optional: ["Pr-Review", 7, null, "a b", "../../x", "pr-review", ...Array.from({ length: 40 }, (_, i) => `s${i}`)] });
      const got = readProjectSkillsStrict(w).optional;
      expect(got[0]).toBe("pr-review");
      expect(got.filter((n) => n === "pr-review")).toHaveLength(1);
      expect(got.length).toBeLessThanOrEqual(20);
      expect(got).not.toContain("a b");
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });

  it("the Skills pane's own write keeps `strict` and `optional`", () => {
    const w = mkdtempSync(join(tmpdir(), "marvin-skill-strict-p-"));
    try {
      mkdirSync(join(w, ".marvin"), { recursive: true });
      writeFileSync(join(w, ".marvin", "skills.json"), JSON.stringify({ enabled: ["a"], strict: true, optional: ["pr-review"] }));
      setEnabledSkills(w, ["a", "b"]);
      expect(readProjectSkillsStrict(w)).toEqual({ strict: true, optional: ["pr-review"] });
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });

  it("the Skills pane's own write keeps the `first` key", () => {
    const w = mkdtempSync(join(tmpdir(), "marvin-skill-first-p-"));
    try {
      mkdirSync(join(w, ".marvin"), { recursive: true });
      writeFileSync(join(w, ".marvin", "skills.json"), JSON.stringify({ enabled: ["a"], first: ["ponytail"] }));
      setEnabledSkills(w, ["a", "b"]);
      expect(readProjectFirstSkills(w)).toEqual(["ponytail"]);
    } finally {
      rmSync(w, { recursive: true, force: true });
    }
  });
});

describe("the per-turn skills reminder line", () => {
  const rproject = "p-skill-remind";
  const w = "/w";
  it("lists only the skills that have not run, marks the start ones, and disappears when none is missing", () => {
    upsertSessionMeta(rproject, "r1", { workDir: w, tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: rproject, sessionId: "r1", message: "Skills: `ponytail` (first), `pr-review`, `tdd`", turnId: "t", isFirstTurn: () => true, workDir: w });
    const a = skillsReminder(rproject, "r1", w) ?? "";
    expect(a).toContain("not yet used");
    expect(a).toContain("`ponytail`");
    expect(a).toContain("`pr-review`");
    expect(a).toContain("`tdd`");
    expect(a).toMatch(/before your first change: `ponytail`/);
    expect(a.length).toBeLessThan(260);

    noteSkillRun(rproject, "r1", "ponytail:ponytail");
    const b = skillsReminder(rproject, "r1", w) ?? "";
    expect(b).not.toContain("`ponytail`");
    expect(b).toContain("`pr-review`");
    expect(b).not.toContain("before your first change");

    noteSkillRun(rproject, "r1", "pr-review");
    noteSkillRun(rproject, "r1", "tdd");
    expect(skillsReminder(rproject, "r1", w)).toBeNull();
  });

  it("is null without a seeded list, and leaves out a skill the project cannot invoke", () => {
    upsertSessionMeta(rproject, "r2", { workDir: w, tree: { mode: "shared" }, posture });
    expect(skillsReminder(rproject, "r2", w)).toBeNull();
    expect(skillsReminder(rproject, "nope", w)).toBeNull();
    seedTurnSkills({ projectId: rproject, sessionId: "r2", message: "Skills: `zzz-gone` (first), `pr-review`", turnId: "t", isFirstTurn: () => true, workDir: w });
    saveSlashCommands(rproject, [{ name: "pr-review", description: "", argumentHint: "" }]);
    const r = skillsReminder(rproject, "r2", w) ?? "";
    expect(r).not.toContain("zzz-gone");
    expect(r).toContain("`pr-review`");
    expect(r).not.toContain("before your first change");
  });
});
