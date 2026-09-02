import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BLAST_RADIUS_MAX_NUDGES,
  bashSearchTarget,
  checkBlastRadius,
  checkGraphDrift,
  checkGraphDriftDeny,
  checkSaveResult,
  checkShipImpact,
  checkShipReview,
  classifyShipDiff,
  clearTurnDesignContext,
  createTurnDesignContext,
  GRAPH_DRIFT_DENY_THRESHOLD,
  GRAPH_DRIFT_MAX_NUDGES,
  GRAPH_DRIFT_NOVEL_FILE_THRESHOLD,
  isExemptFromAdrTriggers,
  isInsideCwd,
  isSourceFile,
  logDesignTurnSummary,
  matchAdrTrigger,
  matchShipBoundary,
  parseCommitCommand,
  recordAllowedTool,
  resetShipReviewState,
  runDesignHooks,
  SAVE_RESULT_GRAPH_THRESHOLD,
  SHIP_REVIEW_MAX_DENIES,
  type ShipDiff,
  shipReviewSkillOf,
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

  // Task → Agent rename (Claude Code v2.1.63): the advisor design hook matched
  // the literal "Task", so it stopped counting advisor consults entirely.
  it("counts an advisor consult dispatched under the `Agent` tool name", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", {
      subagent_type: "advisor",
      description: "advisor: redesign auth",
    });
    expect(ctx.advisorCallCount).toBe(1);
    expect(
      runDesignHooks({
        ctx,
        toolName: "Edit",
        toolInput: { file_path: join(cwd, "src", "auth", "login.ts") },
        mode: "enforce",
      }),
    ).toBeNull();
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

  // ADR-0094: the deny message now prescribes the REGISTERED advisor agent.
  // Before this, it told MARVIN to spawn `general-purpose` with a model hint —
  // the pre-ADR-0033 shape — which silently discarded the advisor's effort,
  // read-only denylist, marvin-graph server and turn cap.
  it("prescribes the registered advisor agent, not general-purpose", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const result = runDesignHooks({
      ctx,
      toolName: "Write",
      toolInput: { file_path: join(cwd, "db", "migrations", "V1__init.sql") },
      mode: "enforce",
    });
    expect(result?.behavior).toBe("deny");
    expect(result?.message).toContain('subagent_type: "advisor"');
    expect(result?.message).not.toContain('subagent_type: "general-purpose"');
    // The registered definition owns the model and the system prompt; the
    // message must not re-specify either.
    expect(result?.message).not.toContain('model:          "opus"');
    expect(result?.message).not.toContain("You are an advisor consulted by");
    // A fresh subagent sees none of this conversation — the message has to
    // say so, or the executor pastes a stub and gets a uselessly shallow read.
    expect(result?.message).toContain("FRESH context");
  });

  // ADR-0094, the other half: keying the counter on the `advisor:` description
  // prefix ALONE meant the gate could not see its own prescribed remedy. A
  // dispatch of the registered agent with a natural description must count.
  it("counts a registered-advisor dispatch with no `advisor:` description prefix", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", {
      subagent_type: "advisor",
      description: "review the platform_audit migration",
    });
    expect(ctx.advisorCallCount).toBe(1);
    expect(
      runDesignHooks({
        ctx,
        toolName: "Write",
        toolInput: { file_path: join(cwd, "db", "migrations", "V1__init.sql") },
        mode: "enforce",
      }),
    ).toBeNull();
  });

  // Back-compat: ADR-0007's `general-purpose` + `advisor:` prefix spawn is
  // still policy-sanctioned, and a consult run that way is still a consult.
  it("still counts the ADR-0007 general-purpose spawn via the description prefix", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", {
      subagent_type: "general-purpose",
      description: "advisor: review the migration",
    });
    expect(ctx.advisorCallCount).toBe(1);
  });

  // ADR-0095: the gate now reads the VERDICT, not just the dispatch. A reject
  // denies the next trigger-path mutation exactly once — enough to force the
  // verdict to be read, without handing a subagent a veto over the user's tree.
  it("denies once when the advisor rejected, then lets the retry through", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", { subagent_type: "advisor", description: "advisor: the migration" });
    ctx.advisorVerdict = "reject";

    const target = { file_path: join(cwd, "db", "migrations", "V1__init.sql") };
    const first = runDesignHooks({ ctx, toolName: "Write", toolInput: target, mode: "enforce" });
    expect(first?.behavior).toBe("deny");
    expect(first?.message).toContain("REJECT");
    expect(first?.message).toContain("fires ONCE");

    // Fired-once: the same write now proceeds, and the reply is expected to
    // own the override.
    expect(runDesignHooks({ ctx, toolName: "Write", toolInput: target, mode: "enforce" })).toBeNull();
  });

  it("does not fire the reject deny on a go-with-caveats verdict", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", { subagent_type: "advisor", description: "advisor: the migration" });
    ctx.advisorVerdict = "go-with-caveats";
    expect(
      runDesignHooks({
        ctx,
        toolName: "Write",
        toolInput: { file_path: join(cwd, "db", "migrations", "V1__init.sql") },
        mode: "enforce",
      }),
    ).toBeNull();
  });

  it("does not fire the reject deny on a benign path", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", { subagent_type: "advisor", description: "advisor: the migration" });
    ctx.advisorVerdict = "reject";
    expect(
      runDesignHooks({
        ctx,
        toolName: "Write",
        toolInput: { file_path: join(cwd, "src", "components", "Button.tsx") },
        mode: "enforce",
      }),
    ).toBeNull();
  });

  // ADR-0095 amendment: "don't re-run the advisor for a friendlier verdict"
  // used to be prose in personality.ts. The 2026-05-22 audit measured what
  // soft-nudge language is worth — it fires ~0×. Now it's mechanical.
  it("denies a second advisor consult once a verdict has landed", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Agent", { subagent_type: "advisor", description: "advisor: the migration" });
    ctx.advisorVerdict = "reject";

    const second = runDesignHooks({
      ctx,
      toolName: "Agent",
      toolInput: { subagent_type: "advisor", description: "advisor: the migration, again" },
      mode: "enforce",
    });
    expect(second?.behavior).toBe("deny");
    expect(second?.message).toContain("One consult, one answer");

    // Fires once — a consult on a genuinely different question gets through.
    expect(
      runDesignHooks({
        ctx,
        toolName: "Agent",
        toolInput: { subagent_type: "advisor", description: "advisor: a different question" },
        mode: "enforce",
      }),
    ).toBeNull();
  });

  it("does not block the FIRST advisor consult, or a scout after a verdict", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    expect(
      runDesignHooks({
        ctx,
        toolName: "Agent",
        toolInput: { subagent_type: "advisor", description: "advisor: first look" },
        mode: "enforce",
      }),
    ).toBeNull();
    ctx.advisorVerdict = "go-with-caveats";
    expect(
      runDesignHooks({
        ctx,
        toolName: "Agent",
        toolInput: { subagent_type: "scout", description: "scout: enumerate call sites" },
        mode: "enforce",
      }),
    ).toBeNull();
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

// ADR-0060 follow-up — observability. The nudge is injected as hook
// additionalContext, which leaves NO trace in the session transcript, and
// appendAutoAuditEntry early-returns for every non-mutator tool (the design
// hooks fire on Read/Grep/Glob). So without a telemetry line there is no way
// to distinguish "fired and ignored" from "never fired" — opposite fixes.
describe("design-hook observability (ADR-0060 follow-up)", () => {
  let cleanup: () => void;
  let cwd: string;
  const turnId = "test-turn-telemetry";
  let lines: string[];
  let origInfo: typeof console.info;

  beforeEach(() => {
    ({ cwd, cleanup } = withTmpCwd());
    lines = [];
    origInfo = console.info;
    console.info = ((msg?: unknown) => {
      if (typeof msg === "string") lines.push(msg);
    }) as typeof console.info;
  });
  afterEach(() => {
    console.info = origInfo;
    clearTurnDesignContext(turnId);
    cleanup();
  });

  const telemetry = () =>
    lines
      .filter((l) => l.startsWith("[marvin.telemetry] "))
      .map((l) => JSON.parse(l.slice("[marvin.telemetry] ".length)) as Record<string, unknown>);

  it("emits a per-turn graph:file summary so the ratio is readable from the log", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "x" });
    for (let i = 0; i < 9; i++) {
      recordAllowedTool(ctx, "Read", { file_path: join(cwd, "src", `f${i}.ts`) });
    }
    logDesignTurnSummary(ctx);
    const ev = telemetry().find((e) => e.kind === "graph.turn.summary");
    expect(ev).toBeTruthy();
    expect(ev!.graphCalls).toBe(1);
    expect(ev!.driftOps).toBe(9);
    expect(ev!.turnId).toBe(turnId);
    expect(ev!.hasGraph).toBe(true);
  });

  it("reports the exploration-only ratio (charges minus implementation refunds)", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "x" });
    // 2 exploratory reads (never edited) + 3 read-then-edit implementation reads.
    for (let i = 0; i < 2; i++) {
      recordAllowedTool(ctx, "Read", { file_path: join(cwd, "src", `explore${i}.ts`) });
    }
    for (let i = 0; i < 3; i++) {
      const f = join(cwd, "src", `impl${i}.ts`);
      recordAllowedTool(ctx, "Read", { file_path: f });
      recordAllowedTool(ctx, "Edit", { file_path: f });
    }
    logDesignTurnSummary(ctx);
    const ev = telemetry().find((e) => e.kind === "graph.turn.summary")!;
    expect(ev.driftCharges).toBe(5);
    expect(ev.implRefunds).toBe(3);
    expect(ev.exploreOps).toBe(2); // only the genuinely exploratory reads
    expect(ev.exploreRatio).toBe(2); // 2 exploratory reads per 1 graph call
  });

  it("stays silent for a turn that touched nothing structural", () => {
    const ctx = createTurnDesignContext(turnId, cwd); // no graph, no ops
    logDesignTurnSummary(ctx);
    expect(telemetry().filter((e) => e.kind === "graph.turn.summary")).toHaveLength(0);
  });

  it("summary reports nudge count so 'fired' is distinguishable from 'never fired'", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "x" });
    for (let i = 0; i < GRAPH_DRIFT_NOVEL_FILE_THRESHOLD; i++) {
      recordAllowedTool(ctx, "Read", { file_path: join(cwd, "src", `n${i}.ts`) });
    }
    expect(checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", "probe.ts") })).toBeTruthy();
    logDesignTurnSummary(ctx);
    const ev = telemetry().find((e) => e.kind === "graph.turn.summary");
    expect(ev!.nudges).toBe(1);
  });

  it("never throws even if serialisation misbehaves", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    ctx.hasGraph = true;
    console.info = (() => {
      throw new Error("boom");
    }) as typeof console.info;
    expect(() => logDesignTurnSummary(ctx)).not.toThrow();
  });
});

