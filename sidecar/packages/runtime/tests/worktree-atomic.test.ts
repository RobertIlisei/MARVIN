// ADR-0122 — a tab's worktree is created atomically or not at all. Pins:
// a failing `git worktree add` (the 2026-10-06 full disk) throws and leaves no
// record, branch or directory behind; a failure AFTER the add rolls it back;
// the disk preflight refuses below the floor; `sparseExclude` makes a lighter
// checkout whose commits and merges still work; and the read boundary for the
// project-controlled `sparseExclude` / `minFreeGb` keys.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPreparedSessionWorktree, prepareSessionWorktree, readWorktreeSetupConfig, rethrowIfDiskFull, safeSparsePath } from "../src/worktree-setup";
import { createWorktree, listWorktrees, mergeWorktree, worktreeMinFreeBytes } from "../src/worktrees";

describe("atomic session worktrees (ADR-0122)", () => {
  let repo: string;
  let shimDir: string;
  let git: (...a: string[]) => string;
  const realPath = process.env.PATH ?? "";
  const savedMin = process.env.MARVIN_WORKTREE_MIN_FREE_GB;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-atomic-")));
    shimDir = realpathSync(mkdtempSync(join(tmpdir(), "marvin-shim-")));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    mkdirSync(join(repo, "docs", "reference-corpus"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "docs", "reference-corpus", "big.pdf"), "pdf\n");
    writeFileSync(join(repo, "docs", "guide.md"), "guide\n");
    writeFileSync(join(repo, "src", "a.ts"), "a\n");
    git("add", ".");
    git("commit", "-qm", "init");
    // The suite must not depend on how full the machine running it is.
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "0";
  });

  afterEach(() => {
    process.env.PATH = realPath;
    if (savedMin === undefined) delete process.env.MARVIN_WORKTREE_MIN_FREE_GB;
    else process.env.MARVIN_WORKTREE_MIN_FREE_GB = savedMin;
    rmSync(repo, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  /** A `git` that fails the given subcommand (optionally only for some argv) and delegates the rest. */
  const failingGit = (subcommand: string, message = "fatal: could not write: No space left on device") => {
    const real = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
    const shim = join(shimDir, "git");
    writeFileSync(
      shim,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "${subcommand}" ]; then echo "${message}" >&2; exit 128; fi; done\nexec "${real}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    process.env.PATH = `${shimDir}${delimiter}${realPath}`;
  };

  const branches = () => git("branch", "--list", "marvin/tab/*");
  const mainIsUntouched = () => {
    // `.marvin/` (MARVIN's own state) is the one thing allowed to appear.
    expect(git("status", "--porcelain", "--untracked-files=all", "--", ".", ":!.marvin")).toBe("");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  };

  it("a failing `git worktree add` throws with the reason and leaves nothing behind", () => {
    failingGit("worktree");
    expect(() => createPreparedSessionWorktree(repo, { sessionId: "s-full", title: "full disk" })).toThrow(/No space left on device/);
    process.env.PATH = realPath;
    expect(listWorktrees(repo)).toEqual([]);
    expect(branches()).toBe("");
    expect(existsSync(join(repo, ".marvin", "worktrees", "tab-full-disk"))).toBe(false);
    mainIsUntouched();
  });

  it("a failure after the add rolls the whole tree back (checkout, branch, record)", () => {
    mkdirSync(join(repo, ".marvin"), { recursive: true });
    writeFileSync(join(repo, ".marvin", "worktree.json"), JSON.stringify({ sparseExclude: ["docs/reference-corpus"] }));
    failingGit("sparse-checkout");
    expect(() => createPreparedSessionWorktree(repo, { sessionId: "s-mid", title: "mid failure" })).toThrow(/No space left/);
    process.env.PATH = realPath;
    expect(listWorktrees(repo)).toEqual([]);
    expect(branches()).toBe("");
    expect(existsSync(join(repo, ".marvin", "worktrees", "tab-mid-failure"))).toBe(false);
    expect(git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  it("refuses below the free-space floor, naming both numbers and the knobs", () => {
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "999999";
    let msg = "";
    try {
      createPreparedSessionWorktree(repo, { sessionId: "s-low", title: "low disk" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/not enough free disk space/);
    expect(msg).toMatch(/GB free, at least 999999\.0 GB required/);
    expect(msg).toMatch(/MARVIN_WORKTREE_MIN_FREE_GB/);
    expect(listWorktrees(repo)).toEqual([]);
    expect(branches()).toBe("");
  });

  it("an implementer's worktree is atomic and floor-checked too", () => {
    failingGit("worktree");
    expect(() => createWorktree(repo, "do a thing")).toThrow(/No space left/);
    process.env.PATH = realPath;
    expect(listWorktrees(repo)).toEqual([]);
    expect(git("branch", "--list", "marvin/*")).toBe("");
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "999999";
    expect(() => createWorktree(repo, "do a thing")).toThrow(/not enough free disk space/);
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "0";
    expect(createWorktree(repo, "do a thing").state).toBe("running");
  });

  it("the floor: env wins over the project, the project over the default, junk is ignored", () => {
    delete process.env.MARVIN_WORKTREE_MIN_FREE_GB;
    expect(worktreeMinFreeBytes()).toBe(10 * 1024 ** 3);
    expect(worktreeMinFreeBytes(2)).toBe(2 * 1024 ** 3);
    expect(worktreeMinFreeBytes(Number.NaN)).toBe(10 * 1024 ** 3);
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "1";
    expect(worktreeMinFreeBytes(2)).toBe(1024 ** 3);
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "garbage";
    expect(worktreeMinFreeBytes(2)).toBe(2 * 1024 ** 3);
    process.env.MARVIN_WORKTREE_MIN_FREE_GB = "";
    expect(worktreeMinFreeBytes()).toBe(10 * 1024 ** 3);
  });

  it("setup is best-effort per entry, except a full disk, which must fail the tab", () => {
    expect(() => rethrowIfDiskFull(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))).toThrow(/ENOSPC/);
    expect(() => rethrowIfDiskFull(Object.assign(new Error("EDQUOT"), { code: "EDQUOT" }))).toThrow(/EDQUOT/);
    expect(() => rethrowIfDiskFull(Object.assign(new Error("EACCES"), { code: "EACCES" }))).not.toThrow();
    expect(() => rethrowIfDiskFull("not an error")).not.toThrow();
    // An ordinary per-entry failure still only lands in `skipped`.
    mkdirSync(join(repo, "deps"));
    const report = prepareSessionWorktree(repo, join(repo, "missing-wt"), { ...readWorktreeSetupConfig(repo), symlinkDirectories: ["deps", "nope"] });
    expect(report.skipped.some((x) => x.path === "nope")).toBe(true);
  });

  describe("sparseExclude", () => {
    const withConfig = (cfg: object) => {
      mkdirSync(join(repo, ".marvin"), { recursive: true });
      writeFileSync(join(repo, ".marvin", "worktree.json"), JSON.stringify(cfg));
    };

    it("leaves the excluded directory out; everything else is there and the tree is clean", () => {
      withConfig({ sparseExclude: ["docs/reference-corpus"] });
      const { record, sparseExclude } = createPreparedSessionWorktree(repo, { sessionId: "s-sparse", title: "sparse tab" });
      expect(sparseExclude).toEqual(["docs/reference-corpus"]);
      expect(existsSync(join(record.path, "docs", "reference-corpus"))).toBe(false);
      expect(existsSync(join(record.path, "docs", "guide.md"))).toBe(true);
      expect(existsSync(join(record.path, "src", "a.ts"))).toBe(true);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: record.path, encoding: "utf-8" }).trim()).toBe("");
      // The main checkout is neither sparse nor dirty.
      expect(existsSync(join(repo, "docs", "reference-corpus", "big.pdf"))).toBe(true);
      expect(git("status", "--porcelain")).not.toMatch(/reference-corpus/);
    });

    it("commits and merges still work, and the excluded paths are untouched in the merge", () => {
      withConfig({ sparseExclude: ["docs/reference-corpus"] });
      const { record } = createPreparedSessionWorktree(repo, { sessionId: "s-merge", title: "merge tab" });
      writeFileSync(join(record.path, "src", "b.ts"), "b\n");
      execFileSync("git", ["add", "-A"], { cwd: record.path });
      execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "commit", "-qm", "add b"], { cwd: record.path });
      // The commit did not delete the paths the checkout never had.
      expect(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: record.path, encoding: "utf-8" })).toMatch(/docs\/reference-corpus\/big\.pdf/);
      const out = mergeWorktree(repo, record.slug);
      expect(out.ok).toBe(true);
      expect(readFileSync(join(repo, "src", "b.ts"), "utf-8")).toBe("b\n");
      expect(readFileSync(join(repo, "docs", "reference-corpus", "big.pdf"), "utf-8")).toBe("pdf\n");
      expect(git("status", "--porcelain", "--", ".", ":!.marvin")).toBe("");
    });

    it("main moving inside the excluded path does not break the tab's catch-up merge", () => {
      withConfig({ sparseExclude: ["docs/reference-corpus"] });
      const { record } = createPreparedSessionWorktree(repo, { sessionId: "s-sync", title: "sync tab" });
      writeFileSync(join(repo, "docs", "reference-corpus", "new.pdf"), "n\n");
      git("add", "docs/reference-corpus/new.pdf");
      git("commit", "-qm", "corpus grows");
      execFileSync("git", ["-c", "user.email=t@x", "-c", "user.name=t", "merge", "-q", "--no-edit", "main"], { cwd: record.path });
      expect(existsSync(join(record.path, "docs", "reference-corpus"))).toBe(false);
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: record.path, encoding: "utf-8" }).trim()).toBe("");
    });

    it("an old git is refused by name, not ignored", () => {
      withConfig({ sparseExclude: ["docs/reference-corpus"] });
      const real = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
      writeFileSync(join(shimDir, "git"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.30.0"; exit 0; fi\nexec "${real}" "$@"\n`);
      chmodSync(join(shimDir, "git"), 0o755);
      process.env.PATH = `${shimDir}${delimiter}${realPath}`;
      expect(() => createPreparedSessionWorktree(repo, { sessionId: "s-old", title: "old git" })).toThrow(/needs git 2\.36/);
      process.env.PATH = realPath;
      expect(listWorktrees(repo)).toEqual([]);
    });
  });
});

