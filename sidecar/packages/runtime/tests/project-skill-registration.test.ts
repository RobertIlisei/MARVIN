import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listProjectSkills } from "../src/project-skills-plugin";
import { selectActiveSkills } from "../src/skill-enablement";

// What the agent's skill loader actually does with `<workDir>/.marvin/skills/`,
// probed against SDK 0.3.251 on 2026-08-30 with five variants under one local
// plugin:
//
//   registered: good, name-mismatch (under its DIRECTORY name), no-name
//   skipped:    no-fm (no frontmatter), no-desc (no `description:`)
//
// MARVIN's own listing disagreed with all of it — it fell back to the
// directory name whenever frontmatter was missing, so an unregistered runbook
// appeared in the active-skills prompt block as though it were invocable. The
// model called it 29 times across the transcripts, every one answered
// `Unknown skill`, each followed by a find/Read hunt for the file.

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "marvin-skills-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, "utf-8");
  }
  return dir;
}

const skill = (name: string) => `.marvin/skills/${name}/SKILL.md`;

/** The one entry named `name` — throws rather than returning undefined, so a
 *  listing regression fails on the lookup instead of on a null assertion. */
function only(dir: string, name: string) {
  const hit = listProjectSkills(dir).find((s) => s.name === name);
  if (!hit) throw new Error(`no project skill named ${name}`);
  return hit;
}

describe("listProjectSkills — registration reality", () => {
  it("blocks a SKILL.md with no frontmatter", () => {
    const dir = project({ [skill("hetzner-ssh")]: "# Skill: hetzner-ssh\n\nssh prod\n" });
    const s = only(dir, "hetzner-ssh");
    expect(s.loadIssue?.blocked).toBe(true);
    expect(s.loadIssue?.reason).toMatch(/no YAML frontmatter/);
  });

  it("blocks frontmatter that omits `description:` — the load-bearing key", () => {
    const dir = project({ [skill("no-desc")]: "---\nname: no-desc\n---\n\nbody\n" });
    const s = only(dir, "no-desc");
    expect(s.loadIssue?.blocked).toBe(true);
    expect(s.loadIssue?.reason).toMatch(/description/);
  });

  it("accepts frontmatter with only `description:` — `name:` is optional", () => {
    const dir = project({ [skill("no-name")]: '---\ndescription: "Does a thing."\n---\n\nbody\n' });
    const s = only(dir, "no-name");
    expect(s.loadIssue).toBeUndefined();
    expect(s.description).toBe("Does a thing.");
  });

  it("names a skill after its DIRECTORY and flags a frontmatter name that disagrees", () => {
    const dir = project({
      [skill("real-dir")]: '---\nname: something-else\ndescription: "d"\n---\n\nbody\n',
    });
    // The loader ignores the frontmatter name; so must we, or the pane shows a
    // name the `Skill` tool will reject.
    expect(listProjectSkills(dir).map((s) => s.name)).toEqual(["real-dir"]);
    const s = only(dir, "real-dir");
    expect(s.loadIssue?.blocked).toBe(false);
    expect(s.loadIssue?.reason).toMatch(/real-dir/);
  });

  it("ignores directories with no SKILL.md — skill-creator eval workspaces", () => {
    const dir = project({
      [skill("good")]: '---\nname: good\ndescription: "d"\n---\n\nbody\n',
      ".marvin/skills/good-workspace/iteration-1/benchmark.json": "{}",
    });
    expect(listProjectSkills(dir).map((s) => s.name)).toEqual(["good"]);
  });
});

describe("selectActiveSkills — a blocked skill is never advertised", () => {
  const idx = (projectLocal: Array<{ name: string; blocked?: boolean }>) => ({
    userGlobal: [],
    suggestions: [],
    projectLocal: projectLocal.map((s) => ({
      name: s.name,
      description: "",
      path: "",
      shadowsUserGlobal: false,
      ...(s.blocked ? { loadIssue: { blocked: true, reason: "no frontmatter" } } : {}),
    })),
  });

  it("keeps loadable project-local skills active and drops the blocked one", () => {
    expect(selectActiveSkills(idx([{ name: "adr-gate" }, { name: "hetzner-ssh", blocked: true }]), null))
      .toEqual(["adr-gate"]);
  });

  it("does not resurrect a blocked skill through an explicit user choice", () => {
    expect(selectActiveSkills(idx([{ name: "hetzner-ssh", blocked: true }]), ["hetzner-ssh"]))
      .toEqual([]);
  });
});