// ADR-0060 addendum 2 — the implementation refund. Measured on a real
// implementation-heavy session: of 49 novel source reads, 20 were files MARVIN
// went on to Edit. Reading a file you're about to change is correct behaviour,
// but at Read time it's indistinguishable from drift, so those 20 inflated the
// signal ~40%. This is why escalating to a mid-turn hard deny would have been
// wrong — it would have blocked real implementation reads.
describe("implementation refund (ADR-0060 addendum 2)", () => {
  let cleanup: () => void;
  let cwd: string;
  const turnId = "test-turn-refund";

  beforeEach(() => {
    ({ cwd, cleanup } = withTmpCwd());
    seedGraph(cwd);
  });
  afterEach(() => {
    clearTurnDesignContext(turnId);
    cleanup();
  });

  it("read-then-edit REFUNDS the drift charge (implementation, not exploration)", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const f = join(cwd, "src", "a.ts");
    recordAllowedTool(ctx, "Read", { file_path: f });
    expect(ctx.novelFilesSinceGraph).toBe(1);
    recordAllowedTool(ctx, "Edit", { file_path: f });
    expect(ctx.novelFilesSinceGraph).toBe(0);
    expect(ctx.driftCharges).toBe(1);
    expect(ctx.driftRefunds).toBe(1);
  });

  it("Write and NotebookEdit refund too", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const a = join(cwd, "src", "a.ts");
    const b = join(cwd, "src", "b.ts");
    recordAllowedTool(ctx, "Read", { file_path: a });
    recordAllowedTool(ctx, "Read", { file_path: b });
    expect(ctx.novelFilesSinceGraph).toBe(2);
    recordAllowedTool(ctx, "Write", { file_path: a });
    recordAllowedTool(ctx, "NotebookEdit", { notebook_path: b });
    expect(ctx.novelFilesSinceGraph).toBe(0);
    expect(ctx.driftRefunds).toBe(2);
  });

  it("an edit refunds only ONCE, and never below zero", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const f = join(cwd, "src", "a.ts");
    recordAllowedTool(ctx, "Read", { file_path: f });
    for (let i = 0; i < 5; i++) recordAllowedTool(ctx, "Edit", { file_path: f });
    expect(ctx.novelFilesSinceGraph).toBe(0);
    expect(ctx.driftRefunds).toBe(1);
  });

  it("editing a file that was never read charges nothing (no phantom refund)", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Edit", { file_path: join(cwd, "src", "never-read.ts") });
    expect(ctx.driftRefunds).toBe(0);
    expect(ctx.novelFilesSinceGraph).toBe(0);
  });

  it("pure exploration still accrues drift and nudges (refund doesn't defang the rule)", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    for (let i = 0; i < GRAPH_DRIFT_NOVEL_FILE_THRESHOLD; i++) {
      recordAllowedTool(ctx, "Read", { file_path: join(cwd, "src", `explore${i}.ts`) });
    }
    // None were edited → nothing refunded → the nudge still fires.
    expect(ctx.driftRefunds).toBe(0);
    expect(checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", "more.ts") })).toBeTruthy();
  });

  it("an implementation burst does NOT reach the nudge threshold", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    // Read-then-edit, 12 files — classic implementation. Never nudges.
    for (let i = 0; i < 12; i++) {
      const f = join(cwd, "src", `impl${i}.ts`);
      recordAllowedTool(ctx, "Read", { file_path: f });
      recordAllowedTool(ctx, "Edit", { file_path: f });
      expect(checkGraphDrift(ctx, "Read", { file_path: join(cwd, "src", `next${i}.ts`) })).toBeNull();
    }
    expect(ctx.graphifyNudgeCount).toBe(0);
  });

  it("Grep/Glob charges are NOT refundable (a search has no file to edit)", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "Grep", { pattern: "foo", path: cwd });
    expect(ctx.novelFilesSinceGraph).toBe(1);
    recordAllowedTool(ctx, "Edit", { file_path: join(cwd, "src", "foo.ts") });
    expect(ctx.novelFilesSinceGraph).toBe(1); // unchanged
    expect(ctx.driftRefunds).toBe(0);
  });

  it("a graph call clears charged files so later edits can't refund stale charges", () => {
    const ctx = createTurnDesignContext(turnId, cwd);
    const f = join(cwd, "src", "a.ts");
    recordAllowedTool(ctx, "Read", { file_path: f });
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "x" });
    expect(ctx.novelFilesSinceGraph).toBe(0);
    recordAllowedTool(ctx, "Edit", { file_path: f });
    expect(ctx.novelFilesSinceGraph).toBe(0);
    expect(ctx.driftRefunds).toBe(0); // charge was already cleared, not refunded
  });
});

