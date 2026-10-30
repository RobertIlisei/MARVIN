import { describe, expect, it } from "vitest";

import { classifyHumanOnlyAct, HUMAN_ONLY_CONFIRM_RULES } from "../src/supervisor-acts";

// ADR-0127 §4 — the acts that, inside a supervisor-touched turn, only the user
// may consent to. Deterministic: read from the tool and its input, never from
// anyone's description of them.

type Tree = { cwd: string; treeMode: "shared" | "worktree" };
const shared: Tree = { cwd: "/repo", treeMode: "shared" };
const worktree: Tree = { cwd: "/repo/.marvin/worktrees/tab-x", treeMode: "worktree" };
const bash = (command: string, tree = shared) => classifyHumanOnlyAct({ toolName: "Bash", input: { command }, ...tree });

describe("classifyHumanOnlyAct — integration (§4 item 1)", () => {
  it.each([
    "git push",
    "git push origin marvin/tab/fix-flags",
    "cd sub && git push --force-with-lease",
    "git merge marvin/tab/other",
    "gh pr create --fill",
    "glab mr create -t x",
    "glab mr merge 12",
    "gh pr merge 4 --squash",
  ])("%s", (cmd) => {
    expect(bash(cmd)?.item).toBe("integration");
    expect(bash(cmd, worktree)?.item).toBe("integration");
  });

  it("the marvin-control merge verb", () => {
    expect(classifyHumanOnlyAct({ toolName: "mcp__marvin-control__worktree_merge", input: { slug: "x" }, ...shared })?.item).toBe("integration");
  });
});

describe("classifyHumanOnlyAct — git's global options do not hide the subcommand (security audit)", () => {
  it.each([
    ["git -C /repo push origin x", "integration"],
    ["git -c user.name=x push", "integration"],
    ["git --git-dir=/repo/.git --work-tree /repo push", "integration"],
    ["git --no-pager merge main", "integration"],
    ["git -C /repo reset --hard", "discard"],
    ["git -C ../other branch -D old", "discard"],
  ])("%s", (cmd, item) => {
    expect(bash(cmd, worktree)?.item).toBe(item);
  });

  it("and in a shared tab the HEAD-moving rule still sees through them", () => {
    expect(bash("git -C /repo checkout main")?.item).toBe("containment");
  });
});

describe("classifyHumanOnlyAct — containment (§4 item 2) is the shared checkout's rule", () => {
  it.each(["git checkout main", "git rebase main", "git switch -c x", "git stash", "git pull"])("%s in a shared tab", (cmd) => {
    expect(bash(cmd)?.item).toBe("containment");
  });

  it.each(["git checkout -b feature", "git stash", "git pull", "git rebase main"])("%s in a worktree tab is routine (its own tree)", (cmd) => {
    expect(bash(cmd, worktree)).toBeNull();
  });
});

describe("classifyHumanOnlyAct — discarding work (§4 item 3)", () => {
  it.each(["git reset --hard HEAD~1", "git checkout -- src/a.ts", "git checkout .", "git restore src/a.ts", "git clean -fd", "git worktree remove ../x", "git branch -D old", "git stash drop"])(
    "%s, in either tree",
    (cmd) => {
      expect(bash(cmd)?.item).toBe("discard");
      expect(bash(cmd, worktree)?.item).toBe("discard");
    },
  );

  it("git restore --staged only unstages; it discards nothing", () => {
    expect(bash("git restore --staged a.ts", worktree)).toBeNull();
  });

  it("the marvin-control remove verb", () => {
    expect(classifyHumanOnlyAct({ toolName: "mcp__marvin-control__worktree_remove", input: { slug: "x" }, ...shared })?.item).toBe("discard");
  });
});

describe("classifyHumanOnlyAct — boundary paths (§4 item 4), the ship-review gate's one list", () => {
  it.each([
    ["Edit", { file_path: "/repo/.env", old_string: "a", new_string: "b" }],
    ["Write", { file_path: "/repo/.env.production", content: "X=1" }],
    ["Write", { file_path: "/repo/db/migrations/0002_add.sql", content: "" }],
    ["Edit", { file_path: "/repo/.github/workflows/ci.yml", old_string: "a", new_string: "b" }],
    ["Write", { file_path: "/repo/.gitlab-ci.yml", content: "" }],
    ["Write", { file_path: "/repo/src/auth/login.ts", content: "" }],
  ])("%s %j", (toolName, input) => {
    expect(classifyHumanOnlyAct({ toolName, input, ...shared })?.item).toBe("boundary-path");
  });

  it("a relative path resolves against the tab's tree", () => {
    expect(classifyHumanOnlyAct({ toolName: "Write", input: { file_path: ".env", content: "" }, ...worktree })?.item).toBe("boundary-path");
  });

  it("an ordinary source file is not on the list", () => {
    expect(classifyHumanOnlyAct({ toolName: "Edit", input: { file_path: "/repo/src/flags.ts", old_string: "a", new_string: "b" }, ...shared })).toBeNull();
  });

  it.each(["echo KEY=1 > .env", "printf x >> .env.local", "cat a | tee .gitlab-ci.yml", "tee -a db/migrations/1.sql < x", "cp tmp.yml .github/workflows/ci.yml", "mv new .env", "sed -i '' s/a/b/ .env"])(
    "a plain shell write to a boundary path: %s",
    (cmd) => {
      expect(bash(cmd, worktree)?.item).toBe("boundary-path");
    },
  );

  it("reading a boundary path is not writing it", () => {
    expect(bash("cat .env.example | grep KEY", worktree)).toBeNull();
    expect(bash("echo hi > notes.txt", worktree)).toBeNull();
  });
});

describe("classifyHumanOnlyAct — external MCP tools", () => {
  it("a plugin server's tool has unknown effects: merge, deploy, pipeline", () => {
    expect(classifyHumanOnlyAct({ toolName: "mcp__plugin_gitlab_gitlab__merge_merge_request", input: {}, ...shared })?.item).toBe("external-mcp");
  });

  it("MARVIN's own servers and the browser are not external", () => {
    expect(classifyHumanOnlyAct({ toolName: "mcp__marvin-graph__graph_query", input: {}, ...shared })).toBeNull();
    expect(classifyHumanOnlyAct({ toolName: "mcp__marvin-backlog__backlog_add", input: {}, ...shared })).toBeNull();
    expect(classifyHumanOnlyAct({ toolName: "mcp__playwright__browser_click", input: {}, ...shared })).toBeNull();
  });
});

describe("classifyHumanOnlyAct — ordinary work is not escalated", () => {
  it.each(["ls -la", "pnpm test", "git status", "git diff", "git log --oneline", "git add -A", "git commit -m x", "npx vitest run"])("%s", (cmd) => {
    expect(bash(cmd)).toBeNull();
  });

  it("Read, Grep and the graph are never acts", () => {
    expect(classifyHumanOnlyAct({ toolName: "Read", input: { file_path: "/repo/.env" }, ...shared })).toBeNull();
  });
});

describe("HUMAN_ONLY_CONFIRM_RULES — the confirm kinds that are §4 acts by the rule that raised them", () => {
  it("names the containment and money rules, not an ordinary gated card or a question", () => {
    expect([...HUMAN_ONLY_CONFIRM_RULES].sort()).toEqual(["lane", "metered-ci", "session-worktree", "shared-tree", "supervisor-touched"]);
  });
});
