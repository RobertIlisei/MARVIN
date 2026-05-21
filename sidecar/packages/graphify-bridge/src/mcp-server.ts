/**
 * In-process MCP server that exposes graphify knowledge graphs to MARVIN
 * as a set of first-class tools. Registered by `@marvin/runtime/sdk-runner`
 * on every turn, scoped to the active project's workDir.
 *
 * Two-graph topology (ADR-0028, development branch):
 *
 *   scope "code"      → <workDir>/graphify-out/graph.json
 *                       AST extraction of source files. Auto-rebuilt by the
 *                       watchdog on git HEAD advance. Free / no LLM cost.
 *
 *   scope "knowledge" → <workDir>/graphify-out/knowledge/graph.json
 *                       AST extraction of docs/, ADRs, top-level READMEs,
 *                       .marvin/memory.md. Rebuilt manually via
 *                       `bin/marvin knowledge-graph`.
 *
 *   scope "all"       → both, results tagged with their source graph.
 *
 * Every tool accepts a `scope` parameter; the default is "code" so existing
 * call sites keep working without change. Multi-graph is opt-in.
 *
 * Tools
 *   graph_summary      — corpus overview: stats, god nodes, top communities.
 *   graph_search       — find nodes whose label matches a query.
 *   graph_neighbors    — 1-hop neighbours of a node (blast-radius starter).
 *   graph_path         — shortest path between two concepts.
 *   graph_query        — BFS / DFS traversal answering a natural-language
 *                        question with a token budget (wraps the graphify
 *                        CLI's `query` subcommand).
 *   graph_save_result  — persist a Q&A pair to graphify-out/memory/.
 *
 * The first four tools are pure in-process reads — safe to auto-allow.
 * `graph_query` shells out to `graphify query --graph <path>` (read-only,
 * still safe to auto-allow). `graph_save_result` writes under
 * graphify-out/memory/ and so goes through the standard confirm path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  type GraphScope,
  getNeighbors,
  graphPathForScope,
  resolveNode,
  searchGraph,
  shortestPath,
  summarizeGraph,
} from "./read-graph";

const pExecFile = promisify(execFile);

function graphifyBin(): string {
  return process.env.GRAPHIFY_BIN || "graphify";
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

// ScopeSelection is what tools accept. "all" expands to ["code", "knowledge"].
type ScopeSelection = GraphScope | "all";

function expandScope(scope: ScopeSelection | undefined): GraphScope[] {
  if (scope === "all") return ["code", "knowledge"];
  return [scope ?? "code"];
}

// One zod schema reused across every scope-aware tool.
const scopeSchema = z
  .enum(["code", "knowledge", "all"])
  .optional()
  .describe(
    "Which graph to query. 'code' (default) = AST graph of source files. 'knowledge' = docs/ADRs/memory graph (must be built first via `bin/marvin knowledge-graph`). 'all' = query both and merge results, tagged by source.",
  );

/** Truncate long labels so a single community sample line can't blow context. */
function truncLabel(s: string, max = 100): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Build a fresh MCP server bound to a single workDir. Creating one per turn
 * is cheap — the server only holds tool handler closures.
 */