// ADR-0083 — the drift rail re-arms on compliance and escalates when ignored.
// Measured cause: the nudge budget was monotonic per turn and spent in five
// seconds, after which 100+ file operations ran unchallenged (8:1–38:1
// read:graph across four real sessions; >8:1 is "critical" by MARVIN's own
// ToolUseCounter bands).
describe("graph drift — re-arm and escalation (ADR-0083)", () => {
  const cwd = "/proj";

  function ctxWithGraph() {
    const ctx = createTurnDesignContext("t-0083", cwd);
    ctx.hasGraph = true;
    return ctx;
  }

  /** Open `n` never-before-seen source files, as the hook records them. */
  function readNovelFiles(ctx: ReturnType<typeof ctxWithGraph>, n: number, from = 0) {
    for (let i = from; i < from + n; i++) {
      recordAllowedTool(ctx, "Read", { file_path: join(cwd, "src", `f${i}.ts`) });
    }
  }

  it("a graph call resets the nudge budget, so a long turn keeps its coverage", () => {
    const ctx = ctxWithGraph();
    // Spend the whole budget.
    for (let i = 0; i < GRAPH_DRIFT_MAX_NUDGES; i++) {
      readNovelFiles(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD, i * 100);
      expect(checkGraphDrift(ctx, "Grep", { pattern: "x", path: cwd })).not.toBeNull();
    }
    readNovelFiles(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD, 900);
    expect(checkGraphDrift(ctx, "Grep", { pattern: "x", path: cwd })).toBeNull(); // exhausted

    // The model complies. That is the rail working — give the budget back.
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", {});
    expect(ctx.graphifyNudgeCount).toBe(0);
    readNovelFiles(ctx, GRAPH_DRIFT_NOVEL_FILE_THRESHOLD, 1000);
    expect(checkGraphDrift(ctx, "Grep", { pattern: "x", path: cwd })).not.toBeNull();
    expect(ctx.graphifyNudgeTotal).toBe(GRAPH_DRIFT_MAX_NUDGES + 1);
  });

  it("denies a structural read once drift runs far past the advisory", () => {
    const ctx = ctxWithGraph();
    readNovelFiles(ctx, GRAPH_DRIFT_DENY_THRESHOLD);
    const deny = checkGraphDriftDeny(ctx, "Grep", { pattern: "x", path: cwd });
    expect(deny?.behavior).toBe("deny");
    expect(deny?.message).toContain("graph_summary");
    // One deny per stretch — it must not wall the model in.
    expect(checkGraphDriftDeny(ctx, "Grep", { pattern: "x", path: cwd })).toBeNull();
  });

  it("a graph call clears the deny, so complying always unblocks", () => {
    const ctx = ctxWithGraph();
    readNovelFiles(ctx, GRAPH_DRIFT_DENY_THRESHOLD);
    expect(checkGraphDriftDeny(ctx, "Grep", { pattern: "x", path: cwd })).not.toBeNull();
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_summary", {});
    expect(ctx.graphDriftDenyFired).toBe(false);
    expect(ctx.novelFilesSinceGraph).toBe(0);
    readNovelFiles(ctx, GRAPH_DRIFT_DENY_THRESHOLD, 500);
    expect(checkGraphDriftDeny(ctx, "Grep", { pattern: "x", path: cwd })).not.toBeNull();
  });

  it("never blocks implementation: mutators, and re-reads of files in play", () => {
    const ctx = ctxWithGraph();
    readNovelFiles(ctx, GRAPH_DRIFT_DENY_THRESHOLD);
    for (const tool of ["Edit", "Write", "Bash", "NotebookEdit"]) {
      expect(checkGraphDriftDeny(ctx, tool, { file_path: join(cwd, "src", "f0.ts"), command: "ls" }), tool).toBeNull();
    }
    // f0.ts is already in play — re-reading it is work, not exploration.
    expect(checkGraphDriftDeny(ctx, "Read", { file_path: join(cwd, "src", "f0.ts") })).toBeNull();
  });

  it("stays silent on a project with no graph", () => {
    const ctx = createTurnDesignContext("t-nograph", cwd);
    ctx.hasGraph = false;
    readNovelFiles(ctx, GRAPH_DRIFT_DENY_THRESHOLD);
    expect(checkGraphDriftDeny(ctx, "Grep", { pattern: "x", path: cwd })).toBeNull();
  });
});

