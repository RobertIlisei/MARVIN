import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRecord,
  hashTree,
  isActionable,
  readSkillProvenance,
  SKILL_SOURCE_FILE,
  toSourceInfo,
  upsertPluginProvenance,
} from "../src/install-provenance";
import { isPrunableCachePath } from "../src/plugin-installer";
import {
  addSkillFromGit,
  listInstalledSkillRefs,
  updateAllSkills,
  updateSkill,
} from "../src/skill-installer";

// ADR-0071 — install provenance + the update path it enables.
//
// The skill side is exercised end-to-end against a LOCAL git repo (git clone
// accepts a filesystem path), always in `project-local` scope so nothing
// touches the developer's real ~/.claude/skills. The plugin side installs into
// ~/.claude/plugins, which a test must not write to, so only its pure pieces
// are covered here — same discipline as plugin-installer.test.ts.

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`,
  );
}

function commitAll(repo: string, msg: string): void {
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", msg]);
}

function makeRepo(skills: Array<{ name: string; body: string }>): string {
  const repo = mkdtempSync(path.join(tmpdir(), "marvin-upd-repo-"));
  for (const s of skills) writeSkill(path.join(repo, s.name), s.name, s.body);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  commitAll(repo, "initial");
  return repo;
}

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "marvin-upd-ws-"));
}

function skillDir(work: string, name: string): string {
  return path.join(work, ".marvin", "skills", name);
}

describe("hashTree", () => {
  it("is stable for identical content and independent of location", () => {
    const a = mkdtempSync(path.join(tmpdir(), "marvin-h-"));
    const b = mkdtempSync(path.join(tmpdir(), "marvin-h-"));
    for (const root of [a, b]) {
      writeSkill(root, "x", "same body");
      mkdirSync(path.join(root, "sub"), { recursive: true });
      writeFileSync(path.join(root, "sub", "extra.txt"), "hello");
    }
    expect(hashTree(a)).toBe(hashTree(b));
  });

  it("changes when any file's content changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "marvin-h-"));
    writeSkill(root, "x", "before");
    const before = hashTree(root);
    writeSkill(root, "x", "after");
    expect(hashTree(root)).not.toBe(before);
  });

  it("changes when a file is added, and ignores .git and the provenance file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "marvin-h-"));
    writeSkill(root, "x", "body");
    const base = hashTree(root);

    // Excluded: the provenance file CONTAINS the hash, so counting it would be
    // self-referential and a fresh clone never has one.
    writeFileSync(path.join(root, SKILL_SOURCE_FILE), JSON.stringify({ version: 1 }));
    mkdirSync(path.join(root, ".git"), { recursive: true });
    writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main");
    expect(hashTree(root)).toBe(base);

    // Not excluded: a genuine new file.
    writeFileSync(path.join(root, "NEW.md"), "new");
    expect(hashTree(root)).not.toBe(base);
  });
});

describe("isActionable", () => {
  it("needs a url, or a marketplace AND a plugin", () => {
    expect(isActionable(undefined)).toBe(false);
    expect(isActionable({})).toBe(false);
    expect(isActionable({ url: "https://example.test/r.git" })).toBe(true);
    expect(isActionable({ marketplace: "m" })).toBe(false);
    expect(isActionable({ marketplace: "m", plugin: "p" })).toBe(true);
  });
});

describe("buildRecord", () => {
  it("carries installedAt forward on update but moves lastUpdated", () => {
    const first = buildRecord({ url: "u" }, "sha256:a", "2026-01-01T00:00:00.000Z");
    const second = buildRecord({ url: "u" }, "sha256:b", "2026-02-02T00:00:00.000Z", first);
    expect(second.installedAt).toBe(first.installedAt);
    expect(second.lastUpdated).toBe("2026-02-02T00:00:00.000Z");
    expect(second.contentHash).toBe("sha256:b");
  });
});

describe("toSourceInfo", () => {
  it("marks a record with no reachable source as not updatable", () => {
    const rec = buildRecord({ skillName: "x" }, "sha256:a", "t");
    expect(toSourceInfo(rec)?.updatable).toBe(false);
    expect(toSourceInfo(null)).toBeUndefined();
  });
});

describe("upsertPluginProvenance", () => {
  it("adds a key and leaves every other one untouched", () => {
    const rec = buildRecord({ url: "u", plugin: "hc" }, "sha256:a", "t");
    const other = buildRecord({ url: "o", plugin: "ot" }, "sha256:b", "t");
    const out = upsertPluginProvenance({ version: 1, plugins: { "ot@m": other } }, "hc@m", rec);
    expect(out.plugins!["hc@m"]).toEqual(rec);
    expect(out.plugins!["ot@m"]).toEqual(other);
  });
});

describe("isPrunableCachePath", () => {
  const root = "/home/u/.claude/plugins/cache";

  it("accepts exactly <marketplace>/<plugin>/<version>", () => {
    expect(isPrunableCachePath(root, `${root}/market/hc/1.0.0`)).toBe(true);
  });

  it("refuses the cache root, shallower paths, and deeper paths", () => {
    expect(isPrunableCachePath(root, root)).toBe(false);
    expect(isPrunableCachePath(root, `${root}/market`)).toBe(false);
    expect(isPrunableCachePath(root, `${root}/market/hc`)).toBe(false);
    expect(isPrunableCachePath(root, `${root}/market/hc/1.0.0/skills`)).toBe(false);
  });

  it("refuses anything outside the cache, including via ..", () => {
    expect(isPrunableCachePath(root, "/home/u/.claude/plugins")).toBe(false);
    expect(isPrunableCachePath(root, "/etc")).toBe(false);
    expect(isPrunableCachePath(root, `${root}/../../../etc`)).toBe(false);
  });
});

describe("skill install records provenance", () => {
  it("writes .marvin-source.json with the URL, the selected skill, and a hash", () => {
    const repo = makeRepo([{ name: "solo", body: "v1" }]);
    const work = workspace();
    const res = addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    expect(res.ok).toBe(true);

    const rec = readSkillProvenance(skillDir(work, "solo"));
    expect(rec?.source.url).toBe(repo);
    expect(rec?.source.skillName).toBe("solo");
    expect(rec?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rec?.installedAt).toBe(rec?.lastUpdated);
  });

  it("records provenance per skill when several are installed from one repo", () => {
    const repo = makeRepo([
      { name: "one", body: "a" },
      { name: "two", body: "b" },
    ]);
    const work = workspace();
    addSkillFromGit({
      url: repo,
      scope: "project-local",
      workDir: work,
      only: ["one", "two"],
    });
    expect(readSkillProvenance(skillDir(work, "one"))?.source.skillName).toBe("one");
    expect(readSkillProvenance(skillDir(work, "two"))?.source.skillName).toBe("two");
  });
});

describe("updateSkill", () => {
  it("reports up-to-date when upstream has not changed", () => {
    const repo = makeRepo([{ name: "solo", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });

    const out = updateSkill({ name: "solo", scope: "project-local", workDir: work });
    expect(out.status).toBe("up-to-date");
  });

  it("checkOnly reports an available update without touching the install", () => {
    const repo = makeRepo([{ name: "solo", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });

    writeSkill(path.join(repo, "solo"), "solo", "v2");
    commitAll(repo, "bump");

    const out = updateSkill({
      name: "solo",
      scope: "project-local",
      workDir: work,
      checkOnly: true,
    });
    expect(out.status).toBe("update-available");
    // Nothing installed — the old body is still on disk.
    expect(readFileSync(path.join(skillDir(work, "solo"), "SKILL.md"), "utf-8")).toContain("v1");
  });

  it("pulls the new content and keeps installedAt while moving lastUpdated", () => {
    const repo = makeRepo([{ name: "solo", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    const before = readSkillProvenance(skillDir(work, "solo"))!;

    writeSkill(path.join(repo, "solo"), "solo", "v2");
    writeFileSync(path.join(repo, "solo", "EXTRA.md"), "added upstream");
    commitAll(repo, "bump");

    const out = updateSkill({ name: "solo", scope: "project-local", workDir: work });
    expect(out.status).toBe("updated");
    expect(readFileSync(path.join(skillDir(work, "solo"), "SKILL.md"), "utf-8")).toContain("v2");
    expect(existsSync(path.join(skillDir(work, "solo"), "EXTRA.md"))).toBe(true);

    const after = readSkillProvenance(skillDir(work, "solo"))!;
    expect(after.installedAt).toBe(before.installedAt);
    expect(after.contentHash).not.toBe(before.contentHash);
    // A second run now has nothing to do.
    expect(updateSkill({ name: "solo", scope: "project-local", workDir: work }).status).toBe(
      "up-to-date",
    );
  });

  it("follows an upstream rename and removes the old folder", () => {
    const repo = makeRepo([{ name: "oldname", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });

    // Upstream renames the skill in place (same folder, new frontmatter name).
    writeSkill(path.join(repo, "oldname"), "newname", "v2");
    commitAll(repo, "rename");

    const out = updateSkill({ name: "oldname", scope: "project-local", workDir: work });
    expect(out.status).toBe("updated");
    expect(out.name).toBe("newname");
    expect(existsSync(skillDir(work, "newname"))).toBe(true);
    expect(existsSync(skillDir(work, "oldname"))).toBe(false);
  });

  it("errors clearly when the skill has no recorded source", () => {
    const work = workspace();
    writeSkill(skillDir(work, "handmade"), "handmade", "authored in place");

    const out = updateSkill({ name: "handmade", scope: "project-local", workDir: work });
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/no recorded source/);
  });

  it("a supplied url backfills provenance for a skill installed before ADR-0071", () => {
    const repo = makeRepo([{ name: "legacy", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    // Simulate a pre-ADR-0071 install: the folder exists, the record doesn't.
    rmSync(path.join(skillDir(work, "legacy"), SKILL_SOURCE_FILE), { force: true });
    expect(readSkillProvenance(skillDir(work, "legacy"))).toBeNull();

    writeSkill(path.join(repo, "legacy"), "legacy", "v2");
    commitAll(repo, "bump");

    const out = updateSkill({
      name: "legacy",
      scope: "project-local",
      workDir: work,
      url: repo,
    });
    expect(out.status).toBe("updated");
    expect(readFileSync(path.join(skillDir(work, "legacy"), "SKILL.md"), "utf-8")).toContain("v2");
    // The record now exists, so future updates need no URL.
    expect(readSkillProvenance(skillDir(work, "legacy"))?.source.url).toBe(repo);
    expect(updateSkill({ name: "legacy", scope: "project-local", workDir: work }).status).toBe(
      "up-to-date",
    );
  });

  it("errors when the skill is gone from the source repo", () => {
    const repo = makeRepo([
      { name: "kept", body: "a" },
      { name: "doomed", body: "b" },
    ]);
    const work = workspace();
    addSkillFromGit({
      url: repo,
      scope: "project-local",
      workDir: work,
      only: ["kept", "doomed"],
    });

    rmSync(path.join(repo, "doomed"), { recursive: true, force: true });
    commitAll(repo, "drop doomed");

    const out = updateSkill({ name: "doomed", scope: "project-local", workDir: work });
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/no longer in that repository/);
  });
});

describe("listInstalledSkillRefs / updateAllSkills", () => {
  it("lists installed skills with their provenance, null for hand-authored ones", () => {
    const repo = makeRepo([{ name: "fetched", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    writeSkill(skillDir(work, "handmade"), "handmade", "authored");

    const refs = listInstalledSkillRefs("project-local", work);
    expect(refs.map((r) => r.name)).toEqual(["fetched", "handmade"]);
    expect(refs.find((r) => r.name === "fetched")?.provenance?.source.url).toBe(repo);
    expect(refs.find((r) => r.name === "handmade")?.provenance).toBeNull();
  });

  it("skips sourceless skills rather than reporting them as errors", () => {
    const repo = makeRepo([{ name: "fetched", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });
    writeSkill(skillDir(work, "handmade"), "handmade", "authored");

    writeSkill(path.join(repo, "fetched"), "fetched", "v2");
    commitAll(repo, "bump");

    const res = updateAllSkills({ scope: "project-local", workDir: work });
    expect(res.ok).toBe(true);
    // Only the one with a source is acted on — a wall of errors for a
    // hand-authored tree would bury the real result.
    expect(res.results.map((r) => r.name)).toEqual(["fetched"]);
    expect(res.results[0]!.status).toBe("updated");
  });

  it("project-local scope requires a workDir", () => {
    const res = updateAllSkills({ scope: "project-local" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/workDir/);
  });
});

describe("updateSkill through the marketplace flow", () => {
  function makeMarketRepo(body: string): string {
    const repo = mkdtempSync(path.join(tmpdir(), "marvin-upd-mkt-"));
    mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(repo, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "demo-market",
        owner: { name: "t" },
        plugins: [{ name: "infra-pack", description: "infra", source: "./plugins/infra" }],
      }),
    );
    writeSkill(path.join(repo, "plugins", "infra", "skills", "ansible-helper"), "ansible-helper", body);
    writeSkill(path.join(repo, "plugins", "infra", "skills", "azure-pipeline"), "azure-pipeline", body);
    return repo;
  }

  it("re-resolves the plugin rather than scanning the whole marketplace repo", () => {
    const repo = makeMarketRepo("v1");
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.test"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    commitAll(repo, "market");

    const work = workspace();
    const installed = addSkillFromGit({
      url: repo,
      scope: "project-local",
      workDir: work,
      plugin: "infra-pack",
    });
    expect(installed.installed?.map((i) => i.name).sort()).toEqual([
      "ansible-helper",
      "azure-pipeline",
    ]);
    // The recorded path is relative to the PLUGIN dir, not the repo root.
    const rec = readSkillProvenance(skillDir(work, "ansible-helper"))!;
    expect(rec.source.plugin).toBe("infra-pack");
    expect(rec.source.sourcePath).toBe(path.join("skills", "ansible-helper"));

    expect(
      updateSkill({ name: "ansible-helper", scope: "project-local", workDir: work }).status,
    ).toBe("up-to-date");

    writeSkill(
      path.join(repo, "plugins", "infra", "skills", "ansible-helper"),
      "ansible-helper",
      "v2",
    );
    commitAll(repo, "bump");

    const out = updateSkill({ name: "ansible-helper", scope: "project-local", workDir: work });
    expect(out.status).toBe("updated");
    expect(
      readFileSync(path.join(skillDir(work, "ansible-helper"), "SKILL.md"), "utf-8"),
    ).toContain("v2");
  });
});

describe("updateSkill when the source folder moves", () => {
  it("falls back to the name when the recorded path is gone but the skill is not", () => {
    const repo = makeRepo([{ name: "mover", body: "v1" }]);
    const work = workspace();
    addSkillFromGit({ url: repo, scope: "project-local", workDir: work });

    // Upstream reorganises: same skill, new folder.
    rmSync(path.join(repo, "mover"), { recursive: true, force: true });
    writeSkill(path.join(repo, "skills", "mover"), "mover", "v2");
    commitAll(repo, "reorganise");

    const out = updateSkill({ name: "mover", scope: "project-local", workDir: work });
    expect(out.status).toBe("updated");
    expect(readFileSync(path.join(skillDir(work, "mover"), "SKILL.md"), "utf-8")).toContain("v2");
    // The record now tracks the new location.
    expect(readSkillProvenance(skillDir(work, "mover"))?.source.sourcePath).toBe(
      path.join("skills", "mover"),
    );
  });
});
