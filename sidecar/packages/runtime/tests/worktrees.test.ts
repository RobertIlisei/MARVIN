import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { classifyToolCall } from "../src/sdk-runner";
import { _resetSubagentRegistry, lookupSubagent, registerSubagent, taskStartedPayload } from "../src/subagent-registry";
import { createWorktree, implementerWorktreePolicy, isInsideWorktree, listWorktrees, removeWorktree, worktreeSlug } from "../src/worktrees";

// ADR-0081 — implementer subagents may write ONLY inside a worktree MARVIN
// created. These pin the containment: the main tree stays sealed, the
// worktree opens, Bash is pinned to the tree, and anyone who is not a bound
// implementer gets the ADR-0030 read-only collapse exactly as before.

const WT = "/proj/.marvin/worktrees/add-login";
const WORKDIR = "/proj";

describe("isInsideWorktree", () => {
  it("accepts the tree itself and anything under it, rejects siblings and parents", () => {
    expect(isInsideWorktree(WT, WT)).toBe(true);
    expect(isInsideWorktree(`${WT}/src/a.ts`, WT)).toBe(true);
    expect(isInsideWorktree("/proj/src/a.ts", WT)).toBe(false);
    expect(isInsideWorktree("/proj/.marvin/worktrees/add-login-2/x", WT)).toBe(false);
    expect(isInsideWorktree(`${WT}/../../../src/a.ts`, WT)).toBe(false);
  });
});

describe("implementerWorktreePolicy", () => {
  it("allows an absolute write inside the worktree", () => {
    const d = implementerWorktreePolicy("Write", { file_path: `${WT}/src/login.ts` }, WT, WORKDIR);
    expect(d?.decision).toBe("allow");
  });

  it("denies a write to the main tree — including a RELATIVE path, which resolves there", () => {
    expect(implementerWorktreePolicy("Edit", { file_path: "/proj/src/login.ts" }, WT, WORKDIR)?.decision).toBe("deny");
    const rel = implementerWorktreePolicy("Write", { file_path: "src/login.ts" }, WT, WORKDIR);
    expect(rel?.decision).toBe("deny");
    expect(rel?.reason).toContain("ABSOLUTE path");
  });

  it("pins Bash to the worktree by rewriting the command", () => {
    const d = implementerWorktreePolicy("Bash", { command: "npm test" }, WT, WORKDIR);
    expect(d?.decision).toBe("allow");
    expect(d?.updatedInput?.command).toBe(`cd '${WT}' && (npm test)`);
    // Idempotent: our own rewrite echoed back is left alone.
    const again = implementerWorktreePolicy("Bash", { command: `cd '${WT}' && (npm test)` }, WT, WORKDIR);
    expect(again?.updatedInput).toBeUndefined();
  });

  it("denies shell that escapes: `..`, `~`, absolute paths outside the tree", () => {
    for (const command of ["cat ../../secrets", "ls ~/.ssh", "cp x /proj/src/a.ts", "rm -rf /proj"]) {
      expect(implementerWorktreePolicy("Bash", { command }, WT, WORKDIR)?.decision, command).toBe("deny");
    }
  });

  it("still allows toolchain binaries and the worktree's own absolute paths", () => {
    for (const command of ["/usr/bin/env node -v", `cat ${WT}/package.json`, "echo hi > /dev/null"]) {
      expect(implementerWorktreePolicy("Bash", { command }, WT, WORKDIR)?.decision, command).toBe("allow");
    }
  });

  it("keeps the destructive / publish hard-deny floor", () => {
    expect(implementerWorktreePolicy("Bash", { command: "git push --force origin main" }, WT, WORKDIR)?.decision).toBe("deny");
  });

  it("does not govern reads", () => {
    expect(implementerWorktreePolicy("Read", { file_path: "/proj/x" }, WT, WORKDIR)).toBeNull();
  });
});

