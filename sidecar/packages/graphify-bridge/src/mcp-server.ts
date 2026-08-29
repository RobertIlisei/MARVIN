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
 *   graph_affected     — DIRECTED blast radius: who calls this symbol.
 *   graph_save_result  — persist a Q&A pair + its outcome to graphify-out/memory/.
 *   graph_reflect      — aggregate those outcomes into a lessons document.
 *
 * The read tools are pure in-process reads — safe to auto-allow.
 * `graph_query` shells out to `graphify query --graph <path>` (read-only,
 * still safe to auto-allow). `graph_save_result` and `graph_reflect` write
 * under graphify-out/ and so go through the standard confirm path.
 *
 * ## The work-memory loop (graph_save_result → graph_reflect)
 *
 * `save-result` has carried `--outcome useful|dead_end|corrected` since
 * graphify 0.9.x; MARVIN never sent it, and never ran `reflect`. The result,
 * measured on a real project 2026-08-15: 3 saved Q&As, zero outcomes, no
 * `reflections/` directory. MARVIN was caching graph answers and learning
 * nothing from whether they were right. `outcome` is now a first-class
 * parameter and `graph_reflect` closes the loop.
 *
 * ## Why graph_affected does not use `graphify affected`
 *
 * Because that subcommand reverse-traverses `graph.json`, which is built
 * undirected — orientation in `links` is networkx adjacency-iteration order,
 * not semantics, so reverse traversal degrades to a neighbourhood walk. The
 * directed truth lives in the per-file extraction cache. See `call-index.ts`
 * for the measurement.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { changeImpact, changedFilesOnBranch, renderChangeImpact } from "./change-impact";
import { z } from "zod";

