import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addSkillFromGit, discoverSkills, parseGitUrl } from "../src/skill-installer";

// ADR-0039: fetch skills from Git. parseGitUrl + discoverSkills are the pure
// core; addSkillFromGit is exercised against a LOCAL git repo (git clone
// accepts a filesystem path) so the test needs no network.

describe("parseGitUrl", () => {
  it("plain GitHub URL → clone the whole repo", () => {
    expect(parseGitUrl("https://github.com/anthropics/skills")).toEqual({
      cloneUrl: "https://github.com/anthropics/skills.git",
    });
  });
  it("GitHub tree sub-path URL → clone repo + install just that folder", () => {
    expect(parseGitUrl("https://github.com/owner/repo/tree/main/skills/pdf")).toEqual({
      cloneUrl: "https://github.com/owner/repo.git",
      branch: "main",
      subpath: "skills/pdf",
    });
  });
  it("ssh / raw git URLs pass through; junk is rejected", () => {
    expect(parseGitUrl("git@github.com:owner/repo.git")?.cloneUrl).toBe("git@github.com:owner/repo.git");
    expect(parseGitUrl("not a url")).toBeNull();
  });
});

function writeSkill(dir: string, name: string, desc: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody\n`);
}

describe("discoverSkills", () => {
  it("finds every SKILL.md folder and reads its frontmatter; stops at a skill leaf", () => {
    const root = mkdtempSync(path.join(tmpdir(), "marvin-disc-"));
    writeSkill(path.join(root, "alpha"), "alpha", "the alpha skill");
    writeSkill(path.join(root, "nested", "beta"), "beta", "the beta skill");
    // a non-skill dir is ignored
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "README.md"), "hi");

    const found = discoverSkills(root).map((s) => s.name).sort();
    expect(found).toEqual(["alpha", "beta"]);
  });
});

describe("addSkillFromGit (against a local git repo)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    // best-effort: remove any user-global test skill we installed
    for (const p of cleanups) {
      try {
        execFileSync("rm", ["-rf", p]);
      } catch {
        /* ignore */
      }
    }
    cleanups.length = 0;
  });

  function makeRepo(skills: Array<{ name: string; desc: string }>): string {
    const repo = mkdtempSync(path.join(tmpdir(), "marvin-repo-"));
    for (const s of skills) writeSkill(path.join(repo, s.name), s.name, s.desc);
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "skills"]);
    return repo;
  }

  it("a single-skill repo installs directly into a project-local dir", () => {
    const repo = makeRepo([{ name: "solo-skill", desc: "only one" }]);
    const work = mkdtempSync(path.join(tmpdir(), "marvin-ws-"));
    const res = addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    expect(res.ok).toBe(true);
    expect(res.installed?.map((i) => i.name)).toEqual(["solo-skill"]);
    expect(existsSync(path.join(work, ".marvin", "skills", "solo-skill", "SKILL.md"))).toBe(true);
  });

  it("a multi-skill repo with no selection returns the pick-list (installs nothing)", () => {
    const repo = makeRepo([
      { name: "one", desc: "first" },
      { name: "two", desc: "second" },
    ]);
    const work = mkdtempSync(path.join(tmpdir(), "marvin-ws-"));
    const res = addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    expect(res.ok).toBe(true);
    expect(res.installed).toBeUndefined();
    expect(res.available?.map((c) => c.name).sort()).toEqual(["one", "two"]);
    expect(existsSync(path.join(work, ".marvin", "skills", "one"))).toBe(false);
  });

  it("installs only the selected skill from a multi-skill repo", () => {
    const repo = makeRepo([
      { name: "keep", desc: "wanted" },
      { name: "skip", desc: "not wanted" },
    ]);
    const work = mkdtempSync(path.join(tmpdir(), "marvin-ws-"));
    const res = addSkillFromGit({ url: repo, scope: "project-local", workDir: work, only: ["keep"] });
    expect(res.installed?.map((i) => i.name)).toEqual(["keep"]);
    expect(existsSync(path.join(work, ".marvin", "skills", "keep"))).toBe(true);
    expect(existsSync(path.join(work, ".marvin", "skills", "skip"))).toBe(false);
  });

  it("a marketplace URL lists its plugins; installing one pulls in its skills (phase B)", () => {
    // Build a marketplace repo: .claude-plugin/marketplace.json + a plugin
    // with a relative-path source whose skills/ holds two SKILL.md folders.
    const repo = mkdtempSync(path.join(tmpdir(), "marvin-mkt-"));
    mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(repo, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo-market",
        owner: { name: "t" },
        plugins: [{ name: "infra-pack", description: "infra skills", source: "./plugins/infra" }],
      }),
    );
    writeSkill(path.join(repo, "plugins", "infra", "skills", "ansible-helper"), "ansible-helper", "ansible");
    writeSkill(path.join(repo, "plugins", "infra", "skills", "azure-pipeline"), "azure-pipeline", "azure");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "market"]);
    const work = mkdtempSync(path.join(tmpdir(), "marvin-ws-"));

    // 1) No plugin → get the plugin list.
    const listed = addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    expect(listed.marketplace?.name).toBe("demo-market");
    expect(listed.marketplace?.plugins.map((p) => p.name)).toEqual(["infra-pack"]);
    expect(listed.installed).toBeUndefined();

    // 2) Install the plugin → both of its skills land.
    const installed = addSkillFromGit({
      url: repo, scope: "project-local", workDir: work, plugin: "infra-pack",
    });
    expect(installed.installed?.map((i) => i.name).sort()).toEqual(["ansible-helper", "azure-pipeline"]);
    expect(existsSync(path.join(work, ".marvin", "skills", "ansible-helper", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(work, ".marvin", "skills", "azure-pipeline", "SKILL.md"))).toBe(true);
  });

  it("rejects a repo with no SKILL.md", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "marvin-empty-"));
    writeFileSync(path.join(repo, "README.md"), "no skills here");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "x"]);
    const work = mkdtempSync(path.join(tmpdir(), "marvin-ws-"));
    const res = addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No SKILL.md/i);
  });
});
