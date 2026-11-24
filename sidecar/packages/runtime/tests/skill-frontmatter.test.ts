import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listProjectSkills } from "../src/project-skills-plugin";
import { parseSkillFrontmatter } from "../src/skill-frontmatter";

// R2-15 (UX review round 2): three project skills showed ">" as their
// description. Their SKILL.md uses a YAML block scalar — `description: >` with
// the text on the indented lines below — and the parser read the marker as the
// value. These are the real frontmatter shapes.

const doc = (fm: string): string => `---\n${fm}\n---\n\nbody\n`;

describe("parseSkillFrontmatter", () => {
  it("reads plain and quoted one-line scalars as before", () => {
    expect(parseSkillFrontmatter(doc("name: pdf\ndescription: Make PDFs."))).toEqual({
      name: "pdf",
      description: "Make PDFs.",
    });
    expect(parseSkillFrontmatter(doc("name: 'a'\ndescription: \"Say \\\"hi\\\"\""))).toMatchObject({ name: "a" });
  });

  it("folded scalar (`>`): the indented lines are the description, joined by single spaces", () => {
    const fm = [
      "name: gdpr-erasure-runbook",
      "description: >",
      "  AgriCore OS GDPR Art.17 right-to-erasure saga runbook. Use this skill whenever you are:",
      "  (1) modifying GdprErasureService,",
      '  or "delete user data".',
    ].join("\n");
    expect(parseSkillFrontmatter(doc(fm))).toEqual({
      name: "gdpr-erasure-runbook",
      description:
        'AgriCore OS GDPR Art.17 right-to-erasure saga runbook. Use this skill whenever you are: (1) modifying GdprErasureService, or "delete user data".',
    });
  });

  it("folded scalar with a chomping indicator (`>-`, `>+`) is still the text, never the marker", () => {
    expect(parseSkillFrontmatter(doc("description: >-\n  one\n  two")).description).toBe("one two");
    expect(parseSkillFrontmatter(doc("description: >+\n  one\n  two")).description).toBe("one two");
  });

  it("literal scalar (`|`) keeps its line breaks", () => {
    expect(parseSkillFrontmatter(doc("description: |\n  line one\n  line two")).description).toBe(
      "line one\nline two",
    );
    expect(parseSkillFrontmatter(doc("description: |-\n  line one")).description).toBe("line one");
  });

  it("a blank line inside a folded scalar is a paragraph break", () => {
    expect(parseSkillFrontmatter(doc("description: >\n  first\n\n  second")).description).toBe("first\nsecond");
  });

  it("the block ends at the next top-level key; later keys still parse", () => {
    const fm = "description: >\n  folded text\n  continues\nname: after";
    expect(parseSkillFrontmatter(doc(fm))).toEqual({ name: "after", description: "folded text continues" });
  });

  it("a plain scalar that continues on indented lines is one description", () => {
    expect(parseSkillFrontmatter(doc("description: starts here\n  and goes on")).description).toBe(
      "starts here and goes on",
    );
  });

  it("an empty block scalar is an empty description, not '>'", () => {
    expect(parseSkillFrontmatter(doc("name: x\ndescription: >\n")).description).toBe("");
    expect(parseSkillFrontmatter(doc("name: x\ndescription: |")).description).toBe("");
  });

  it("no frontmatter, or an unterminated block, gives nothing", () => {
    expect(parseSkillFrontmatter("just text")).toEqual({});
    expect(parseSkillFrontmatter("---\nname: x\n")).toEqual({});
  });
});

describe("listProjectSkills with a folded description", () => {
  it("reports the text, not '>'", () => {
    const root = mkdtempSync(path.join(tmpdir(), "marvin-fm-"));
    const dir = path.join(root, ".marvin", "skills", "evidence-pack-runbook");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: evidence-pack-runbook\ndescription: >\n  Milestone evidence-bundle process.\n  Use when preparing a delivery.\n---\n\nbody\n",
    );
    const [skill] = listProjectSkills(root);
    expect(skill?.description).toBe("Milestone evidence-bundle process. Use when preparing a delivery.");
    expect(skill?.loadIssue).toBeUndefined();
  });

  it("a block scalar with no text is a load issue (no description), not a '>' description", () => {
    const root = mkdtempSync(path.join(tmpdir(), "marvin-fm-"));
    const dir = path.join(root, ".marvin", "skills", "empty-one");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "---\nname: empty-one\ndescription: >\n---\n\nbody\n");
    const [skill] = listProjectSkills(root);
    expect(skill?.description).toBe("");
    expect(skill?.loadIssue?.blocked).toBe(true);
  });
});
