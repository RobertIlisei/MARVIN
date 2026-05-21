/**
 * In-process MCP server that exposes the graphify knowledge graph to MARVIN
 * as a set of first-class tools. Registered by `@marvin/runtime/sdk-runner`
 * on every turn, scoped to the active project's workDir.
 *
 * The SDK's `createSdkMcpServer` returns a live MCP server object which we
 * hand to the agent via `Options.mcpServers`. Tool handlers run in-process,
 * so they share memory with the web app — no subprocess spawn, no stdio.
 *
 * Tools
 *   graph_summary      — corpus overview: stats, god nodes, top communities.
 *   graph_search       — find nodes whose label matches a query.
 *   graph_neighbors    — 1-hop neighbours of a node (blast-radius starter).
 *   graph_path         — shortest path between two concepts.
 *   graph_query        — BFS / DFS traversal answering a natural-language
 *                        question with a token budget (wraps the graphify
 *                        CLI's `query` subcommand).
 *   graph_save_result  — persist a Q&A pair to graphify-out/memory/ so
 *                        future sessions can leverage prior answers (wraps
 *                        graphify CLI's `save-result` subcommand).
 *
 * The first four tools are pure in-process reads of `graphify-out/graph.json`
 * and are safe to auto-allow. The last two shell out to the `graphify` CLI;
 * `graph_query` is read-only (still safe to auto-allow), while
 * `graph_save_result` writes under `graphify-out/memory/` and so should go
 * through the standard confirm path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  getNeighbors,
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

/**
 * Build a fresh MCP server bound to a single workDir. Creating one per turn
 * is cheap — the server only holds tool handler closures.
 */