export function createGraphMcpServer(workDir: string) {
  // ── Tool: graph_summary ───────────────────────────────────────────────
  // Returns up to top-10 god nodes and top-10 communities per graph queried.
  // Truncates sample labels at 100 chars so one massive ADR-title sample
  // can't blow context (the failure mode observed on agri-saas-platform).
  const summaryTool = tool(
    "graph_summary",
    "Return an overview of the project's graphify knowledge graph(s): node/edge/community counts, top-connected 'god' nodes, and the largest communities. Call this FIRST for any architectural or 'how does X work' question before reading files. Use scope='knowledge' to orient against docs/ADRs/memory; scope='all' returns one section per graph.",
    { scope: scopeSchema },
    async ({ scope }) => {
      const scopes = expandScope(scope);
      const sections: string[] = [];
      for (const sc of scopes) {
        const path = graphPathForScope(workDir, sc);
        const summary = summarizeGraph(path);
        if (!summary.ok) {
          sections.push(
            `[${sc} graph] absent or unreadable — ${summary.error ?? "unknown reason"}` +
              (sc === "knowledge"
                ? "\n  Build it with: bin/marvin knowledge-graph"
                : "\n  Build it with: /graphify ."),
          );
          continue;
        }
        const lines: string[] = [];
        lines.push(
          `[${sc} graph] ${summary.stats.nodes} nodes · ${summary.stats.edges} edges · ${summary.stats.communities} communities (updated ${summary.updatedAt ?? "unknown"})`,
        );
        lines.push("  God nodes (structural spine):");
        for (const g of summary.godNodes) {
          lines.push(`    - ${truncLabel(g.label)}  [${g.degree} edges]  (id: ${g.id})`);
        }
        lines.push("  Top communities:");
        for (const c of summary.communities.slice(0, 10)) {
          const samples = c.sampleLabels
            .slice(0, 5)
            .map((l) => truncLabel(l, 60))
            .join(" · ");
          lines.push(`    - [${c.id}] ${c.size} nodes — ${samples}`);
        }
        sections.push(lines.join("\n"));
      }
      // If both graphs are missing, surface a single error so MARVIN
      // doesn't have to parse two near-identical messages.
      if (sections.every((s) => s.startsWith("[") && s.includes("absent"))) {
        return errorResult(sections.join("\n\n"));
      }
      return textResult(sections.join("\n\n"));
    },
  );

  // ── Tool: graph_search ────────────────────────────────────────────────
  const searchTool = tool(
    "graph_search",
    "Search the project's knowledge graph(s) for nodes whose label matches a query. Use BEFORE reading files when answering structural questions. Hits are tagged with the source graph when scope='all'.",
    {
      query: z
        .string()
        .min(1)
        .describe("Free-text query — matched against node labels."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results per graph. Default 10."),
      scope: scopeSchema,
    },
    async ({ query, limit, scope }) => {
      const scopes = expandScope(scope);
      const per = limit ?? 10;
      const sections: string[] = [];
      for (const sc of scopes) {
        const path = graphPathForScope(workDir, sc);
        const hits = searchGraph(path, query, per);
        if (hits.length === 0) {
          sections.push(`[${sc}] no hits for "${query}"`);
          continue;
        }
        const lines: string[] = [];
        lines.push(`[${sc}] hits for "${query}":`);
        for (const h of hits) {
          const src = h.sourceFile ? ` · ${h.sourceFile}` : "";
          const com = h.community != null ? ` · community ${h.community}` : "";
          lines.push(
            `  - ${truncLabel(h.label)}  [degree ${h.degree}${com}${src}]  (id: ${h.id})`,
          );
        }
        sections.push(lines.join("\n"));
      }
      return textResult(sections.join("\n\n"));
    },
  );

  // ── Tool: graph_neighbors ─────────────────────────────────────────────
  const neighborsTool = tool(
    "graph_neighbors",
    "Return the 1-hop neighbours of a node — every direct relation (in or out) with its relation type and confidence. Use this for blast-radius analysis. With scope='all' the node is looked up in both graphs and neighbours from each are returned in separate sections.",
    {
      node: z
        .string()
        .min(1)
        .describe("Node id (preferred) or a free-text label to resolve."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max neighbours per graph. Default 20."),
      scope: scopeSchema,
    },
    async ({ node, limit, scope }) => {
      const scopes = expandScope(scope);
      const cap = limit ?? 20;
      const sections: string[] = [];
      let foundAny = false;
      for (const sc of scopes) {
        const path = graphPathForScope(workDir, sc);
        const result = getNeighbors(path, node, cap);
        if (!result) {
          sections.push(`[${sc}] no node matching '${node}'`);
          continue;
        }
        foundAny = true;
        const src = result.node.source_file ? ` · ${result.node.source_file}` : "";
        const lines: string[] = [];
        lines.push(
          `[${sc}] neighbours of '${truncLabel(result.node.label ?? result.node.id)}' (id: ${result.node.id}${src}):`,
        );
        for (const n of result.neighbors) {
          const arrow = n.direction === "out" ? "→" : "←";
          const osrc = n.sourceFile ? ` · ${n.sourceFile}` : "";
          lines.push(
            `  ${arrow} ${n.relation} [${n.confidence}]  ${truncLabel(n.label)}${osrc}  (id: ${n.id})`,
          );
        }
        if (result.neighbors.length === 0) {
          lines.push("  (no neighbours — this node is isolated)");
        }
        sections.push(lines.join("\n"));
      }
      if (!foundAny) {
        return errorResult(sections.join("\n"));
      }
      return textResult(sections.join("\n\n"));
    },
  );

  // ── Tool: graph_path ──────────────────────────────────────────────────
  const pathTool = tool(
    "graph_path",
    "Find the shortest structural path between two concepts (BFS on the undirected graph). Path is computed within a single graph — pass scope='knowledge' for doc-ADR-memory relations, scope='code' for code structural paths. scope='all' returns one path per graph if both endpoints exist there.",
    {
      from: z.string().min(1).describe("Source — node id or label."),
      to: z.string().min(1).describe("Target — node id or label."),
      scope: scopeSchema,
    },
    async ({ from, to, scope }) => {
      const scopes = expandScope(scope);
      const sections: string[] = [];
      let foundAny = false;
      for (const sc of scopes) {
        const path = graphPathForScope(workDir, sc);
        const fromNode = resolveNode(path, from);
        const toNode = resolveNode(path, to);
        if (!fromNode || !toNode) {
          sections.push(
            `[${sc}] endpoint not found: ${!fromNode ? `'${from}'` : ""}${!fromNode && !toNode ? " and " : ""}${!toNode ? `'${to}'` : ""}`,
          );
          continue;
        }
        const hops = shortestPath(path, from, to);
        if (!hops) {
          sections.push(
            `[${sc}] no path between '${truncLabel(fromNode.node.label ?? fromNode.node.id)}' and '${truncLabel(toNode.node.label ?? toNode.node.id)}' — different components.`,
          );
          continue;
        }
        foundAny = true;
        const lines: string[] = [];
        lines.push(
          `[${sc}] shortest path (${hops.length - 1} hops): ${truncLabel(fromNode.node.label ?? fromNode.node.id)} → ${truncLabel(toNode.node.label ?? toNode.node.id)}`,
        );
        for (let i = 0; i < hops.length; i += 1) {
          const hop = hops[i]!;
          if (i === 0) {
            lines.push(`  ${truncLabel(hop.label)}`);
          } else {
            lines.push(
              `    --${hop.relation ?? "related"} [${hop.confidence ?? "EXTRACTED"}]-->  ${truncLabel(hop.label)}`,
            );
          }
        }
        sections.push(lines.join("\n"));
      }
      if (!foundAny) {
        return errorResult(sections.join("\n\n"));
      }
      return textResult(sections.join("\n\n"));
    },
  );

  // ── Tool: graph_query ─────────────────────────────────────────────────
  // Shells out to graphify CLI's `query` subcommand. The CLI accepts
  // --graph <path> so multi-scope is supported by running it once per
  // scope and concatenating outputs.
  const queryTool = tool(
    "graph_query",
    "Ask a natural-language architectural question against the project's knowledge graph(s). Runs the graphify CLI's BFS (default) or DFS traversal with a token budget and returns a synthesised answer with source citations. Prefer this over orchestrating graph_search + graph_neighbors manually for free-text 'how does X work', 'what calls Y', 'why does Z exist' questions. scope='all' runs the same question against both graphs.",
    {
      question: z.string().min(1).describe("Free-text architectural question."),
      budget: z
        .number()
        .int()
        .min(200)
        .max(8000)
        .optional()
        .describe(
          "Max answer length per graph in tokens. Default 2000. Lower for follow-ups; higher for the first orientation question.",
        ),
      dfs: z.boolean().optional().describe("Depth-first instead of breadth-first."),
      scope: scopeSchema,
    },
    async ({ question, budget, dfs, scope }) => {
      const scopes = expandScope(scope);
      const sections: string[] = [];
      for (const sc of scopes) {
        const path = graphPathForScope(workDir, sc);
        const args = [
          "query",
          question,
          "--budget",
          String(budget ?? 2000),
          "--graph",
          path,
        ];
        if (dfs) args.push("--dfs");
        try {
          const { stdout, stderr } = await pExecFile(graphifyBin(), args, {
            cwd: workDir,
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          const out = stdout.trim();
          if (out.length === 0) {
            sections.push(
              `[${sc}] graphify query returned no output — ${stderr.trim() || "is the graph present?"}`,
            );
            continue;
          }
          sections.push(`[${sc}]\n${out}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sections.push(`[${sc}] graphify query failed: ${message}`);
        }
      }
      return textResult(sections.join("\n\n"));
    },
  );

  // ── Tool: graph_save_result ───────────────────────────────────────────
  // Memory is per-graph: the CLI writes under <workDir>/graphify-out/memory/
  // by default. When saving against the knowledge graph we redirect via
  // --memory-dir so the two scopes don't collide in the same folder.
  const saveResultTool = tool(
    "graph_save_result",
    "Persist a graph-derived Q&A pair to graphify-out/memory/ (code scope) or graphify-out/knowledge/memory/ (knowledge scope) so future sessions can reference it. Call after a useful graph_query when the answer is genuinely re-askable.",
    {
      question: z.string().min(1).describe("The question that was asked."),
      answer: z.string().min(1).describe("The answer derived from the graph."),
      type: z
        .enum(["query", "path_query", "explain"])
        .optional()
        .describe("Which graph tool produced the answer. Default 'query'."),
      nodes: z
        .array(z.string())
        .optional()
        .describe(
          "Source node labels cited in the answer. Optional but recommended.",
        ),
      scope: z
        .enum(["code", "knowledge"])
        .optional()
        .describe(
          "Which graph's memory to write to. Default 'code'. (Can't write to both at once — call twice if you want a Q&A saved against both.)",
        ),
    },
    async ({ question, answer, type, nodes, scope }) => {
      const sc: GraphScope = scope ?? "code";
      const memoryDir =
        sc === "knowledge"
          ? "graphify-out/knowledge/memory"
          : "graphify-out/memory";
      const args = [
        "save-result",
        "--question",
        question,
        "--answer",
        answer,
        "--type",
        type ?? "query",
        "--memory-dir",
        memoryDir,
      ];
      if (nodes && nodes.length > 0) {
        args.push("--nodes", ...nodes);
      }
      try {
        const { stdout, stderr } = await pExecFile(graphifyBin(), args, {
          cwd: workDir,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        });
        const out = (stdout.trim() || stderr.trim() || "saved").trim();
        return textResult(`[${sc}] ${out}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`[${sc}] graphify save-result failed: ${message}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "marvin-graph",
    version: "0.0.2",
    tools: [
      summaryTool,
      searchTool,
      neighborsTool,
      pathTool,
      queryTool,
      saveResultTool,
    ],
  });
}
