import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearTurnDesignContext,
  createTurnDesignContext,
  isExemptFromAdrTriggers,
  isInsideCwd,
  isSourceFile,
  matchAdrTrigger,
  recordAllowedTool,
  runDesignHooks,
  checkGraphDrift,
  GRAPH_DRIFT_MAX_NUDGES,
  GRAPH_DRIFT_NOVEL_FILE_THRESHOLD,
} from "../src/design-hooks";

/**
 * Design hooks pin the personality's two most-load-bearing workflow rules
 * to the runtime: graphify-first and advisor-on-ADR-trigger. These tests
 * verify the deterministic enforcement is correct — denies fire when
 * they should, allows pass when they should, and the exemption / once-
 * per-target logic doesn't regress.
 */

function withTmpCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "marvin-design-hooks-"));
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function seedGraph(cwd: string): void {
  const dir = join(cwd, "graphify-out");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "graph.json"),
    JSON.stringify({ nodes: [], edges: [] }),
  );
}

describe("design-hooks · path classifiers", () => {
  it("isSourceFile recognises common source extensions", () => {
    expect(isSourceFile("foo.ts")).toBe(true);
    expect(isSourceFile("/abs/path/to/foo.tsx")).toBe(true);
    expect(isSourceFile("a/b/c.swift")).toBe(true);
    expect(isSourceFile("a.go")).toBe(true);
    expect(isSourceFile("a.py")).toBe(true);
  });

  it("isSourceFile rejects config / docs / data files", () => {
    expect(isSourceFile("package.json")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
    expect(isSourceFile("docker-compose.yml")).toBe(false);
    expect(isSourceFile(".env")).toBe(false);
    expect(isSourceFile("schema.sql")).toBe(false);
    expect(isSourceFile("notebook.ipynb")).toBe(false);
  });

  it("isInsideCwd handles absolute and relative targets", () => {
    expect(isInsideCwd("/Users/x/proj", "/Users/x/proj/src/a.ts")).toBe(true);
    expect(isInsideCwd("/Users/x/proj", "src/a.ts")).toBe(true);
    expect(isInsideCwd("/Users/x/proj", "/Users/x/other/a.ts")).toBe(false);
    expect(isInsideCwd("/Users/x/proj", "/etc/passwd")).toBe(false);
  });

  it("matchAdrTrigger recognises auth / migration / CI / Docker paths", () => {
    const cwd = "/Users/x/proj";
    expect(matchAdrTrigger(cwd, `${cwd}/src/auth/login.ts`)).toBeTruthy();
    expect(matchAdrTrigger(cwd, `${cwd}/migrations/001_init.sql`)).toBeTruthy();
    expect(
      matchAdrTrigger(cwd, `${cwd}/.github/workflows/ci.yml`),
    ).toBeTruthy();
    expect(matchAdrTrigger(cwd, `${cwd}/Dockerfile`)).toBeTruthy();
    expect(matchAdrTrigger(cwd, `${cwd}/docker-compose.yml`)).toBeTruthy();
    expect(matchAdrTrigger(cwd, `${cwd}/policy.ts`)).toBeTruthy();
    expect(matchAdrTrigger(cwd, `${cwd}/permissions/check.ts`)).toBeTruthy();
    expect(matchAdrTrigger(cwd, `${cwd}/db/schema.ts`)).toBeTruthy();
  });

  it("matchAdrTrigger ignores benign paths", () => {
    const cwd = "/Users/x/proj";
    expect(matchAdrTrigger(cwd, `${cwd}/src/components/Button.tsx`)).toBeNull();
    expect(matchAdrTrigger(cwd, `${cwd}/lib/utils.ts`)).toBeNull();
    expect(matchAdrTrigger(cwd, `${cwd}/README.md`)).toBeNull();
  });

  it("isExemptFromAdrTriggers exempts test / spec files", () => {
    expect(isExemptFromAdrTriggers("/x/auth/auth.test.ts")).toBe(true);
    expect(isExemptFromAdrTriggers("/x/auth/auth.spec.ts")).toBe(true);
    expect(isExemptFromAdrTriggers("/x/auth/__tests__/login.ts")).toBe(true);
    expect(isExemptFromAdrTriggers("/x/server/spec/auth.go")).toBe(true);
    expect(isExemptFromAdrTriggers("/x/auth/login.ts")).toBe(false);
  });
});

describe("design-hooks · graphify-first", () => {
  let cleanup: () => void;
  let cwd: string;
  const turnId = "test-turn-graph";

  beforeEach(() => {
    ({ cwd, cleanup } = withTmpCwd());
  });
  afterEach(() => {
    clearTurnDesignContext(turnId);
    cleanup();
  });

  it("denies first source-file Read when graph exists and no graph_search has fired", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    expect(ctx.hasGraph).toBe(true);
    const result = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "src", "auth.ts") },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
    expect(result?.message).toContain("graphify-first");
    expect(result?.message).toContain("graph_search");
  });

  it("allows source-file Read after a graph_* MCP call has been recorded", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", {
      query: "auth",
    });
    expect(ctx.graphCallCount).toBe(1);
    const result = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "src", "auth.ts") },
      mode: "enforce",
    });
    expect(result).toBeNull();
  });

  it("allows source-file Read when the project has no graph (rule has nothing to enforce)", () => {
    // No seedGraph call — graphify-out doesn't exist.
    const ctx = createTurnDesignContext(turnId, cwd);
    expect(ctx.hasGraph).toBe(false);
    const result = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "src", "auth.ts") },
      mode: "enforce",
    });
    expect(result).toBeNull();
  });

  it("allows reads of non-source files (config / docs / data) regardless of graph state", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    for (const path of [
      "package.json",
      "README.md",
      "docker-compose.yml",
      ".env",
    ]) {
      const result = runDesignHooks({
        ctx,
        toolName: "Read",
        toolInput: { file_path: join(cwd, path) },
        mode: "enforce",
      });
      expect(result).toBeNull();
    }
  });

  it("doesn't double-fire — once the hook has denied a Read this turn, subsequent reads pass through", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    // First Read denied.
    const first = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "a.ts") },
      mode: "enforce",
    });
    expect(first?.behavior).toBe("deny");
    expect(ctx.graphifyHookFired).toBe(true);
    // Second Read no longer triggers the deny — model got the hint already.
    const second = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "b.ts") },
      mode: "enforce",
    });
    expect(second).toBeNull();
  });

  it("does not deny in measure mode", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "src", "auth.ts") },
      mode: "measure",
    });
    expect(result).toBeNull();
  });

  it("does not deny in off mode", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: join(cwd, "src", "auth.ts") },
      mode: "off",
    });
    expect(result).toBeNull();
  });

  it("ignores source files outside the project cwd (e.g. node_modules tucked elsewhere)", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Read",
      toolInput: { file_path: "/usr/local/lib/node_modules/foo.js" },
      mode: "enforce",
    });
    expect(result).toBeNull();
  });

  it("denies first Grep on a path inside cwd when no graph_search has fired", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Grep",
      toolInput: { pattern: "AuthenticationPrincipal", path: cwd },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
    expect(result?.message).toContain("graphify-first");
    expect(result?.message).toContain("Grep");
  });

  it("denies first Glob on a path inside cwd", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Glob",
      toolInput: { pattern: `${cwd}/apps/api/**/*.java` },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
    expect(result?.message).toContain("graphify-first");
    expect(result?.message).toContain("Glob");
  });

  it("allows Grep / Glob after graph_search has fired", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "auth" });
    expect(ctx.graphCallCount).toBe(1);
    expect(
      runDesignHooks({
        ctx,
        toolName: "Grep",
        toolInput: { pattern: "foo", path: cwd },
        mode: "enforce",
      }),
    ).toBeNull();
    expect(
      runDesignHooks({
        ctx,
        toolName: "Glob",
        toolInput: { pattern: `${cwd}/**/*.ts` },
        mode: "enforce",
      }),
    ).toBeNull();
  });

  it("Grep counts toward sourceFilesRead — once any structural search lands, hook stays satisfied", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    // First Grep is denied (graphifyHookFired flips true).
    runDesignHooks({
      ctx,
      toolName: "Grep",
      toolInput: { pattern: "foo", path: cwd },
      mode: "enforce",
    });
    expect(ctx.graphifyHookFired).toBe(true);
    // Subsequent Read should not double-deny — hook state is one-shot.
    expect(
      runDesignHooks({
        ctx,
        toolName: "Read",
        toolInput: { file_path: join(cwd, "src", "x.ts") },
        mode: "enforce",
      }),
    ).toBeNull();
  });

  it("recordAllowedTool bumps sourceFilesRead for Grep / Glob", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Grep", { pattern: "foo", path: cwd });
    expect(ctx.sourceFilesRead).toBe(1);
    recordAllowedTool(ctx, "Glob", { pattern: `${cwd}/**/*.ts` });
    expect(ctx.sourceFilesRead).toBe(2);
  });
});

