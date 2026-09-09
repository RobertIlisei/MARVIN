// ADR-0107 — a chat tab running in its own worktree stays in it. The
// containment sits in `makeAutoModeLogger` (MARVIN's default callback, whose
// contract is "never blocks on UI") so it is pinned the way the shared-tree
// gate is: the one narrow deny (a write into the MAIN checkout), the one
// narrow confirm (shell that names the main tree), and — just as important —
// that everything else is untouched: relative writes, unrelated absolute
// paths, plain commands, subagents, shared-mode tabs.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAutoModeLogger } from "../src/sdk-runner";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";
import { mainTreeRedirect, sessionWorktreePolicy } from "../src/worktrees";

let root: string;
let wt: string;
const opened: Array<{ toolUseId: string; toolName: string; reason: string }> = [];
const meta = (toolUseID: string, agentID?: string) => ({ toolUseID, ...(agentID ? { agentID } : {}) }) as never;

function decided<T>(result: T | null | undefined): T {
  expect(result).toBeTruthy();
  return result as T;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-swt-gate-")));
  wt = path.join(root, ".marvin", "worktrees", "tab-x");
  mkdirSync(wt, { recursive: true });
  opened.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gate(mode: "worktree" | "shared", withUI = true) {
  const sessionTree =
    mode === "worktree"
      ? ({ mode: "worktree", slug: "x", path: wt, branch: "marvin/tab/x", base: "abc" } as const)
      : ({ mode: "shared" } as const);
  return makeAutoModeLogger({
    cwd: mode === "worktree" ? wt : root,
    workDir: root,
    sessionTree,
    turnId: "turn-W",
    checkpoint: { projectId: "p", marvinSessionId: "session-W" },
    ...(withUI
      ? { onConfirmRequest: (req) => opened.push({ toolUseId: req.toolUseId, toolName: req.toolName, reason: req.reason ?? "" }) }
      : {}),
  });
}

describe("sessionWorktreePolicy (pure)", () => {
  it("relative and in-worktree writes fall through; writes into the main tree are denied", () => {
    expect(sessionWorktreePolicy("Edit", { file_path: "src/a.ts" }, wt, root)).toBeNull();
    expect(sessionWorktreePolicy("Write", { file_path: path.join(wt, "b.ts") }, wt, root)).toBeNull();
    const d = sessionWorktreePolicy("Edit", { file_path: path.join(root, "src", "a.ts") }, wt, root);
    expect(d?.decision).toBe("deny");
    expect(d?.reason).toMatch(/MAIN checkout/);
    expect(d?.reason).toContain(wt);
    // Outside the project entirely → the normal ladder decides.
    expect(sessionWorktreePolicy("Write", { file_path: "/tmp/elsewhere.txt" }, wt, root)).toBeNull();
  });

  it("shell that names the main tree confirms; plain shell falls through", () => {
    expect(sessionWorktreePolicy("Bash", { command: "npm test" }, wt, root)).toBeNull();
    expect(sessionWorktreePolicy("Bash", { command: `cd '${wt}' && npm test` }, wt, root)).toBeNull();
    expect(sessionWorktreePolicy("Bash", { command: `cd ${root} && git status` }, wt, root)?.decision).toBe("confirm");
    expect(sessionWorktreePolicy("Bash", { command: `git -C ${root} rebase main` }, wt, root)?.decision).toBe("confirm");
    expect(sessionWorktreePolicy("Bash", { command: `GIT_WORK_TREE=${root} git status` }, wt, root)?.decision).toBe("confirm");
    // Addendum 3 — reading the shared checkout is not contained; writing into it is.
    expect(sessionWorktreePolicy("Bash", { command: `cat ${root}/README.md` }, wt, root)).toBeNull();
    expect(sessionWorktreePolicy("Bash", { command: `echo hi > ${root}/notes.md` }, wt, root)?.decision).toBe("confirm");
    expect(sessionWorktreePolicy("Read", { file_path: path.join(root, "x") }, wt, root)).toBeNull();
  });

  it("mainTreeRedirect: reads of the main tree fall through, writes in every shape confirm", () => {
    const reads = [
      `cat ${root}/README.md`,
      `grep -rn foo ${root}/docs | head`,
      `python3 -c "import json; json.load(open('${root}/docs/spec.json'))"`,
      `git log --oneline ${root}/docs`,
      `git diff HEAD -- ${root}/docs/x.md`,
      `ls -la "${root}/apps"`,
      `node -e "require('fs').readFileSync('${root}/package.json')"`,
    ];
    for (const c of reads) expect(mainTreeRedirect(c, root, wt), c).toBeNull();
    // The reported false positive: copying a spec file FROM the main
    // checkout INTO the worktree reads the source and writes here.
    const sourceReads = [
      `mkdir -p docs && cp ${root}/docs/smartbill-openapi-spec.json docs/smartbill-openapi-spec.json && ls -la docs/smartbill-openapi-spec.json`,
      `cp ${root}/docs/spec.json ./docs/spec.json`,
      `cp -r ${root}/apps/web/src ./src`,
      `rsync -a ${root}/fixtures/ ./fixtures/`,
      `dd if=${root}/a.img of=./b.img`,
      `ln -s ${root}/node_modules node_modules`,
    ];
    for (const c of sourceReads) expect(mainTreeRedirect(c, root, wt), c).toBeNull();
    const destWrites = [
      `cp ./out.json ${root}/docs/out.json`,
      `mv ./a ${root}/b`,
      `cp -t ${root}/docs ./a.json`,
      `cp --target-directory=${root}/docs ./a.json`,
      `rsync -a ./dist/ ${root}/dist/`,
      `dd if=./a of=${root}/b.img`,
    ];
    for (const c of destWrites) expect(mainTreeRedirect(c, root, wt), c).not.toBeNull();
    const writes = [
      `echo hi > ${root}/notes.md`,
      `cat x >> "${root}/notes.md"`,
      `rm -rf ${root}/build`,
      `cp a.txt ${root}/b.txt`,
      `mkdir -p ${root}/tmp/out`,
      `sed -i '' 's/a/b/' ${root}/x.md`,
      `git add ${root}/x.md`,
      `git checkout -- ${root}/x.md`,
      `python3 -c "open('${root}/x.json','w').write('1')"`,
      `python3 -c "open('${root}/x.json', mode='a')"`,
      `node -e "require('fs').writeFileSync('${root}/x.json','1')"`,
      `tee ${root}/x.log`,
      `npm test && rm ${root}/x`,
    ];
    for (const c of writes) expect(mainTreeRedirect(c, root, wt), c).not.toBeNull();
  });

  it("mainTreeRedirect names the fragment and ignores worktree paths", () => {
    expect(mainTreeRedirect(`cd ${root}`, root, wt)).toBe(`cd ${root}`);
    expect(mainTreeRedirect(`ls ${wt}/src`, root, wt)).toBeNull();
    expect(mainTreeRedirect(`ls ${root}/.marvin/worktrees/tab-other`, root, wt)).toBeNull();
    expect(mainTreeRedirect("echo hello", root, wt)).toBeNull();
    // A prefix-sibling of the root is not the root.
    expect(mainTreeRedirect(`ls ${root}-other/file`, root, wt)).toBeNull();
  });
});

describe("session-worktree gate — through makeAutoModeLogger", () => {
  it("denies a write into the main checkout, allows one inside the worktree", async () => {
    const g = gate("worktree");
    const deny = decided(await g("Edit", { file_path: path.join(root, "README.md"), old_string: "a", new_string: "b" }, meta("u1")));
    expect(deny.behavior).toBe("deny");
    const ok = decided(await g("Edit", { file_path: path.join(wt, "README.md"), old_string: "a", new_string: "b" }, meta("u2")));
    expect(ok.behavior).toBe("allow");
    expect(opened).toEqual([]);
  });

  it("confirms shell that names the main tree — in auto mode, with the UI", async () => {
    const g = gate("worktree");
    const pending = g("Bash", { command: `cd ${root} && npm test` }, meta("u3"));
    await new Promise((r) => setTimeout(r, 10));
    expect(opened.map((o) => [o.toolUseId, o.toolName])).toEqual([["u3", "Bash"]]);
    expect(opened[0]?.reason).toMatch(/main checkout/);
    // Resolve so the promise settles (the registry test seam).
    const { resolvePendingConfirm } = await import("../src/confirm-registry");
    resolvePendingConfirm("turn-W", "u3", { behavior: "deny", message: "no", interrupt: false });
    const result = decided(await pending);
    expect(result.behavior).toBe("deny");
  });

  it("denies rather than runs when no UI is attached", async () => {
    const g = gate("worktree", false);
    const r = decided(await g("Bash", { command: `git -C ${root} status` }, meta("u4")));
    expect(r.behavior).toBe("deny");
  });

  it("a plain command in the worktree is untouched — no rewrite, no confirm", async () => {
    const g = gate("worktree");
    const r = decided(await g("Bash", { command: "npm test" }, meta("u5")));
    expect(r.behavior).toBe("allow");
    expect((r as { updatedInput?: { command?: string } }).updatedInput?.command ?? "npm test").toBe("npm test");
    expect(opened).toEqual([]);
  });

  it("the shared-tree collision confirm does NOT fire for a worktree tab", async () => {
    const other = registerLiveTurn({ turnId: "turn-O", marvinSessionId: "session-O", projectId: "p" });
    try {
      const g = gate("worktree");
      const r = decided(await g("Bash", { command: "git checkout -b feature" }, meta("u6")));
      expect(r.behavior).toBe("allow");
      expect(opened).toEqual([]);
    } finally {
      endLiveTurn(other, { event: "turn.completed", data: {} });
    }
  });

  it("a shared-mode tab is unaffected by the containment", async () => {
    const g = gate("shared");
    const r = decided(await g("Edit", { file_path: path.join(root, "README.md"), old_string: "a", new_string: "b" }, meta("u7")));
    expect(r.behavior).toBe("allow");
  });

  it("a subagent call is not contained by the session policy", async () => {
    const g = gate("worktree");
    // A subagent write into the main tree is governed by the subagent ladder
    // (read-only collapse), not by this gate — so the reason must not be ours.
    const r = decided(await g("Edit", { file_path: path.join(root, "README.md"), old_string: "a", new_string: "b" }, meta("u8", "agent-1")));
    expect(r.behavior).toBe("deny");
    expect((r as { message?: string }).message ?? "").not.toMatch(/MAIN checkout/);
  });
});