// ADR-0084 — the two graph tools the 2026-08-30 measurement found unused:
// graph_affected at 0.4 % of 5,823 calls (while the undirected
// graph_neighbors was 23× more common), and graph_change_impact at zero.
describe("blast radius + pre-ship impact nudges (ADR-0084)", () => {
  const cwd = "/proj";
  function ctxWithGraph() {
    const ctx = createTurnDesignContext("t-0084", cwd);
    ctx.hasGraph = true;
    return ctx;
  }

  it("nudges before changing a source file when nobody asked who calls it", () => {
    const ctx = ctxWithGraph();
    const n = checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "src", "billing.ts") });
    expect(n).toContain("graph_affected");
    expect(n).toContain("undirected"); // names the trap it is correcting
  });

  it("goes quiet once graph_affected has been called", () => {
    const ctx = ctxWithGraph();
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_affected", {});
    expect(checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "src", "a.ts") })).toBeNull();
  });

  it("never fires twice for the same file, and is capped per turn", () => {
    const ctx = ctxWithGraph();
    expect(checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "src", "a.ts") })).not.toBeNull();
    expect(checkBlastRadius(ctx, "Write", { file_path: join(cwd, "src", "a.ts") })).toBeNull();
    expect(checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "src", "b.ts") })).not.toBeNull();
    expect(ctx.blastRadiusNudgeCount).toBe(BLAST_RADIUS_MAX_NUDGES);
    expect(checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "src", "c.ts") })).toBeNull();
  });

  it("ignores non-source files and anything outside the project", () => {
    const ctx = ctxWithGraph();
    expect(checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "notes.md") })).toBeNull();
    expect(checkBlastRadius(ctx, "Edit", { file_path: "/etc/hosts" })).toBeNull();
    expect(checkBlastRadius(ctx, "Bash", { command: "ls" })).toBeNull();
  });

  it("nudges once, on the first ship-shaped command", () => {
    for (const command of ["git commit -m x", "git push origin main", "gh pr create", "glab mr create"]) {
      const ctx = ctxWithGraph();
      expect(checkShipImpact(ctx, "Bash", { command }), command).toContain("graph_change_impact");
      expect(checkShipImpact(ctx, "Bash", { command })).toBeNull(); // once per turn
    }
  });

  it("stays out of the way of ordinary shell and of a branch already impact-checked", () => {
    const ctx = ctxWithGraph();
    expect(checkShipImpact(ctx, "Bash", { command: "git status" })).toBeNull();
    expect(checkShipImpact(ctx, "Bash", { command: "npm test" })).toBeNull();
    const checked = ctxWithGraph();
    recordAllowedTool(checked, "mcp__marvin-graph__graph_change_impact", {});
    expect(checkShipImpact(checked, "Bash", { command: "git commit -m x" })).toBeNull();
  });

  it("both stay silent on a project with no graph", () => {
    const ctx = createTurnDesignContext("t-nograph", cwd);
    ctx.hasGraph = false;
    expect(checkBlastRadius(ctx, "Edit", { file_path: join(cwd, "src", "a.ts") })).toBeNull();
    expect(checkShipImpact(ctx, "Bash", { command: "git commit -m x" })).toBeNull();
  });
});