describe("design-hooks · advisor-on-ADR-trigger", () => {
  let cleanup: () => void;
  let cwd: string;
  const turnId = "test-turn-advisor";

  beforeEach(() => {
    ({ cwd, cleanup } = withTmpCwd());
  });
  afterEach(() => {
    clearTurnDesignContext(turnId);
    cleanup();
  });

  it("denies Edit on auth path when no advisor consult has fired", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Edit",
      toolInput: { file_path: join(cwd, "src", "auth", "login.ts") },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
    expect(result?.message).toContain("advisor");
    expect(result?.message).toContain("auth");
  });

  it("allows Edit on auth path after an advisor Task has been recorded", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Task", {
      subagent_type: "general-purpose",
      model: "opus",
      description: "advisor: redesign auth",
    });
    expect(ctx.advisorCallCount).toBe(1);
    const result = runDesignHooks({
      ctx,
      toolName: "Edit",
      toolInput: { file_path: join(cwd, "src", "auth", "login.ts") },
      mode: "enforce",
    });
    expect(result).toBeNull();
  });

  it("doesn't count a non-advisor Task as satisfying the rule", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    // A scout Task or a generic Task with no advisor: prefix shouldn't
    // discharge the obligation.
    recordAllowedTool(ctx, "Task", {
      subagent_type: "scout",
      description: "scout: enumerate session ids",
    });
    expect(ctx.advisorCallCount).toBe(0);
    const result = runDesignHooks({
      ctx,
      toolName: "Edit",
      toolInput: { file_path: join(cwd, "src", "auth", "login.ts") },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
  });

  it("allows edits on benign paths regardless of advisor state", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    for (const target of [
      "src/components/Button.tsx",
      "lib/utils.ts",
      "README.md",
    ]) {
      const result = runDesignHooks({
        ctx,
        toolName: "Edit",
        toolInput: { file_path: join(cwd, target) },
        mode: "enforce",
      });
      expect(result).toBeNull();
    }
  });

  it("exempts test / spec files in trigger paths", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    for (const target of [
      "src/auth/login.test.ts",
      "src/auth/login.spec.ts",
      "src/auth/__tests__/login.ts",
    ]) {
      const result = runDesignHooks({
        ctx,
        toolName: "Edit",
        toolInput: { file_path: join(cwd, target) },
        mode: "enforce",
      });
      expect(result).toBeNull();
    }
  });

  it("denies Write on a CI workflow change without advisor", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Write",
      toolInput: {
        file_path: join(cwd, ".github", "workflows", "deploy.yml"),
        content: "jobs: { ... }",
      },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
    expect(result?.message).toContain("CI workflow");
  });

  it("denies Edit on a SQL migration without advisor", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Edit",
      toolInput: {
        file_path: join(cwd, "migrations", "001_users.sql"),
      },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
  });

  it("doesn't double-fire — once denied for a target, the same target passes the next time", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const target = join(cwd, "src", "auth", "login.ts");
    const first = runDesignHooks({
      ctx,
      toolName: "Edit",
      toolInput: { file_path: target },
      mode: "enforce",
    });
    expect(first?.behavior).toBe("deny");
    const second = runDesignHooks({
      ctx,
      toolName: "Edit",
      toolInput: { file_path: target },
      mode: "enforce",
    });
    expect(second).toBeNull();
  });

  it("does not deny in measure or off mode", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    for (const mode of ["measure", "off"] as const) {
      const result = runDesignHooks({
        ctx,
        toolName: "Edit",
        toolInput: { file_path: join(cwd, "src", "auth", "login.ts") },
        mode,
      });
      expect(result).toBeNull();
    }
  });
});


