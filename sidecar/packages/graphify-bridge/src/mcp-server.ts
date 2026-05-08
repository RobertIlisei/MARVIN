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
 *   graph_summary   — corpus overview: stats, god nodes, top communities.
 *   graph_search    — find nodes whose label matches a query.
 *   graph_neighbors — 1-hop neighbours of a node (blast-radius starter).
 *   graph_path      — shortest path between two concepts.
 *
 * All tools are read-only — safe to auto-allow in the tool policy.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  getNeighbors,
  resolveNode,
  searchGraph,
  shortestPath,
  summarizeGraph,
} from "./read-graph";

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
