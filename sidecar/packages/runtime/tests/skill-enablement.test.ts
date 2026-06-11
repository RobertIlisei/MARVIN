import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CORE_SKILLS,
  readEnabledSkills,
  selectActiveSkills,
  setEnabledSkills,
} from "../src/skill-enablement";

// ADR-0037: the "installed vs active" enablement layer. selectActiveSkills
// is the pure core — given the skills index (what's installed + what the
// fingerprint suggests) and an optional explicit user choice, decide which
// skills are active for the project. Defaults to core + matched installs;
// the user can override; project-local skills are always active.

const idx = (
  userGlobal: string[],
  projectLocal: string[],
  suggestions: Array<{ name: string; verb: "install" | "build" }>,
) => ({
  userGlobal: userGlobal.map((name) => ({ name, description: "", path: "" })),
  projectLocal: projectLocal.map((name) => ({
    name,
    description: "",
    path: "",
    shadowsUserGlobal: false,
  })),
  suggestions: suggestions.map((s) => ({
    name: s.name,
    verb: s.verb,
    matchedTags: [],
    rationale: "",
    alreadyInstalled: true,
    scope: s.verb === "install" ? ("user-global" as const) : ("project-local" as const),
  })),
});

describe("selectActiveSkills (fingerprint default)", () => {
  it("activates the installed core + fingerprint-matched install-suggestions, not the rest", () => {
    const index = idx(
      // installed: 2 core + 3 domain
      ["graphify", "pr-review", "xlsx", "pptx", "claude-api"],
      [],
      // fingerprint suggests claude-api (install) — xlsx/pptx are NOT suggested
      [{ name: "claude-api", verb: "install" }],
    );
    const active = selectActiveSkills(index, null);
    expect(active).toContain("graphify"); // core
    expect(active).toContain("pr-review"); // core
    expect(active).toContain("claude-api"); // matched suggestion
    expect(active).not.toContain("xlsx"); // installed but irrelevant
    expect(active).not.toContain("pptx");
  });

  it("only ever returns installed skills (a suggestion for an uninstalled skill is dropped)", () => {
    const index = idx(["graphify"], [], [{ name: "frontend-design", verb: "install" }]);
    expect(selectActiveSkills(index, null)).toEqual(["graphify"]);
  });

  it("always includes project-local skills regardless of fingerprint", () => {
    const index = idx(["graphify"], ["my-project-skill"], []);
    expect(selectActiveSkills(index, null)).toContain("my-project-skill");
  });
});

describe("selectActiveSkills (explicit user choice)", () => {
  it("honours the user's enabled set, intersected with installed", () => {
    const index = idx(["graphify", "xlsx", "pptx"], [], []);
    // User explicitly enables xlsx (a domain skill) and a non-installed one.
    const active = selectActiveSkills(index, ["xlsx", "not-installed"]);
    expect(active).toContain("xlsx");
    expect(active).not.toContain("graphify"); // core, but user didn't pick it
    expect(active).not.toContain("not-installed");
  });
});

describe("skills.json round-trip", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "marvin-skills-"));
  });
  afterEach(() => {
    /* tmp dir left for the OS to reap */
  });

  it("setEnabledSkills then readEnabledSkills returns the set; absent → null", () => {
    expect(readEnabledSkills(workDir)).toBeNull();
    setEnabledSkills(workDir, ["graphify", "claude-api", "graphify"]);
    expect(readEnabledSkills(workDir)).toEqual(["claude-api", "graphify"]); // deduped + sorted
    const onDisk = JSON.parse(readFileSync(path.join(workDir, ".marvin", "skills.json"), "utf-8"));
    expect(onDisk.source).toBe("user");
  });
});

describe("CORE_SKILLS", () => {
  it("holds the always-on engineering-process skills", () => {
    expect(CORE_SKILLS.has("graphify")).toBe(true);
    expect(CORE_SKILLS.has("systematic-debugging")).toBe(true);
    expect(CORE_SKILLS.has("xlsx")).toBe(false); // domain, not core
  });
});
