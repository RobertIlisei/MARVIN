/**
 * LLM-backed doc extraction — feeds BUSINESS_OVERVIEW.md, PROJECT_STATUS.md,
 * and README.md through the Anthropic Messages API with the same extraction
 * prompt the /graphify skill uses, then merges the result into
 * `<workDir>/graphify-out/graph.json`.
 *
 * Exposed as a plain async function; the caller owns the HTTP layer when /
 * if it wants one.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_DOCS = ["BUSINESS_OVERVIEW.md", "PROJECT_STATUS.md", "README.md"];
const DEFAULT_MODEL = "claude-haiku-4-5";

export interface RefreshDocsOptions {
  workDir: string;
  files?: string[];
  model?: string;
  force?: boolean;
  apiKey?: string;
}

export interface RefreshDocsResult {
  ok: boolean;
  graphPath: string;
  refreshedFiles?: string[];
  skipped?: string;
  model?: string;
  added?: { nodes: number; edges: number; hyperedges: number };
  removedBeforeMerge?: { nodes: number; edges: number; hyperedges: number };
  totals?: { nodes: number; edges: number; hyperedges: number };
  error?: string;
}

function extractionPrompt(files: Array<{ path: string; content: string }>): string {
  const fileBlocks = files
    .map(
      (f, i) =>
        `--- FILE ${i + 1}/${files.length}: ${f.path} ---\n${f.content}\n--- END FILE ${i + 1} ---`,
    )
    .join("\n\n");

  return `You are a graphify extraction subagent. Read the files below and extract a knowledge-graph fragment.
Output ONLY valid JSON matching the schema — no explanation, no markdown fences, no preamble.

Rules:
- EXTRACTED: relationship explicit in source.
- INFERRED: reasonable inference (shared data, implied dependency).
- AMBIGUOUS: uncertain; flag rather than omit.

Doc files: extract named concepts, entities, infrastructure services, subscription tiers, components, and rationale. Be thorough about every named service, library, database, queue, or tool the document mentions — whether listed in a "Stack", "Infrastructure", "Architecture", "Dependencies" section or inline in prose. Each named service becomes a node even if the doc only mentions it once; a service that appears together with others forms edges describing their relationship (hosts, depends-on, reads-from, publishes-to). Do not bias the extraction toward any specific stack — MARVIN is project-agnostic, and the graphifier must reflect whichever technologies THIS project actually uses.

For each node: file_type = "document", source_file = the relative path, snake_case stable id. confidence_score REQUIRED on every edge (1.0 EXTRACTED, 0.6-0.9 INFERRED, 0.1-0.3 AMBIGUOUS).

Output exactly this JSON (nothing else):
{"nodes":[{"id":"...","label":"...","file_type":"document","source_file":"...","source_location":null,"source_url":null,"captured_at":null,"author":null,"contributor":null}],"edges":[{"source":"...","target":"...","relation":"...","confidence":"EXTRACTED","confidence_score":1.0,"source_file":"...","source_location":null,"weight":1.0}],"hyperedges":[],"input_tokens":0,"output_tokens":0}

${fileBlocks}`;
}

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

export async function refreshDocs(options: RefreshDocsOptions): Promise<RefreshDocsResult> {
  const apiKey = (options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    return {
      ok: false,
      graphPath: "",
      error: "ANTHROPIC_API_KEY not set. Use a Console API key (sk-ant-api-…); OAuth tokens are not accepted by the Messages API.",
    };
  }
  if (apiKey.startsWith("sk-ant-oat-")) {
    return {
      ok: false,
      graphPath: "",
      error: "ANTHROPIC_API_KEY is an OAuth token. The Messages API requires a Console API key — generate one at console.anthropic.com.",
    };
  }

  const graphPath = join(options.workDir, "graphify-out", "graph.json");
  let graphMtime = 0;
  try {
    const st = await stat(graphPath);
    graphMtime = st.mtimeMs;
  } catch {
    return {
      ok: false,
      graphPath,
      error: `No graph.json at ${graphPath}. Run \`graphify update .\` first.`,
    };
  }

  const requestedFiles = options.files ?? DEFAULT_DOCS;
  const docs: Array<{ path: string; content: string; mtime: number }> = [];
  for (const rel of requestedFiles) {
    const full = join(options.workDir, rel);
    try {
      const [dst, content] = await Promise.all([stat(full), readFile(full, "utf-8")]);
      docs.push({ path: rel, content, mtime: dst.mtimeMs });
    } catch {
      /* skip missing */
    }
  }
  if (docs.length === 0) {
    return { ok: false, graphPath, error: "No matching doc files found" };
  }

  const staleDocs = options.force ? docs : docs.filter((d) => d.mtime > graphMtime);
  if (staleDocs.length === 0) {
    return {
      ok: true,
      graphPath,
      skipped: "no stale docs",
    };
  }

  const model = options.model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const prompt = extractionPrompt(staleDocs);

  let resp: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    resp = await client.messages.create({
      model,
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    return {
      ok: false,
      graphPath,
      error: `Anthropic API error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const blocks = resp.content ?? [];
  const textBlock = blocks.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  if (!textBlock || typeof textBlock.text !== "string" || !textBlock.text.trim()) {
    return { ok: false, graphPath, error: "Model returned no text content" };
  }

  const parsed = parseJsonPayload(textBlock.text);
  if (!parsed || !Array.isArray(parsed.nodes)) {
    return {
      ok: false,
      graphPath,
      error: "Could not parse extraction JSON from model response",
    };
  }

  const graphRaw = await readFile(graphPath, "utf-8");
  const graph = JSON.parse(graphRaw) as {
    nodes?: Array<Record<string, unknown>>;
    links?: Array<Record<string, unknown>>;
    hyperedges?: Array<Record<string, unknown>>;
  };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph.links) ? graph.links : [];
  const hyperedges = Array.isArray(graph.hyperedges) ? graph.hyperedges : [];

  const sourceFiles = new Set(staleDocs.map((d) => d.path));
  const keptNodes = nodes.filter((n) => !sourceFiles.has(String(n.source_file ?? "")));
  const keptLinks = links.filter((e) => !sourceFiles.has(String(e.source_file ?? "")));
  const keptHyperedges = hyperedges.filter(
    (h) => !sourceFiles.has(String((h as { source_file?: unknown }).source_file ?? "")),
  );

  const newNodes = (parsed.nodes as Array<Record<string, unknown>>).filter(
    (n) => n?.id && n?.label,
  );
  const newEdges = Array.isArray(parsed.edges)
    ? (parsed.edges as Array<Record<string, unknown>>).filter((e) => e?.source && e?.target)
    : [];
  const newHyperedges = Array.isArray(parsed.hyperedges)
    ? (parsed.hyperedges as Array<Record<string, unknown>>)
    : [];

  const merged = {
    ...graph,
    nodes: [...keptNodes, ...newNodes],
    links: [...keptLinks, ...newEdges],
    hyperedges: [...keptHyperedges, ...newHyperedges],
  };

  await writeFile(graphPath, JSON.stringify(merged, null, 2), "utf-8");

  return {
    ok: true,
    graphPath,
    model,
    refreshedFiles: staleDocs.map((d) => d.path),
    removedBeforeMerge: {
      nodes: nodes.length - keptNodes.length,
      edges: links.length - keptLinks.length,
      hyperedges: hyperedges.length - keptHyperedges.length,
    },
    added: {
      nodes: newNodes.length,
      edges: newEdges.length,
      hyperedges: newHyperedges.length,
    },
    totals: {
      nodes: merged.nodes.length,
      edges: merged.links.length,
      hyperedges: merged.hyperedges.length,
    },
  };
}