// ADR-0060 — the graph-drift nudge. The graphify-first deny is one-shot per
// turn (one graph call disarms it), which measured 1:5–1:11 graph:file ratios
// with the back half of every session unguarded. These pin the re-arm AND the
// false-positive protections that keep it from nagging during implementation.
describe("graph drift nudge (ADR-0060)", () => {
  let cleanup: () => void;
  let cwd: string;
  const turnId = "test-turn-drift";

  beforeEach(() => {
    ({ cwd, cleanup } = withTmpCwd());
  });
  afterEach(() => {
    clearTurnDesignContext(turnId);
    cleanup();
  });

  /** Read N distinct novel source files through the recorder. */
  function readNovel(ctx: ReturnType<typeof createTurnDesignContext>, n: number, from = 0) {
    for (let i = from; i < from + n; i++) {
      recordAllowedTool(ctx, "Read", { file_path: join(cwd, "src", `f${i}.ts`) });
    }
  }

  it("nudges once the novel-file threshold is crossed", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "x" });
    readNovel(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD);
    const nudge = checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", "new.ts") });
    expect(nudge).toBeTruthy();
    expect(nudge).toContain("graphify drift");
    // Must tell the model it's free to ignore while implementing.
    expect(nudge).toMatch(/IMPLEMENTING/);
    expect(nudge).toContain("mcp__marvin-graph__");
  });

  it("does NOT nudge before the threshold", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    readNovel(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD - 1);
    expect(checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", "new.ts") })).toBeNull();
  });

  it("a graph call RESETS the drift budget", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    readNovel(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD);
    expect(ctx.novelFilesSinceGraph).toBe(GRAPH_DRIFT_NOVEL_FILE_THRESHOLD);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_neighbors", { node: "X" });
    expect(ctx.novelFilesSinceGraph).toBe(0);
    expect(checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", "new.ts") })).toBeNull();
  });

  // The load-bearing false-positive protection: implementation re-reads.
  it("re-reading an ALREADY-SEEN file never charges drift or nudges", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    const f = join(cwd, "src", "a.ts");
    for (let i = 0; i < 30; i++) recordAllowedTool(ctx, "Read", { file_path: f });
    expect(ctx.novelFilesSinceGraph).toBe(1); // counted once, not 30×
    expect(checkGraphDrift(ctx, "Read", { file_path: f })).toBeNull();
  });

  it("never nudges on Edit/Write/Bash — implementation is never interrupted", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    readNovel(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD + 5);
    for (const t of ["Edit", "Write", "Bash", "TodoWrite"]) {
      expect(checkGraphDrift(ctx, t, { file_path: join(cwd, "src", "x.ts") }), t).toBeNull();
    }
  });

  it("is capped per turn so a long turn isn't nagged into noise", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      readNovel(ctx, 1, 100 + i);
      if (checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", `probe${i}.ts`) })) fired++;
    }
    expect(fired).toBe(GRAPH_DRIFT_MAX_NUDGES);
  });

  it("charges project-tree Grep/Glob (the grep-and-pray path), deduped by pattern", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    for (let i = 0; i < 5; i++) recordAllowedTool(ctx, "Grep", { pattern: "sameThing", path: cwd });
    expect(ctx.novelFilesSinceGraph).toBe(1); // same search doesn't double-charge
    for (let i = 0; i < GRAPH_DRIFT_NOVEL_FILE_THRESHOLD; i++) {
      recordAllowedTool(ctx, "Grep", { pattern: `distinct${i}`, path: cwd });
    }
    expect(checkGraphDrift(ctx, "Grep", { pattern: "another", path: cwd })).toBeTruthy();
  });

  it("does nothing when the project has no graph", () => {
    const ctx = createTurnDesignContext(turnId, cwd); // no seedGraph
    readNovel(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD + 3);
    expect(checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", "new.ts") })).toBeNull();
  });
});
