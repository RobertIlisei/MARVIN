// ADR-0107 — a chat session may run in its own worktree, so the cwd a route
// accepts is no longer "exactly a registered project dir". It is that, OR a
// worktree the REGISTRY knows under a registered project that git still
// lists. Everything else — an arbitrary dir, an unregistered dir under
// `.marvin/worktrees/`, a registry entry whose checkout is gone — is refused.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkFsPath } from "../src/fs-sandbox";
import { addProject } from "../src/projects";
import { validateSessionCwd } from "../src/session-cwd";
import { createWorktree } from "../src/worktrees";

let dataDir: string;
let repo: string;
let git: (...a: string[]) => string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "marvin-session-cwd-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  // realpath: macOS /var → /private/var, and the registry compares canonical paths.
  repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-session-cwd-")));
  git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@x");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", ".");
  git("commit", "-qm", "init");
  addProject({ workDir: repo });
});

afterEach(() => {
  delete process.env.MARVIN_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("validateSessionCwd", () => {
  it("accepts the project root itself, workDir === cwd", () => {
    const r = validateSessionCwd(repo);
    expect(r).toEqual({ ok: true, workDir: repo, cwd: repo, worktree: null });
  });

  it("accepts a registered worktree of the project, workDir = the root", () => {
    const rec = createWorktree(repo, "session tab");
    const r = validateSessionCwd(rec.path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workDir).toBe(repo);
      expect(r.cwd).toBe(rec.path);
      expect(r.worktree?.slug).toBe(rec.slug);
    }
  });

  it("refuses a directory under .marvin/worktrees/ that the registry does not know", () => {
    const rogue = join(repo, ".marvin", "worktrees", "rogue");
    mkdirSync(rogue, { recursive: true });
    const r = validateSessionCwd(rogue);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("refuses a registry entry whose checkout git no longer lists", () => {
    const rec = createWorktree(repo, "gone");
    // Remove the checkout behind the registry's back, as a `git worktree
    // remove` in a terminal would; the record is stale, the path is not a
    // worktree any more.
    git("worktree", "remove", "--force", rec.path);
    const r = validateSessionCwd(rec.path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("refuses anything that is not under a registered project", () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "marvin-not-a-project-")));
    try {
      const r = validateSessionCwd(other);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
      expect(validateSessionCwd("relative/path").ok).toBe(false);
      expect(validateSessionCwd("").ok).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("checkFsPath with a session worktree cwd", () => {
  it("the sandbox boundary becomes the worktree root", async () => {
    const rec = createWorktree(repo, "sandbox");
    const inside = join(rec.path, "README.md");
    const ok = await checkFsPath({ cwd: rec.path, target: inside });
    expect(ok.ok).toBe(true);
    // A path in the MAIN checkout is outside this cwd's boundary.
    const escape = await checkFsPath({ cwd: rec.path, target: join(repo, "README.md") });
    expect(escape.ok).toBe(false);
    if (!escape.ok) expect(escape.error).toBe("path-escapes-cwd");
  });

  it("an unregistered cwd is still refused", async () => {
    const rogue = join(repo, ".marvin", "worktrees", "rogue2");
    mkdirSync(rogue, { recursive: true });
    const r = await checkFsPath({ cwd: rogue, target: join(rogue, "x"), mustExist: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cwd-not-registered");
  });
});