describe("classifyToolCall with a bound implementer", () => {
  it("opens the worktree and only the worktree; unbound subagents stay read-only", () => {
    const bound = { agentID: "impl-1", worktree: WT, workDir: WORKDIR };
    expect(classifyToolCall("Write", { file_path: `${WT}/a.ts` }, bound).decision).toBe("allow");
    expect(classifyToolCall("Write", { file_path: "/proj/a.ts" }, bound).decision).toBe("deny");
    expect(classifyToolCall("Bash", { command: "npm test" }, bound).updatedInput?.command).toContain(`cd '${WT}'`);
    // Same call, no binding → ADR-0030 collapse, unchanged.
    const r = classifyToolCall("Write", { file_path: `${WT}/a.ts` }, { agentID: "scout-1" });
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("Golden Rule 1");
  });

  it("is not granted in Ask mode", () => {
    const r = classifyToolCall("Write", { file_path: `${WT}/a.ts` }, { agentID: "impl-1", worktree: WT, workDir: WORKDIR, readOnly: true });
    expect(r.decision).toBe("deny");
  });
});

describe("subagent registry", () => {
  beforeEach(() => _resetSubagentRegistry());

  it("binds an implementer to the ONE worktree its prompt names", () => {
    const b = registerSubagent({ turnId: "t", taskId: "task-1", subagentType: "implementer", prompt: `Your worktree is ${WT}. Build login.`, worktrees: [WT, "/proj/.marvin/worktrees/other"] });
    expect(b.worktree).toBe(WT);
    expect(lookupSubagent("task-1")?.worktree).toBe(WT);
  });

  it("leaves it unbound when the prompt names none or several — the safe default", () => {
    expect(registerSubagent({ turnId: "t", taskId: "a", subagentType: "implementer", prompt: "build login", worktrees: [WT] }).worktree).toBeUndefined();
    expect(registerSubagent({ turnId: "t", taskId: "b", subagentType: "implementer", prompt: `${WT} and /proj/.marvin/worktrees/other`, worktrees: [WT, "/proj/.marvin/worktrees/other"] }).worktree).toBeUndefined();
    // A scout that mentions a worktree path is never bound.
    expect(registerSubagent({ turnId: "t", taskId: "c", subagentType: "scout", prompt: WT, worktrees: [WT] }).worktree).toBeUndefined();
  });

  it("parses task_started and ignores other system messages", () => {
    expect(taskStartedPayload({ type: "system", subtype: "task_started", task_id: "x", subagent_type: "implementer", prompt: "p" })).toEqual({ task_id: "x", subagent_type: "implementer", prompt: "p" });
    expect(taskStartedPayload({ type: "system", subtype: "task_notification", task_id: "x" })).toBeNull();
  });
});

describe("worktree lifecycle (real git)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "marvin-wt-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  afterEach(() => _resetSubagentRegistry());

  it("creates a registered worktree on a marvin/ branch from HEAD, excluded from status, and removes it keeping the branch", () => {
    const rec = createWorktree(repo, "Add login page");
    expect(rec.branch).toBe("marvin/add-login-page");
    expect(existsSync(join(rec.path, "README.md"))).toBe(true);
    expect(listWorktrees(repo).map((w) => w.slug)).toEqual(["add-login-page"]);
    const status = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf-8" });
    expect(status).not.toContain(".marvin/worktrees");
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf-8")).toContain(".marvin/worktrees/");
    // A second task with the same slug gets a distinct name — MARVIN assigns it.
    expect(createWorktree(repo, "Add login page").slug).toBe("add-login-page-2");

    removeWorktree(repo, "add-login-page");
    expect(existsSync(rec.path)).toBe(false);
    const branches = execFileSync("git", ["branch", "--list", "marvin/*"], { cwd: repo, encoding: "utf-8" });
    expect(branches).toContain("marvin/add-login-page");
  });

  it("slugs are bounded and safe", () => {
    expect(worktreeSlug("  Fix: the (weird) thing!! ")).toBe("fix-the-weird-thing");
    expect(worktreeSlug("x".repeat(100)).length).toBeLessThanOrEqual(40);
    expect(worktreeSlug("///")).toBe("task");
  });
});