describe("worktree.json read boundary (ADR-0122)", () => {
  let repo: string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-rb-")));
    mkdirSync(join(repo, ".marvin"), { recursive: true });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  const write = (cfg: object) => writeFileSync(join(repo, ".marvin", "worktree.json"), JSON.stringify(cfg));

  it("accepts plain relative directories, drops everything that is pattern or path syntax", () => {
    const good = ["docs/reference-corpus", "docs/my ref", "a/b.c/d@1+2", "x/", ".github"];
    const bad = [
      "", "/abs", "../up", "a/../b", "a/./b", "a//b", ".", "..", ".git", "a/.GIT/b",
      "a/*", "a?b", "a[1]", "!neg", "#c", "a\\b", "a\nb", " lead", "trail ", "a/ b /c", "a/b\u0000", "~/x", "$HOME/x",
      "x".repeat(201), 5, null, {},
    ];
    for (const g of good) expect(safeSparsePath(g), String(g)).not.toBeNull();
    for (const b of bad) expect(safeSparsePath(b), JSON.stringify(b)).toBeNull();
    write({ sparseExclude: [...good, ...bad, "docs/reference-corpus"] });
    expect(readWorktreeSetupConfig(repo).sparseExclude).toEqual(["docs/reference-corpus", "docs/my ref", "a/b.c/d@1+2", "x", ".github"]);
  });

  it("caps the list, tolerates a non-array, defaults to none", () => {
    write({ sparseExclude: Array.from({ length: 200 }, (_, i) => `d${i}`) });
    expect(readWorktreeSetupConfig(repo).sparseExclude).toHaveLength(64);
    write({ sparseExclude: "docs" });
    expect(readWorktreeSetupConfig(repo).sparseExclude).toEqual([]);
    write({});
    expect(readWorktreeSetupConfig(repo).sparseExclude).toEqual([]);
  });

  it("minFreeGb: a non-negative finite number within range, else undefined", () => {
    write({ minFreeGb: 3 });
    expect(readWorktreeSetupConfig(repo).minFreeGb).toBe(3);
    write({ minFreeGb: 0 });
    expect(readWorktreeSetupConfig(repo).minFreeGb).toBe(0);
    for (const v of [-1, "3", null, 1e9, Number.NaN]) {
      write({ minFreeGb: v });
      expect(readWorktreeSetupConfig(repo).minFreeGb, JSON.stringify(v)).toBeUndefined();
    }
  });
});