// ADR-0091 — the work-memory loop had an output (LESSONS.md, ADR-0085) and no
// input: 12 saves across every session ever, zero reflections.
describe("record-the-outcome nudge (ADR-0091)", () => {
  const cwd = "/proj";
  function ctxWithGraph(graphCalls: number) {
    const ctx = createTurnDesignContext("t-0091", cwd);
    ctx.hasGraph = true;
    for (let i = 0; i < graphCalls; i++) {
      recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", {});
    }
    return ctx;
  }

  it("fires on the first edit once the turn has done real graph work", () => {
    const ctx = ctxWithGraph(SAVE_RESULT_GRAPH_THRESHOLD);
    const n = checkSaveResult(ctx, "Edit");
    expect(n).toContain("graph_save_result");
    expect(n).toContain("corrected");
  });

  it("stays quiet on a turn that barely touched the graph", () => {
    expect(checkSaveResult(ctxWithGraph(SAVE_RESULT_GRAPH_THRESHOLD - 1), "Edit")).toBeNull();
  });

  it("stays quiet once an outcome has been recorded", () => {
    const ctx = ctxWithGraph(SAVE_RESULT_GRAPH_THRESHOLD);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_save_result", {});
    expect(checkSaveResult(ctx, "Edit")).toBeNull();
  });

  it("fires at most once per turn, and only on a mutation", () => {
    const ctx = ctxWithGraph(SAVE_RESULT_GRAPH_THRESHOLD);
    expect(checkSaveResult(ctx, "Read")).toBeNull();
    expect(checkSaveResult(ctx, "Bash")).toBeNull();
    expect(checkSaveResult(ctx, "Write")).not.toBeNull();
    expect(checkSaveResult(ctx, "Edit")).toBeNull();
  });

  it("stays quiet on a project with no graph", () => {
    const ctx = createTurnDesignContext("t-nograph", cwd);
    ctx.hasGraph = false;
    for (let i = 0; i < 10; i++) recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", {});
    expect(checkSaveResult(ctx, "Edit")).toBeNull();
  });
});

