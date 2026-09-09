// ADR-0107 — making a fresh session worktree usable. Pins that nothing
// happens without configuration (Golden Rule 6), that only IGNORED files are
// ever copied, that symlinks are created for existing directories only, that
// nothing is overwritten, and the small gitignore-style matcher.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detectWorktreeSetup,
  matchesInclude,
  prepareSessionWorktree,
  readOrDetectWorktreeSetup,
  readWorktreeSetupConfig,
} from "../src/worktree-setup";
import { createSessionWorktree } from "../src/worktrees";

describe("matchesInclude", () => {
  it("anchored, unanchored, globs and directory patterns", () => {
    expect(matchesInclude("/.env", ".env")).toBe(true);
    expect(matchesInclude("/.env", "sub/.env")).toBe(false);
    expect(matchesInclude(".env", "sub/.env")).toBe(true);
    expect(matchesInclude("*.local", "config/app.local")).toBe(true);
    expect(matchesInclude("*.local", "config/app.locale")).toBe(false);
    expect(matchesInclude("config/**", "config/deep/file.json")).toBe(true);
    expect(matchesInclude("dir/", "dir/inner.txt")).toBe(true);
    expect(matchesInclude("dir/", "dir")).toBe(true);
    expect(matchesInclude("# comment", "anything")).toBe(false);
  });
});

describe("prepareSessionWorktree", () => {
  let repo: string;
  let git: (...a: string[]) => string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-wts-")));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n*.local\nbuild/\n");
    git("add", ".");
    git("commit", "-qm", "init");
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "// dep\n");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    writeFileSync(join(repo, "app.local"), "local\n");
    mkdirSync(join(repo, "build"), { recursive: true });
    writeFileSync(join(repo, "build", "out.txt"), "built\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("detects ignored dependency dirs (root and nested) and env-file patterns, never build output or tracked files", () => {
    mkdirSync(join(repo, "apps", "web", "node_modules", "x"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "node_modules", "x", "i.js"), "");
    mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n*.local\nbuild/\n.venv/\n");
    git("add", ".gitignore");
    git("commit", "-qm", "ignore more");
    const cfg = detectWorktreeSetup(repo);
    expect(cfg.symlinkDirectories.sort()).toEqual(["apps/web/node_modules", ".venv", "node_modules"].sort());
    expect(cfg.copyIgnored).toEqual([".env", "*.local"]);
    expect(cfg.honorWorktreeInclude).toBe(true);
    expect(cfg.symlinkDirectories).not.toContain("build");
  });

  it("without a config file, detection is used and written to .marvin/worktree.json for the user to edit", () => {
    const first = readOrDetectWorktreeSetup(repo);
    expect(first.detected).toBe(true);
    expect(first.config.symlinkDirectories).toEqual(["node_modules"]);
    const written = JSON.parse(readFileSync(join(repo, ".marvin", "worktree.json"), "utf-8")) as { detected?: boolean; symlinkDirectories: string[] };
    expect(written.detected).toBe(true);
    expect(written.symlinkDirectories).toEqual(["node_modules"]);
    // Now it is the user's file: a later read honours edits, no re-detection.
    writeFileSync(join(repo, ".marvin", "worktree.json"), JSON.stringify({ symlinkDirectories: [], copyIgnored: [] }));
    const second = readOrDetectWorktreeSetup(repo);
    expect(second.detected).toBe(false);
    expect(second.config.symlinkDirectories).toEqual([]);

    const rec = createSessionWorktree(repo, { sessionId: "s-detect" });
    const report = prepareSessionWorktree(repo, rec.path, first.config);
    expect(report.symlinked).toEqual(["node_modules"]);
    expect(lstatSync(join(rec.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(rec.path, ".env"), "utf-8")).toBe("SECRET=1\n");
  });

  it("does nothing without configuration", () => {
    const rec = createSessionWorktree(repo, { sessionId: "s0" });
    const report = prepareSessionWorktree(repo, rec.path);
    expect(report).toEqual({ symlinked: [], copied: [], skipped: [] });
    expect(existsSync(join(rec.path, ".env"))).toBe(false);
    expect(existsSync(join(rec.path, "node_modules"))).toBe(false);
  });

  it("symlinks configured dirs that exist, copies ignored files matching the patterns, never tracked ones", () => {
    mkdirSync(join(repo, ".marvin"), { recursive: true });
    writeFileSync(
      join(repo, ".marvin", "worktree.json"),
      JSON.stringify({ symlinkDirectories: ["node_modules", "missing-dir", "../escape"], copyIgnored: [".env", "*.local", "README.md"] }),
    );
    const cfg = readWorktreeSetupConfig(repo);
    expect(cfg.symlinkDirectories).toEqual(["node_modules", "missing-dir"]); // `../escape` rejected
    const rec = createSessionWorktree(repo, { sessionId: "s1" });
    const report = prepareSessionWorktree(repo, rec.path, cfg);
    expect(report.symlinked).toEqual(["node_modules"]);
    expect(lstatSync(join(rec.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(report.skipped.map((s) => s.path)).toContain("missing-dir");
    expect(report.copied.sort()).toEqual([".env", "app.local"]);
    expect(readFileSync(join(rec.path, ".env"), "utf-8")).toBe("SECRET=1\n");
    // README.md is tracked — it came with the checkout, it is not "copied".
    expect(report.copied).not.toContain("README.md");
    // build/ is ignored but matched no pattern.
    expect(existsSync(join(rec.path, "build"))).toBe(false);
  });

  it("honours .worktreeinclude and never overwrites", () => {
    writeFileSync(join(repo, ".worktreeinclude"), "# secrets\n.env\nbuild/\n");
    const rec = createSessionWorktree(repo, { sessionId: "s2" });
    writeFileSync(join(rec.path, ".env"), "ALREADY=1\n");
    const report = prepareSessionWorktree(repo, rec.path);
    expect(report.copied).toEqual(["build/out.txt"]);
    expect(report.skipped.find((s) => s.path === ".env")?.reason).toMatch(/already present/);
    expect(readFileSync(join(rec.path, ".env"), "utf-8")).toBe("ALREADY=1\n");
    // Disabled by config.
    mkdirSync(join(repo, ".marvin"), { recursive: true });
    writeFileSync(join(repo, ".marvin", "worktree.json"), JSON.stringify({ honorWorktreeInclude: false }));
    const rec2 = createSessionWorktree(repo, { sessionId: "s3" });
    expect(prepareSessionWorktree(repo, rec2.path).copied).toEqual([]);
  });

  it("a malformed config reads as the defaults", () => {
    mkdirSync(join(repo, ".marvin"), { recursive: true });
    writeFileSync(join(repo, ".marvin", "worktree.json"), "{nope");
    expect(readWorktreeSetupConfig(repo)).toEqual({ symlinkDirectories: [], copyIgnored: [], honorWorktreeInclude: true });
  });
});