export function createGraphMcpServer(workDir: string) {
  return createSdkMcpServer({
    name: "marvin-graph",
    version: "0.0.1",
    tools: [
      tool(
        "graph_summary",
        "Return an overview of the graphify knowledge graph for this project: node/edge/community counts, top-connected 'god' nodes, and the largest communities. Call this FIRST for any architectural or 'how does X work' question before reading files.",
        {},
        async () => {
          const summary = summarizeGraph(workDir);
          if (!summary.ok) {
            return errorResult(
              summary.error ?? "No graphify-out/graph.json in this project.",
            );
          }
          const lines: string[] = [];
          lines.push(
            `Graph: ${summary.stats.nodes} nodes · ${summary.stats.edges} edges · ${summary.stats.communities} communities (updated ${summary.updatedAt ?? "unknown"}).`,
          );
          lines.push("");
          lines.push("God nodes (most-connected abstractions — the structural spine):");
          for (const g of summary.godNodes) {
            lines.push(`  - ${g.label}  [${g.degree} edges]  (id: ${g.id})`);
          }
          lines.push("");
          lines.push("Top communities:");
          for (const c of summary.communities.slice(0, 10)) {
            lines.push(
              `  - [${c.id}] ${c.size} nodes — ${c.sampleLabels.join(" · ")}`,
            );
          }
          return textResult(lines.join("\n"));
        },
      ),
      tool(
        "graph_search",
        "Search the project's knowledge graph for nodes whose label matches a query. Use this BEFORE reading files when answering structural questions — graph hits point you straight at the right file + location and show their degree of connectedness.",
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
            .describe("Max results to return. Default 10."),
        },
        async ({ query, limit }) => {
          const hits = searchGraph(workDir, query, limit ?? 10);
          if (hits.length === 0) {
            return textResult(`No graph hits for "${query}".`);
          }
          const lines: string[] = [];
          lines.push(`Graph hits for "${query}":`);
          for (const h of hits) {
            const src = h.sourceFile ? ` · ${h.sourceFile}` : "";
            const com = h.community != null ? ` · community ${h.community}` : "";
            lines.push(
              `  - ${h.label}  [degree ${h.degree}${com}${src}]  (id: ${h.id})`,
            );
          }
          return textResult(lines.join("\n"));
        },
      ),
      tool(
        "graph_neighbors",
        "Return the 1-hop neighbours of a node — every direct relation (in or out) with its relation type and confidence. Use this for blast-radius analysis: 'what else will change if I touch X?' or 'who depends on X?'.",
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
            .describe("Max neighbours to return. Default 20."),
        },
        async ({ node, limit }) => {
          const result = getNeighbors(workDir, node, limit ?? 20);
          if (!result) {
            return errorResult(`No node in the graph matching '${node}'.`);
          }
          const src = result.node.source_file ? ` · ${result.node.source_file}` : "";
          const lines: string[] = [];
          lines.push(
            `Neighbours of '${result.node.label ?? result.node.id}' (id: ${result.node.id}${src}):`,
          );
          for (const n of result.neighbors) {
            const arrow = n.direction === "out" ? "→" : "←";
            const osrc = n.sourceFile ? ` · ${n.sourceFile}` : "";
            lines.push(
              `  ${arrow} ${n.relation} [${n.confidence}]  ${n.label}${osrc}  (id: ${n.id})`,
            );
          }
          if (result.neighbors.length === 0) {
            lines.push("  (no neighbours — this node is isolated in the graph)");
          }
          return textResult(lines.join("\n"));
        },
      ),
      tool(
        "graph_query",
        "Ask a natural-language architectural question against the project's knowledge graph. Runs the graphify CLI's BFS (default) or DFS traversal with a token budget and returns a synthesised answer with source citations. Prefer this over orchestrating graph_search + graph_neighbors manually when the user asks a free-text 'how does X work', 'what calls Y', 'why does Z exist' style question. Falls through cleanly if `graphify-out/graph.json` is missing.",
        {
          question: z
            .string()
            .min(1)
            .describe("Free-text architectural question to ask the graph."),
          budget: z
            .number()
            .int()
            .min(200)
            .max(8000)
            .optional()
            .describe(
              "Max answer length in tokens. Default 2000. Lower (~500) for follow-ups inside a larger turn; higher for the first orientation question.",
            ),
          dfs: z
            .boolean()
            .optional()
            .describe(
              "If true, use depth-first traversal (trace a specific path). Default is BFS (broad context).",
            ),
        },
        async ({ question, budget, dfs }) => {
          const args = ["query", question, "--budget", String(budget ?? 2000)];
          if (dfs) args.push("--dfs");
          try {
            const { stdout, stderr } = await pExecFile(graphifyBin(), args, {
              cwd: workDir,
              timeout: 60_000,
              maxBuffer: 4 * 1024 * 1024,
            });
            const out = stdout.trim();
            if (out.length === 0) {
              return errorResult(
                stderr.trim() ||
                  "graphify query returned no output — is graphify-out/graph.json present?",
              );
            }
            return textResult(out);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResult(`graphify query failed: ${message}`);
          }
        },
      ),
      tool(
        "graph_save_result",
        "Persist a graph-derived Q&A pair to `graphify-out/memory/` so future sessions on this project can reference it. Call after a `graph_query` (or any architectural answer you derived from graph citations) when the answer is genuinely useful and likely to be re-asked. The memory dir survives across sessions, like `.marvin/memory.md` — but scoped to graph-citable knowledge specifically.",
        {
          question: z
            .string()
            .min(1)
            .describe("The question that was asked."),
          answer: z
            .string()
            .min(1)
            .describe("The answer derived from the graph."),
          type: z
            .enum(["query", "path_query", "explain"])
            .optional()
            .describe(
              "Which graph tool produced the answer. Default 'query'. Use 'path_query' for graph_path answers, 'explain' for single-node walkthroughs.",
            ),
          nodes: z
            .array(z.string())
            .optional()
            .describe(
              "Source node labels cited in the answer (so a future query can rank by overlap). Optional but recommended.",
            ),
        },
        async ({ question, answer, type, nodes }) => {
          const args = [
            "save-result",
            "--question",
            question,
            "--answer",
            answer,
            "--type",
            type ?? "query",
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
            return textResult(out);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResult(`graphify save-result failed: ${message}`);
          }
        },
      ),
      tool(
        "graph_path",
        "Find the shortest structural path between two concepts (BFS on the undirected graph). Useful for questions like 'how is X related to Y?' or 'is there any coupling between module A and module B?'.",
        {
          from: z
            .string()
            .min(1)
            .describe("Source — node id or label."),
          to: z
            .string()
            .min(1)
            .describe("Target — node id or label."),
        },
        async ({ from, to }) => {
          const fromNode = resolveNode(workDir, from);
          const toNode = resolveNode(workDir, to);
          if (!fromNode) return errorResult(`No node matching '${from}'.`);
          if (!toNode) return errorResult(`No node matching '${to}'.`);
          const path = shortestPath(workDir, from, to);
          if (!path) {
            return textResult(
              `No path found between '${fromNode.node.label ?? fromNode.node.id}' and '${toNode.node.label ?? toNode.node.id}' — different components.`,
            );
          }
          const lines: string[] = [];
          lines.push(
            `Shortest path (${path.length - 1} hops): ${fromNode.node.label ?? fromNode.node.id} → ${toNode.node.label ?? toNode.node.id}`,
          );
          for (let i = 0; i < path.length; i += 1) {
            const hop = path[i]!;
            if (i === 0) {
              lines.push(`  ${hop.label}`);
            } else {
              lines.push(
                `    --${hop.relation ?? "related"} [${hop.confidence ?? "EXTRACTED"}]-->  ${hop.label}`,
              );
            }
          }
          return textResult(lines.join("\n"));
        },
      ),
    ],
  });
}