// 2026-08-30 — Claude Code 2.1.251 removed `Grep` and `Glob` from the main
// agent's tool surface (probed against both bundled CLIs: 2.1.113 reports
// them, 2.1.251 does not, and `ToolSearch` answers `select:Grep,Glob` with
// "No matching deferred tools found"). Searching therefore moves to `Bash`,
// which this rail could not see — 15 of 18 Bash calls in the four hours after
// the upgrade were search-shaped, against 2 graph calls. These pin the rail
// against the tool surface changing under it, and — more important — pin the
// false positives, because `Bash` is mostly implementation here and denying
// a test run would be far worse than the bug.
describe("design-hooks · Bash searches are structural (post-2.1.251)", () => {
  let cleanup: () => void;
  let cwd: string;
  const turnId = "test-turn-bash-search";

  beforeEach(() => {
    ({ cwd, cleanup } = withTmpCwd());
  });
  afterEach(() => {
    clearTurnDesignContext(turnId);
    cleanup();
  });

  const deny = (command: string) => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    return runDesignHooks({ ctx, toolName: "Bash", toolInput: { command }, mode: "enforce" });
  };

  it("denies a project-tree rg as the first structural search of a turn", () => {
    const r = deny(`rg -n "validateProjectCwd" ${join(cwd, "src")}`);
    expect(r?.behavior).toBe("deny");
    expect(r?.message).toContain("graphify-first");
  });

  it("denies grep and find the same way — the whole search family", () => {
    expect(deny(`grep -rn "foo" ${join(cwd, "src")}`)?.behavior).toBe("deny");
    clearTurnDesignContext(turnId);
    expect(deny(`find ${join(cwd, "src")} -name "*.ts"`)?.behavior).toBe("deny");
  });

  it("denies a search behind a leading `cd`, the shape MARVIN actually writes", () => {
    expect(deny(`cd ${cwd} && rg -n "pattern"`)?.behavior).toBe("deny");
  });

  it("allows grep FILTERING command output — that is work, not exploration", () => {
    // The single most important negative: denying this would block test runs.
    expect(deny(`cd ${cwd} && make smoke 2>&1 | grep -i "FAIL"`)).toBeNull();
    clearTurnDesignContext(turnId);
    expect(deny("ps -Ao pid,command | grep java")).toBeNull();
  });

  it("allows a search rooted OUTSIDE the project", () => {
    expect(deny('rg -n "x" /etc')).toBeNull();
  });

  it("allows ordinary non-search Bash", () => {
    expect(deny(`cd ${cwd} && git status --short`)).toBeNull();
    clearTurnDesignContext(turnId);
    expect(deny(`cd ${cwd} && make fast`)).toBeNull();
  });

  it("allows the search once the graph has been queried", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "auth" });
    const r = runDesignHooks({
      ctx,
      toolName: "Bash",
      toolInput: { command: `rg -n "auth" ${join(cwd, "src")}` },
      mode: "enforce",
    });
    expect(r).toBeNull();
  });

  it("classifier: a search binary must LEAD its pipeline segment", () => {
    expect(bashSearchTarget({ command: `rg "x" ${cwd}` }, cwd)).not.toBeNull();
    expect(bashSearchTarget({ command: `cat foo.txt | rg "x"` }, cwd)).toBeNull();
    expect(bashSearchTarget({ command: "" }, cwd)).toBeNull();
    expect(bashSearchTarget({}, cwd)).toBeNull();
  });

  it("a search-shaped Bash charges the drift budget like a Grep did", () => {
    seedGraph(cwd);
    const ctx = createTurnDesignContext(turnId, cwd);
    recordAllowedTool(ctx, "mcp__marvin-graph__graph_search", { query: "seed" });
    const before = ctx.novelFilesSinceGraph;
    recordAllowedTool(ctx, "Bash", { command: `rg -n "alpha" ${join(cwd, "src")}` });
    expect(ctx.novelFilesSinceGraph).toBe(before + 1);
    // Same search again is not new exploration.
    recordAllowedTool(ctx, "Bash", { command: `rg -n "alpha" ${join(cwd, "src")}` });
    expect(ctx.novelFilesSinceGraph).toBe(before + 1);
    // A build command charges nothing.
    recordAllowedTool(ctx, "Bash", { command: `cd ${cwd} && make fast` });
    expect(ctx.novelFilesSinceGraph).toBe(before + 1);
  });
});