import { buildCallIndex, callersOf } from "./call-index";
import {
  type GraphScope,
  getNeighbors,
  graphPathForScope,
  nodeLabelIndex,
  nodeLabelResolver,
  resolveNode,
  searchGraph,
  shortestPath,
  summarizeGraph,
  loadGraphNodes,
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

/**
 * Where the work-memory for a scope lives, relative to workDir.
 *
 * The two scopes must not share a directory: `reflect` aggregates a whole
 * memory dir into one lessons doc, and mixing code and doc outcomes would
 * produce lessons that cite nodes absent from the graph being reflected on.
 */
function memoryDirForScope(scope: GraphScope): string {
  return scope === "knowledge"
    ? "graphify-out/knowledge/memory"
    : "graphify-out/memory";
}

function reflectionsPathForScope(scope: GraphScope): string {
  return scope === "knowledge"
    ? "graphify-out/knowledge/reflections/LESSONS.md"
    : "graphify-out/reflections/LESSONS.md";
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
        let unnamed = 0;
        for (const c of summary.communities.slice(0, 10)) {
          const samples = c.sampleLabels
            .slice(0, 5)
            .map((l) => truncLabel(l, 60))
            .join(" · ");
          if (!c.name) unnamed += 1;
          // The name is the orientation signal — "Backlog Service Types" tells
          // MARVIN where to look; "[12] 44 nodes" does not.
          const named = c.name ? `${truncLabel(c.name, 60)} ` : "";
          lines.push(`    - ${named}[${c.id}] ${c.size} nodes — ${samples}`);
        }
        if (unnamed > 0) {
          lines.push(
            `  (${unnamed} of the top communities are unnamed — run \`graphify label . --backend=claude-cli\` to name them; no API key needed.)`,
          );
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
      context: z
        .array(z.string().min(1))
        .max(6)
        .optional()
        .describe(
          "Restrict traversal to these edge contexts/relations, e.g. [\"calls\"] for a call chain or [\"imports\", \"imports_from\"] for module coupling. The CLI's `--context` flag; omit to traverse everything. Use it when a question drowns in `references`/`contains` noise.",
        ),
      scope: scopeSchema,
    },
    async ({ question, budget, dfs, context, scope }) => {
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
        for (const c of context ?? []) args.push("--context", c);
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
    "Persist a graph-derived Q&A pair to graphify-out/memory/ (code scope) or graphify-out/knowledge/memory/ (knowledge scope) so future sessions can reference it. Call after a graph_query whose answer is genuinely re-askable. ALWAYS pass `outcome`: 'useful' if the graph answer held up against the code you then read, 'dead_end' if the graph did not contain the answer and you fell back to grep/Read, 'corrected' (with `correction`) if the graph answer was WRONG and you found the truth elsewhere. The outcome is the signal `graph_reflect` learns from — a save without one is a cache entry, not feedback.",
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
      outcome: z
        .enum(["useful", "dead_end", "corrected"])
        .optional()
        .describe(
          "Work-memory signal. 'useful' = the graph answer survived verification against the source. 'dead_end' = the graph could not answer it. 'corrected' = the graph answer was wrong; pass `correction` with what was actually true. Omit ONLY when you have not yet verified the answer.",
        ),
      correction: z
        .string()
        .optional()
        .describe(
          "What the right answer turned out to be. Required when outcome='corrected'; ignored otherwise.",
        ),
      scope: z
        .enum(["code", "knowledge"])
        .optional()
        .describe(
          "Which graph's memory to write to. Default 'code'. (Can't write to both at once — call twice if you want a Q&A saved against both.)",
        ),
    },
    async ({ question, answer, type, nodes, outcome, correction, scope }) => {
      const sc: GraphScope = scope ?? "code";
      // A 'corrected' outcome with nothing to correct TO teaches `reflect`
      // that a node is unreliable while withholding the one thing that would
      // make the lesson actionable. Reject rather than silently degrade it to
      // an unexplained downvote.
      if (outcome === "corrected" && !correction?.trim()) {
        return errorResult(
          "outcome='corrected' requires `correction` — state what the right answer actually was, " +
            "otherwise the lesson records only that the graph was wrong and not what is true.",
        );
      }
      const memoryDir = memoryDirForScope(sc);
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
      if (outcome) args.push("--outcome", outcome);
      if (outcome === "corrected" && correction) {
        args.push("--correction", correction);
      }
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

  // ── Tool: graph_affected ──────────────────────────────────────────────
  // The blast-radius tool Golden Rule 7 always assumed existed. Built on the
  // per-file extraction cache rather than graph.json, because only the cache
  // carries edge DIRECTION — see call-index.ts for the measurement behind that.
  const affectedTool = tool(
    "graph_affected",
    "Blast radius: find every function that CALLS a symbol, with exact file and line, plus optionally their callers. Use this BEFORE changing or deleting any function, and to answer 'what breaks if I change X' / 'who calls X' / 'is this dead code'. This is directed — unlike graph_neighbors, which returns undirected 1-hop relations and cannot tell callers from callees. Code scope only.",
    {
      symbol: z
        .string()
        .min(1)
        .describe(
          "The symbol name to find callers of, e.g. 'buildProjectContext'. Bare name — trailing '()' is stripped. Matched by NAME, so distinctive symbols give precise answers and generic ones (parse, get, trim) over-match.",
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe(
          "How many hops back to walk. 1 (default) = direct callers. 2 = callers of the callers. Ignored when the symbol name is ambiguous.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max callers to list. Default 30."),
    },
    async ({ symbol, depth, limit }) => {
      const index = buildCallIndex(workDir);
      if (index.files === 0) {
        return errorResult(
          "No graphify extraction cache at graphify-out/cache/ — blast radius needs it. " +
            "Build the code graph first: `graphify . --code-only` (AST-only, no LLM cost).",
        );
      }
      // Suffix-tolerant: the cache's caller ids and graph.json's node ids use
      // different prefixes (see nodeLabelResolver) — exact lookup hit 0.0 %
      // of callers on a real repo and printed raw ids for two months.
      const resolveLabel = nodeLabelResolver(graphPathForScope(workDir, "code"));
      const result = callersOf(index, symbol, depth ?? 1, resolveLabel);

      if (result.callers.length === 0) {
        return textResult(
          `No callers of '${result.symbol}' found in ${index.edges} indexed call edges.\n` +
            "Either it is genuinely uncalled (dead code, an entry point, or reached only " +
            "dynamically/by reflection), or it is spelled differently in the source. " +
            "Confirm with graph_search before concluding it is dead.",
        );
      }

      // Collapse rows that render identically. Two distinct node ids can carry
      // the same label in the same file (graphify mints one per definition
      // site, so `POST()` in a route file yields several); listing them
      // separately reads as a duplicate-row bug rather than as extra detail.
      const rows = new Map<
        string,
        { label: string; file: string; lines: string[]; depth: number }
      >();
      for (const c of result.callers) {
        const rel = c.sourceFile.startsWith(workDir)
          ? c.sourceFile.slice(workDir.length + 1)
          : c.sourceFile;
        const label = resolveLabel(c.callerNid) ?? c.callerNid;
        const key = `${label}|${rel}`;
        const existing = rows.get(key);
        if (existing) {
          for (const l of c.lines) {
            if (!existing.lines.includes(l)) existing.lines.push(l);
          }
          existing.depth = Math.min(existing.depth, c.depth);
          continue;
        }
        rows.set(key, { label, file: rel, lines: [...c.lines], depth: c.depth });
      }

      const cap = limit ?? 30;
      const all = [...rows.values()];
      const shown = all.slice(0, cap);
      const lines: string[] = [];
      lines.push(
        `Callers of '${result.symbol}' — ${all.length} function(s) across ${result.directSites} direct call site(s):`,
      );
      for (const r of shown) {
        // Numeric sort: "L9" before "L188" is the reading order in the file.
        const ordered = [...r.lines].sort(
          (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
        );
        const where = ordered.length ? `:${ordered.join(",")}` : "";
        const hop = r.depth > 1 ? `  [depth ${r.depth}]` : "";
        lines.push(`  - ${r.label} — ${r.file}${where}${hop}`);
      }
      if (all.length > shown.length) {
        lines.push(`  … ${all.length - shown.length} more (raise \`limit\`)`);
      }
      // Say it plainly when the answer is dominated by name collisions. A
      // blast-radius number that silently conflates every unrelated `.parse()`
      // in the repo is worse than no number at all.
      if (result.ambiguous) {
        lines.push(
          "",
          `WARNING: '${result.symbol}' is a common name — these ${result.directSites} call sites ` +
            "almost certainly include unrelated symbols that merely share it. Treat this as a " +
            "starting point, not a blast radius, and narrow with graph_search or a scoped grep. " +
            "Depth traversal was skipped for the same reason.",
        );
      }
      if (index.stale > 0) {
        lines.push(
          "",
          `(${index.stale} cached call site(s) ignored — their source files no longer exist. ` +
            "Rebuild with `graphify . --code-only` to prune them.)",
        );
      }
      return textResult(lines.join("\n"));
    },
  );

  // ── Tool: graph_reflect ───────────────────────────────────────────────
  // Closes the loop graph_save_result opens. Deterministic aggregation — no
  // LLM — so it is safe to run whenever outcomes have accumulated.
  const reflectTool = tool(
    "graph_reflect",
    "Aggregate the outcomes recorded by graph_save_result into a deterministic lessons document (graphify-out/reflections/LESSONS.md), weighting recent signal more heavily and requiring corroboration before trusting a node. Run it when several outcomes have accumulated, or when starting work in an area where the graph previously misled you. Returns the lessons so you can act on them in this turn. Read-only apart from writing the lessons file.",
    {
      scope: z
        .enum(["code", "knowledge"])
        .optional()
        .describe("Which graph's work-memory to reflect on. Default 'code'."),
      halfLifeDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe(
          "Signal weight halves every N days. Default 30 — lower it on a fast-moving codebase where old outcomes stop being true.",
        ),
      minCorroboration: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe(
          "Distinct 'useful' outcomes before a node is treated as reliable. Default 2 — one good answer is an anecdote.",
        ),
    },
    async ({ scope, halfLifeDays, minCorroboration }) => {
      const sc: GraphScope = scope ?? "code";
      const args = [
        "reflect",
        "--memory-dir",
        memoryDirForScope(sc),
        "--out",
        reflectionsPathForScope(sc),
        "--graph",
        graphPathForScope(workDir, sc),
      ];
      if (halfLifeDays) args.push("--half-life-days", String(halfLifeDays));
      if (minCorroboration) {
        args.push("--min-corroboration", String(minCorroboration));
      }
      try {
        const { stdout, stderr } = await pExecFile(graphifyBin(), args, {
          cwd: workDir,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const out = stdout.trim() || stderr.trim();
        let lessons = "";
        try {
          lessons = readFileSync(
            join(workDir, reflectionsPathForScope(sc)),
            "utf-8",
          ).trim();
        } catch {
          // The doc is the point, but a run that produced no file is still
          // worth reporting honestly rather than as a failure.
        }
        if (!lessons) {
          return textResult(
            `[${sc}] ${out || "reflect produced no lessons"} — there is not enough ` +
              "outcome signal yet. Lessons need graph_save_result calls that carry an " +
              "`outcome`; saves without one contribute nothing here.",
          );
        }
        return textResult(
          `[${sc}] lessons written to ${reflectionsPathForScope(sc)}\n\n${truncLabel(lessons, 6000)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`[${sc}] graphify reflect failed: ${message}`);
      }
    },
  );

  // ── Tool: graph_community ─────────────────────────────────────────────
  // The official graphify MCP server has `get_community`; `graph_summary`
  // names the largest communities but cannot list one. Members by id or by
  // (labelled) name, so "what else is in the Billing cluster" is one call.
  const communityTool = tool(
    "graph_community",
    "List the members of ONE community (cluster) of the graph, by numeric id or by labelled name (case-insensitive substring). Use after graph_summary names a community you want to see inside, or after graph_change_impact reports which communities a branch touches. Returns labels with their source files.",
    {
      community: z
        .union([z.number().int().min(0), z.string().min(1)])
        .describe("Community id (from graph_summary / graph_change_impact) or a name fragment like 'billing'."),
      limit: z.number().int().min(1).max(200).optional().describe("Max members to list. Default 60."),
      scope: scopeSchema,
    },
    async ({ community, limit, scope }) => {
      const scopes = expandScope(scope);
      const cap = limit ?? 60;
      const sections: string[] = [];
      for (const sc of scopes) {
        const nodes = loadGraphNodes(graphPathForScope(workDir, sc));
        if (nodes.length === 0) {
          sections.push(`[${sc}] graph absent or empty`);
          continue;
        }
        let id: number | null = null;
        if (typeof community === "number") {
          id = community;
        } else {
          const needle = community.toLowerCase();
          const hit = nodes.find(
            (n) => typeof n.community === "number" && (n.community_name ?? "").toLowerCase().includes(needle),
          );
          id = hit?.community ?? null;
        }
        if (id === null) {
          sections.push(`[${sc}] no community matching '${community}' — use graph_summary to see the named ones`);
          continue;
        }
        const members = nodes.filter((n) => n.community === id);
        const name = members.map((n) => n.community_name).find((v) => v && !/^community\s+\d+$/i.test(v)) ?? null;
        const lines = [`[${sc}] community ${id}${name ? ` — ${name}` : ""}: ${members.length} member(s)`];
        for (const n of members.slice(0, cap)) {
          const file = n.source_file ? n.source_file.replace(`${workDir}/`, "") : "";
          lines.push(`  - ${truncLabel(n.label ?? n.id)}${file ? `  (${file})` : ""}`);
        }
        if (members.length > cap) lines.push(`  … ${members.length - cap} more (raise \`limit\`)`);
        sections.push(lines.join("\n"));
      }
      return textResult(sections.join("\n\n"));
    },
  );

  // ── Tool: graph_change_impact ─────────────────────────────────────────
  // Diff-level blast radius. Forge-agnostic replacement for graphify's
  // GitHub-only `get_pr_impact`: git names the files, graph.json maps them
  // to symbols and communities, the AST call cache finds who reaches into
  // them from OUTSIDE the branch. See change-impact.ts.
  const changeImpactTool = tool(
    "graph_change_impact",
    "Blast radius of a whole branch / diff / MR: which code symbols the changed files define, which communities they belong to, whether any is a god node, and — the part to review first — every caller OUTSIDE the changed files that reaches into them, with file and line. Call with no arguments to analyse the current branch against its base (working tree + untracked included); pass `files` to analyse an explicit change set. Use in Phase 3 impact analysis for any multi-file change and at the start of a pre-landing review. Per-symbol detail is graph_affected; this is the aggregate. Code scope only.",
    {
      files: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe("Changed files, repo-relative. Omit to diff the current branch against `base`."),
      base: z
        .string()
        .min(1)
        .optional()
        .describe("Base ref for the diff, e.g. 'origin/main'. Default: origin/HEAD, then origin/main / main."),
      limit: z.number().int().min(1).max(200).optional().describe("Max external callers to list. Default 40."),
    },
    async ({ files, base, limit }) => {
      const index = buildCallIndex(workDir);
      if (index.files === 0) {
        return errorResult(
          "No graphify extraction cache at graphify-out/cache/ — change impact needs it. " +
            "Build the code graph first: `graphify . --code-only`.",
        );
      }
      let changed = files ?? [];
      let resolvedBase: string | undefined;
      if (!files) {
        try {
          const r = await changedFilesOnBranch(workDir, base);
          changed = r.files;
          resolvedBase = r.base;
        } catch (err) {
          return errorResult(`git diff failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (changed.length === 0) {
        return textResult(resolvedBase ? `No changes on this branch relative to ${resolvedBase}.` : "No files given.");
      }
      const report = changeImpact({
        workDir,
        graphPath: graphPathForScope(workDir, "code"),
        index,
        files: changed,
      });
      return textResult(renderChangeImpact(report, { base: resolvedBase, limit: limit ?? 40 }));
    },
  );

  return createSdkMcpServer({
    name: "marvin-graph",
    version: "0.0.4",
    // ADR-0073 — Agent SDK 0.3 DEFERS MCP tools behind ToolSearch by default.
    // These are the graphify-first tools (Golden Rule 7): the design hooks
    // hard-deny Read/Grep/Glob until a graph call has happened, so if the
    // graph tools are not in the turn-1 prompt the rule deadlocks the turn.
    // alwaysLoad also blocks startup until this server is connected.
    alwaysLoad: true,
    tools: [
      summaryTool,
      searchTool,
      neighborsTool,
      pathTool,
      queryTool,
      affectedTool,
      changeImpactTool,
      communityTool,
      saveResultTool,
      reflectTool,
    ],
  });
}
