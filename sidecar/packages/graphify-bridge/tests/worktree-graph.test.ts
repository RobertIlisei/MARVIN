/**
 * ADR-0124 B — a tab in its own worktree queries that worktree's code graph,
 * and says so when it has to fall back to the project's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { graphMcpTools } from "../src/mcp-server";
import {
  maybeRefreshWorktreeGraph,
  resetWorktreeGraphState,
  resolveGraphRoot,
  WORKTREE_GRAPH_FALLBACK_NOTE,
  worktreeOf,
} from "../src/worktree-graph";

let repo: string;
let tab: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function graphJson(nodes: Array<{ id: string; label: string; source_file: string }>): string {
  return JSON.stringify({ directed: false, multigraph: false, graph: {}, nodes: nodes.map((n) => ({ ...n, community: 0 })), links: [] });
}

async function search(cwd: string | undefined, query: string): Promise<string> {
  const tools = graphMcpTools(repo, { cwd });
  const t = tools.find((x) => x.name === "graph_search");
  if (!t) throw new Error("graph_search missing");
  const res = (await t.handler({ query } as never, {})) as { content: Array<{ text: string }> };
  return res.content.map((c) => c.text).join("\n");
}

beforeEach(() => {
  resetWorktreeGraphState();
  repo = realpathSync(mkdtempSync(join(tmpdir(), "wt-graph-")));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@x");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), ".marvin/worktrees/\n");
  writeFileSync(join(repo, "core.ts"), "export function projectSymbol() { return 1; }\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  tab = join(repo, ".marvin", "worktrees", "tab-x");
  mkdirSync(join(repo, ".marvin", "worktrees"), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "marvin/tab/x", tab);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("resolveGraphRoot", () => {
  it("maps a tab's cwd (or any dir inside it) to its worktree; the main checkout is not one", () => {
    expect(worktreeOf(repo, tab)).toBe(tab);
    expect(worktreeOf(repo, join(tab, "apps", "web"))).toBe(tab);
    expect(worktreeOf(repo, repo)).toBeNull();
    expect(worktreeOf(repo, undefined)).toBeNull();
  });

  it("uses the worktree graph when it exists, else the project graph with the note", () => {
    expect(resolveGraphRoot(repo, tab)).toEqual({ root: repo, worktree: tab, note: WORKTREE_GRAPH_FALLBACK_NOTE });
    mkdirSync(join(tab, "graphify-out"), { recursive: true });
    writeFileSync(join(tab, "graphify-out", "graph.json"), "{}");
    expect(resolveGraphRoot(repo, tab)).toEqual({ root: tab, worktree: tab, note: null });
    expect(resolveGraphRoot(repo, repo).note).toBeNull();
  });
});

describe("graph_search in a worktree tab", () => {
  beforeEach(() => {
    mkdirSync(join(repo, "graphify-out"), { recursive: true });
    writeFileSync(join(repo, "graphify-out", "graph.json"), graphJson([{ id: "p", label: "projectSymbol()", source_file: "core.ts" }]));
  });

  it("finds a symbol the tab added once the worktree has its own graph", async () => {
    mkdirSync(join(tab, "graphify-out"), { recursive: true });
    writeFileSync(
      join(tab, "graphify-out", "graph.json"),
      graphJson([
        { id: "p", label: "projectSymbol()", source_file: "core.ts" },
        { id: "t", label: "tabAddedSymbol()", source_file: "feature.ts" },
      ]),
    );
    const out = await search(tab, "tabAddedSymbol");
    expect(out).toContain("tabAddedSymbol()");
    expect(out).not.toContain(WORKTREE_GRAPH_FALLBACK_NOTE);
    // The shared checkout still reads the project graph, which never saw it.
    expect(await search(repo, "tabAddedSymbol")).toContain("no hits");
  });

  it("falls back to the project graph with the note when the worktree has none", async () => {
    const out = await search(tab, "projectSymbol");
    expect(out).toContain("projectSymbol()");
    expect(out).toContain(WORKTREE_GRAPH_FALLBACK_NOTE);
    expect(await search(repo, "projectSymbol")).not.toContain(WORKTREE_GRAPH_FALLBACK_NOTE);
  });
});

describe("maybeRefreshWorktreeGraph", () => {
  it("is a no-op outside a worktree and without a project graph to seed from", async () => {
    expect((await maybeRefreshWorktreeGraph(repo, repo)).reason).toBe("not a worktree");
    expect((await maybeRefreshWorktreeGraph(repo, tab)).reason).toBe("no project graph to seed from");
  });

  const hasGraphify = spawnSync("graphify", ["--version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!hasGraphify)(
    "seeds from the project graph and indexes what the tab wrote (real graphify, AST-only)",
    async () => {
      execFileSync("graphify", ["update", repo], { cwd: repo, stdio: "ignore", timeout: 120_000 });
      expect(existsSync(join(repo, "graphify-out", "graph.json"))).toBe(true);
      writeFileSync(join(tab, "feature.ts"), "export function tabAddedSymbol() { return 2; }\n");
      const r = await maybeRefreshWorktreeGraph(repo, tab, { source: "test" });
      expect(r).toMatchObject({ triggered: true, seeded: true });
      // The update runs detached; wait for it to land the new symbol.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const g = join(tab, "graphify-out", "graph.json");
        if (existsSync(g) && readFileSync(g, "utf8").includes("tabAddedSymbol")) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      expect(await search(tab, "tabAddedSymbol")).toContain("tabAddedSymbol");
      // Kept out of the tab's diff.
      expect(git(tab, "status", "--porcelain")).not.toContain("graphify-out");
      // A second call right away is debounced, not a second process.
      expect((await maybeRefreshWorktreeGraph(repo, tab)).triggered).toBe(false);
    },
    120_000,
  );
});
