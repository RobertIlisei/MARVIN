/**
 * ADR-0124 — Bash source reads go through the graphify-first gate, and after a
 * graph call the graph-pointer rule refuses whole-file reads of large files and
 * repo-wide searches while letting narrow, graph-pointed reads through.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_GATE_MAX_DENIES,
  createTurnDesignContext,
  type DesignTurnContext,
  noteGraphResult,
  recordAllowedTool,
  repoRelativePath,
  runDesignHooks,
} from "../src/design-hooks";
import { __resetBuiltinCacheForTests, ensureBuiltinRules, updateRule, writeRules } from "../src/practice";

let root: string;

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "graph-pointer-"));
  mkdirSync(join(root, "graphify-out"), { recursive: true });
  writeFileSync(join(root, "graphify-out", "graph.json"), "{}");
  mkdirSync(join(root, "src", "feature"), { recursive: true });
  mkdirSync(join(root, "src", "other"), { recursive: true });
  writeFileSync(join(root, "src", "feature", "big.ts"), lines(600));
  writeFileSync(join(root, "src", "feature", "small.ts"), lines(40));
  writeFileSync(join(root, "src", "other", "far.ts"), lines(300));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  writeRules([]);
  __resetBuiltinCacheForTests();
});

function ctx(): DesignTurnContext {
  const c = createTurnDesignContext(`t-${Math.random()}`, root);
  expect(c.hasGraph).toBe(true);
  return c;
}

function bash(c: DesignTurnContext, command: string) {
  const deny = runDesignHooks({ ctx: c, toolName: "Bash", toolInput: { command }, mode: "enforce" });
  if (!deny) recordAllowedTool(c, "Bash", { command });
  return deny;
}

function graphCall(c: DesignTurnContext, text: string) {
  recordAllowedTool(c, "mcp__marvin-graph__graph_search", { query: "x" });
  noteGraphResult(c, "mcp__marvin-graph__graph_search", { content: [{ type: "text", text }] });
}

function promoteToDeny() {
  ensureBuiltinRules();
  updateRule("builtin:graph-pointer", { tier: "deny" });
  __resetBuiltinCacheForTests();
}

describe("graphify-first now sees Bash reads", () => {
  it("a cat of a source file before any graph call is refused as the first structural read", () => {
    const deny = bash(ctx(), "cat src/feature/big.ts");
    expect(deny?.message).toContain("graphify-first: Bash read");
  });

  it("a sed range before any graph call is refused too — the graph comes first", () => {
    expect(bash(ctx(), "sed -n 1,20p src/feature/small.ts")?.message).toContain("graphify-first");
  });

  it("tests, builds, git and logs are never refused", () => {
    const c = ctx();
    for (const cmd of [
      "npx vitest run src/feature 2>&1 | tail -30",
      "pnpm build",
      "git diff --stat HEAD -- src/feature/big.ts",
      "grep -n ERROR /tmp/build.log | head",
      "wc -l src/feature/big.ts",
      "ls src/feature",
    ]) {
      expect(bash(c, cmd)).toBeNull();
    }
  });
});

describe("graph-pointer (ADR-0124)", () => {
  it("ships measure-first: native tier nudges once and never denies", () => {
    const c = ctx();
    graphCall(c, "hits: big  [degree 3 · src/feature/big.ts]");
    expect(bash(c, "cat src/other/far.ts")).toBeNull();
    expect(c.pendingPracticeNudge).toContain("graph-pointer");
    c.pendingPracticeNudge = undefined;
    expect(bash(c, "cat src/other/far.ts")).toBeNull();
    expect(c.pendingPracticeNudge).toBeUndefined();
  });

  describe("at deny tier", () => {
    beforeEach(promoteToDeny);

    it("a whole-file cat of a large source file is refused with the narrow-read discharge", () => {
      const c = ctx();
      graphCall(c, "- big [src/feature/big.ts:120]");
      const deny = bash(c, "cat src/feature/big.ts");
      expect(deny?.message).toContain("graph-pointer (ADR-0124)");
      expect(deny?.message).toContain("sed -n 'X,Yp'");
      expect(deny?.message).toContain("600 lines");
    });

    it("a narrow sed range of a graph-pointed file passes", () => {
      const c = ctx();
      graphCall(c, "- big [src/feature/big.ts:120]");
      expect(bash(c, "sed -n 100,160p src/feature/big.ts")).toBeNull();
      expect(bash(c, "head -n 80 src/feature/big.ts")).toBeNull();
    });

    it("a small file may be read whole", () => {
      const c = ctx();
      graphCall(c, "src/feature/small.ts");
      expect(bash(c, "cat src/feature/small.ts")).toBeNull();
    });

    it("a repo-wide search is refused; a search under a pointed directory passes", () => {
      const c = ctx();
      graphCall(c, "found in src/feature/big.ts");
      expect(bash(c, 'rg -n "v12" .')?.message).toContain("rg over .");
      expect(bash(c, 'grep -rn "v12" src/other')?.message).toContain("src/other");
      expect(bash(c, 'rg -n "v12" src/feature')).toBeNull();
      expect(bash(c, 'grep -n "v12" src/other/far.ts')).toBeNull(); // a named-file search is narrow
    });

    it("a file this turn created is never refused", () => {
      const c = ctx();
      graphCall(c, "src/feature/big.ts");
      const created = join(root, "src", "other", "new.ts");
      writeFileSync(created, lines(500));
      recordAllowedTool(c, "Write", { file_path: created, content: "" });
      expect(bash(c, "cat src/other/new.ts")).toBeNull();
    });

    it("in a worktree tab, relative paths resolve from the tab and pointers match either tree", () => {
      const tab = join(root, ".marvin", "worktrees", "tab-x");
      mkdirSync(join(tab, "src", "feature"), { recursive: true });
      writeFileSync(join(tab, "src", "feature", "big.ts"), lines(600));
      const c = createTurnDesignContext("t-tab", root, { sessionCwd: tab });
      graphCall(c, "src/feature/big.ts");
      expect(bash(c, "cat src/feature/big.ts")?.message).toContain("src/feature/big.ts (600 lines)");
      expect(bash(c, "rg -n v1 src/feature")).toBeNull();
      expect(repoRelativePath(root, join(tab, "src", "feature", "big.ts"))).toBe("src/feature/big.ts");
    });

    it(`after ${BUILTIN_GATE_MAX_DENIES} refusals in one turn the call is allowed (ADR-0104 brake)`, () => {
      const c = ctx();
      graphCall(c, "src/feature/big.ts");
      expect(bash(c, "cat src/feature/big.ts")).not.toBeNull();
      expect(bash(c, "cat src/other/far.ts")).not.toBeNull();
      expect(bash(c, "cat src/feature/big.ts")).toBeNull();
    });

    it("measure mode logs and allows", () => {
      const c = ctx();
      graphCall(c, "src/feature/big.ts");
      const deny = runDesignHooks({ ctx: c, toolName: "Bash", toolInput: { command: "cat src/feature/big.ts" }, mode: "measure" });
      expect(deny).toBeNull();
    });
  });
});

describe("usage counters (ADR-0124 C)", () => {
  it("counts Bash reads separately from Read/Grep and graph calls", () => {
    const c = ctx();
    graphCall(c, "src/feature/big.ts");
    bash(c, "sed -n 1,40p src/feature/big.ts");
    bash(c, "npx vitest run | tail");
    recordAllowedTool(c, "Read", { file_path: join(root, "src", "feature", "small.ts") });
    expect({ graph: c.graphCallCount, bash: c.bashReads, file: c.fileReads }).toEqual({ graph: 1, bash: 1, file: 1 });
  });

  it("lifts source paths out of graph tool output", () => {
    const c = ctx();
    noteGraphResult(c, "mcp__marvin-graph__graph_affected", {
      content: [{ type: "text", text: "callers:\n  - run() · sidecar/src/app/route.ts:42\n  - x (apps/web/src/a.tsx)" }],
    });
    expect([...c.graphPointers].sort()).toEqual(["apps/web/src/a.tsx", "sidecar/src/app/route.ts"]);
  });
});
