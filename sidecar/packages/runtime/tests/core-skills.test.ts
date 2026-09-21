import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CORE_SKILLS, CORE_SKILLS_PLUGIN, coreSkillsPluginConfig } from "../src/core-skills";

// ADR-0118 Milestone 3 — procedures moved out of the system prompt ship with
// MARVIN as a local plugin. The prompt points at them by `marvin:<name>`, so a
// skill whose directory and frontmatter disagree is a pointer to nothing: the
// loader registers the DIRECTORY name.
describe("core skills", () => {
  it("every skill's frontmatter name matches its key and it states when to use it", () => {
    for (const [key, text] of Object.entries(CORE_SKILLS)) {
      const fm = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/.exec(text);
      expect(fm, `${key}: missing frontmatter`).not.toBeNull();
      expect(fm?.[1]).toBe(key);
      expect(fm?.[2]).toMatch(/\bUse (when|for|before)\b/);
    }
  });

  it("writes a loadable plugin: manifest named `marvin` and one SKILL.md per skill", () => {
    const root = join(mkdtempSync(join(tmpdir(), "marvin-core-skills-")), "core-skills");
    expect(coreSkillsPluginConfig(root)).toEqual({ type: "local", path: root });
    const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe(CORE_SKILLS_PLUGIN);
    for (const [name, text] of Object.entries(CORE_SKILLS)) {
      expect(readFileSync(join(root, "skills", name, "SKILL.md"), "utf-8")).toBe(text);
    }
  });

  it("rewrites nothing when the content is unchanged, and drops skills a version stopped shipping", () => {
    const root = join(mkdtempSync(join(tmpdir(), "marvin-core-skills-")), "core-skills");
    coreSkillsPluginConfig(root);
    const first = statSync(join(root, "skills", "adr", "SKILL.md")).mtimeMs;
    coreSkillsPluginConfig(root);
    expect(statSync(join(root, "skills", "adr", "SKILL.md")).mtimeMs).toBe(first);

    mkdirSync(join(root, "skills", "retired"), { recursive: true });
    writeFileSync(join(root, "skills", "retired", "SKILL.md"), "old");
    writeFileSync(join(root, ".content-hash"), "stale\n");
    coreSkillsPluginConfig(root);
    expect(existsSync(join(root, "skills", "retired"))).toBe(false);
  });
});