// ADR-0104 — the personality's pr-review / security-audit MUST triggers fired
// zero times across eight pushes of CI, sudoers and credential changes on
// 2026-09-02. The gate reads the diff a commit is about to seal.
describe("ship-review gate (ADR-0104)", () => {
  const cwd = "/proj";
  const diffOf =
    (files: string[], changedLines = 10) =>
    (): ShipDiff => ({ files, changedLines });

  beforeEach(() => resetShipReviewState());
  afterEach(() => resetShipReviewState());

  it("parses plain, compound and heredoc-style commit commands", () => {
    expect(parseCommitCommand("git status")).toBeNull();
    expect(parseCommitCommand("git commit -m x")).toEqual({
      dir: null,
      addAll: false,
      addPaths: [],
      commitAll: false,
    });
    expect(
      parseCommitCommand("cd /repo && git add -A && git commit -m 'feat: x' && git push"),
    ).toEqual({ dir: "/repo", addAll: true, addPaths: [], commitAll: false });
    expect(parseCommitCommand("git -C /repo add src/a.ts docs/b.md; git -C /repo commit -am x")).toEqual({
      dir: "/repo",
      addAll: false,
      addPaths: ["src/a.ts", "docs/b.md"],
      commitAll: true,
    });
    expect(
      parseCommitCommand('cd /r\ngit add .\ngit commit -m "$(cat <<\'EOF\'\nline one\nEOF\n)"'),
    ).toMatchObject({ dir: "/r", addAll: true });
    // --amend is not -a
    expect(parseCommitCommand("git commit --amend --no-edit")?.commitAll).toBe(false);
  });

  it("recognises the review skills, namespaced or not", () => {
    expect(shipReviewSkillOf("Skill", { skill: "pr-review" })).toBe("pr-review");
    expect(shipReviewSkillOf("Skill", { skill: "marvin:security-audit" })).toBe("security-audit");
    expect(shipReviewSkillOf("Skill", { skill: "graphify" })).toBeNull();
    expect(shipReviewSkillOf("Bash", { command: "pr-review" })).toBeNull();
  });

  it("classifies diffs by the personality's MUST and MUST-NOT lists", () => {
    expect(classifyShipDiff({ files: [], changedLines: 0 })).toEqual([]);
    expect(classifyShipDiff({ files: ["docs/adr/0001.md", "README.md"], changedLines: 900 })).toEqual([]);
    expect(classifyShipDiff({ files: ["pnpm-lock.yaml"], changedLines: 900 })).toEqual([]);
    // single small file = lint/format fix
    expect(classifyShipDiff({ files: ["src/a.ts"], changedLines: 12 })).toEqual([]);
    expect(classifyShipDiff({ files: ["src/a.ts"], changedLines: 51 }).map((n) => n.skill)).toEqual(["pr-review"]);
    expect(
      classifyShipDiff({ files: ["a.ts", "b.ts", "c.ts", "d.ts"], changedLines: 4 }).map((n) => n.skill),
    ).toEqual(["pr-review"]);
    const ops = classifyShipDiff({ files: [".gitlab-ci.yml", "scripts/ci-fetch-secrets.sh"], changedLines: 6 });
    expect(ops.map((n) => n.skill)).toEqual(["security-audit", "pr-review"]);
    expect(ops[0]?.reason).toContain(".gitlab-ci.yml (CI pipeline)");
    // tests on a boundary path are exempt
    expect(classifyShipDiff({ files: ["src/auth/login.test.ts"], changedLines: 3 })).toEqual([]);
  });

  it("boundary matcher covers what the session actually shipped unreviewed", () => {
    for (const f of [
      ".gitlab-ci.yml",
      "infrastructure/sudoers.d/gitlab-runner",
      "scripts/prod-backup-dump.sh",
      ".env.production",
      "src/auth/token-store.ts",
      "db/migrations/001.sql",
    ]) {
      expect(matchShipBoundary(f), f).not.toBeNull();
    }
    expect(matchShipBoundary("apps/api/src/main/java/Foo.java")).toBeNull();
    expect(matchShipBoundary("docs/runbooks/prod-deploy.md")).toBeNull();
  });

  it("denies a boundary commit until both skills have run, then allows it", () => {
    const ctx = createTurnDesignContext("t-0104-a", cwd);
    const collect = diffOf([".gitlab-ci.yml", "src/x.ts"], 20);
    const first = checkShipReview(ctx, "Bash", { command: "git commit -m x" }, collect);
    expect(first?.behavior).toBe("deny");
    expect(first?.message).toContain('skill: "security-audit"');
    expect(first?.message).toContain('skill: "pr-review"');

    recordAllowedTool(ctx, "Skill", { skill: "security-audit" });
    const second = checkShipReview(ctx, "Bash", { command: "git commit -m x" }, collect);
    expect(second?.message).toContain('skill: "pr-review"');
    expect(second?.message).not.toContain('skill: "security-audit"');

    recordAllowedTool(ctx, "Skill", { skill: "pr-review" });
    expect(checkShipReview(ctx, "Bash", { command: "git commit -m x" }, collect)).toBeNull();
  });

  it("a review this turn covers every commit this turn; an earlier one holds until the next commit", () => {
    const collect = diffOf(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], 80);
    const t1 = createTurnDesignContext("t-0104-b1", cwd);
    recordAllowedTool(t1, "Skill", { skill: "pr-review" });
    expect(checkShipReview(t1, "Bash", { command: "git commit -m one" }, collect)).toBeNull();
    recordAllowedTool(t1, "Bash", { command: "git commit -m one" });
    expect(checkShipReview(t1, "Bash", { command: "git commit -m two" }, collect)).toBeNull();
    recordAllowedTool(t1, "Bash", { command: "git commit -m two" });

    // Next turn, new commit, no new review → denied.
    const t2 = createTurnDesignContext("t-0104-b2", cwd);
    expect(checkShipReview(t2, "Bash", { command: "git commit -m three" }, collect)?.behavior).toBe("deny");
    // Review in t2 discharges it.
    recordAllowedTool(t2, "Skill", { skill: "pr-review" });
    expect(checkShipReview(t2, "Bash", { command: "git commit -m three" }, collect)).toBeNull();
    recordAllowedTool(t2, "Bash", { command: "git commit -m three" });
    // Review before the commit in t2 does not carry into t3's commit.
    const t3 = createTurnDesignContext("t-0104-b3", cwd);
    expect(checkShipReview(t3, "Bash", { command: "git commit -m four" }, collect)?.behavior).toBe("deny");
  });

  it("caps at SHIP_REVIEW_MAX_DENIES per turn and then lets the commit through", () => {
    const ctx = createTurnDesignContext("t-0104-c", cwd);
    const collect = diffOf(["a.ts", "b.ts", "c.ts", "d.ts"], 80);
    for (let i = 0; i < SHIP_REVIEW_MAX_DENIES; i++) {
      expect(checkShipReview(ctx, "Bash", { command: "git commit -m x" }, collect)?.behavior).toBe("deny");
    }
    expect(checkShipReview(ctx, "Bash", { command: "git commit -m x" }, collect)).toBeNull();
  });

  it("fails open when the diff cannot be read, and ignores non-commit shell", () => {
    const ctx = createTurnDesignContext("t-0104-d", cwd);
    expect(checkShipReview(ctx, "Bash", { command: "git commit -m x" }, () => null)).toBeNull();
    expect(checkShipReview(ctx, "Bash", { command: "git push origin main" }, diffOf([".env"]))).toBeNull();
    expect(checkShipReview(ctx, "Edit", { file_path: "/proj/.env" }, diffOf([".env"]))).toBeNull();
  });

  it("is wired into runDesignHooks in enforce mode and silent in measure mode", () => {
    const ctx = createTurnDesignContext("t-0104-e", cwd);
    ctx.hasGraph = false;
    // runDesignHooks uses the real collector; a cwd that is not a repo makes
    // it fail open, so the wiring is exercised through the parser path only.
    expect(runDesignHooks({ ctx, toolName: "Bash", toolInput: { command: "git commit -m x" }, mode: "enforce" })).toBeNull();
  });
});
