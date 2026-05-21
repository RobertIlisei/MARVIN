/**
 * Read-side of the graphify bridge. Loads a per-project graph JSON file and
 * surfaces summaries / search / neighbour queries.
 *
 * Graph location is parametrised — pass the full path to graph.json. The
 * helper `graphPathForScope(workDir, scope)` resolves the canonical paths
 * MARVIN uses for the two-graph topology (ADR-0028):
 *
 *   scope "code"      → <workDir>/graphify-out/graph.json
 *   scope "knowledge" → <workDir>/graphify-out/knowledge/graph.json
 *
 * Default scope is "code" — every existing call site keeps working without
 * change.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type GraphScope = "code" | "knowledge";

export function graphPathForScope(workDir: string, scope: GraphScope = "code"): string {
  const root = resolve(workDir);
  return scope === "knowledge"
    ? join(root, "graphify-out", "knowledge", "graph.json")
    : join(root, "graphify-out", "graph.json");
}

export interface GraphNode {
  id: string;
  label?: string;
  community?: number;
  file_type?: string;
  source_file?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
}

interface RawNodeLink {
  directed?: boolean;
  multigraph?: boolean;
  graph?: Record<string, unknown>;
  nodes?: GraphNode[];
  links?: GraphLink[];
  edges?: GraphLink[];
}

export interface GraphSummary {
  ok: boolean;
  path: string;
  exists: boolean;
  updatedAt: string | null;
  error: string | null;
  stats: {
    nodes: number;
    edges: number;
    communities: number;
  };
  /** Top nodes by degree ("god nodes"). */
  godNodes: Array<{ id: string; label: string; degree: number }>;
  /** Community id → member count + sample labels. */
  communities: Array<{
    id: number;
    size: number;
    sampleLabels: string[];
  }>;
}

function emptySummary(path: string, error: string | null): GraphSummary {
  return {
    ok: false,
    path,
    exists: false,
    updatedAt: null,
    error,
    stats: { nodes: 0, edges: 0, communities: 0 },
    godNodes: [],
    communities: [],
  };
}

export function summarizeGraph(graphPath: string): GraphSummary {
  if (!existsSync(graphPath)) {
    return emptySummary(graphPath, `No graph at ${graphPath}.`);
  }
  let raw: RawNodeLink;
  let updatedAt: string;
  try {
    const st = statSync(graphPath);
    updatedAt = new Date(st.mtimeMs).toISOString();
    raw = JSON.parse(readFileSync(graphPath, "utf-8")) as RawNodeLink;
  } catch (err) {
    return emptySummary(graphPath, err instanceof Error ? err.message : String(err));
  }

  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const links = Array.isArray(raw.links)
    ? raw.links
    : Array.isArray(raw.edges)
      ? raw.edges
      : [];

  const degree = new Map<string, number>();
  for (const l of links) {
    if (typeof l.source === "string") {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    }
    if (typeof l.target === "string") {
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
  }

  const byId = new Map<string, GraphNode>();
  for (const n of nodes) byId.set(n.id, n);

  const godNodes = Array.from(degree.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, deg]) => ({
      id,
      label: byId.get(id)?.label ?? id,
      degree: deg,
    }));

  const byCommunity = new Map<number, { labels: string[] }>();
  for (const n of nodes) {
    if (typeof n.community !== "number") continue;
    const cur = byCommunity.get(n.community) ?? { labels: [] };
    cur.labels.push(n.label ?? n.id);
    byCommunity.set(n.community, cur);
  }

  const communities = Array.from(byCommunity.entries())
    .map(([id, v]) => ({
      id,
      size: v.labels.length,
      sampleLabels: v.labels.slice(0, 5),
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);

  return {
    ok: true,
    path: graphPath,
    exists: true,
    updatedAt,
    error: null,
    stats: {
      nodes: nodes.length,
      edges: links.length,
      communities: byCommunity.size,
    },
    godNodes,
    communities,
  };
}

export interface SearchHit {
  id: string;
  label: string;
  sourceFile: string | null;
  degree: number;
  community: number | null;
}

/**
 * Resolve a node either by exact id or by best label match (case-insensitive,
 * sum of term-hits weighted by degree). Returns the resolved GraphNode +
 * computed degree, or null when nothing matches.
 */
export interface ResolvedNode {
  node: GraphNode;
  degree: number;
}

function loadRaw(graphPath: string): { raw: RawNodeLink; nodes: GraphNode[]; links: GraphLink[] } | null {
  if (!existsSync(graphPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(graphPath, "utf-8")) as RawNodeLink;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const links = Array.isArray(raw.links)
      ? raw.links
      : Array.isArray(raw.edges)
        ? raw.edges
        : [];
    return { raw, nodes, links };
  } catch {
    return null;
  }
}

function computeDegrees(links: GraphLink[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const l of links) {
    if (typeof l.source === "string") degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    if (typeof l.target === "string") degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  return degree;
}

export function resolveNode(
  graphPath: string,
  queryOrId: string,
): ResolvedNode | null {
  const data = loadRaw(graphPath);
  if (!data) return null;
  const direct = data.nodes.find((n) => n.id === queryOrId);
  const degree = computeDegrees(data.links);
  if (direct) return { node: direct, degree: degree.get(direct.id) ?? 0 };
  const q = queryOrId.toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  let best: { node: GraphNode; score: number; degree: number } | null = null;
  for (const n of data.nodes) {
    const label = (n.label ?? n.id).toLowerCase();
    let score = 0;
    for (const t of terms) if (label.includes(t)) score += 1;
    if (score === 0) continue;
    const deg = degree.get(n.id) ?? 0;
    const effective = score * 10 + deg / 100;
    if (!best || effective > best.score) {
      best = { node: n, score: effective, degree: deg };
    }
  }
  return best ? { node: best.node, degree: best.degree } : null;
}

export interface Neighbor {
  id: string;
  label: string;
  relation: string;
  direction: "out" | "in";
  confidence: string;
  sourceFile: string | null;
}

export function getNeighbors(
  graphPath: string,
  nodeQueryOrId: string,
  limit = 20,
): { node: GraphNode; neighbors: Neighbor[] } | null {
  const data = loadRaw(graphPath);
  if (!data) return null;
  const resolved = resolveNode(graphPath, nodeQueryOrId);
  if (!resolved) return null;
  const id = resolved.node.id;
  const byId = new Map<string, GraphNode>();
  for (const n of data.nodes) byId.set(n.id, n);
  const out: Neighbor[] = [];
  for (const l of data.links) {
    if (l.source === id && l.target) {
      const other = byId.get(l.target);
      out.push({
        id: l.target,
        label: other?.label ?? l.target,
        relation: l.relation ?? "related",
        direction: "out",
        confidence: l.confidence ?? "EXTRACTED",
        sourceFile: other?.source_file ?? null,
      });
    } else if (l.target === id && l.source) {
      const other = byId.get(l.source);
      out.push({
        id: l.source,
        label: other?.label ?? l.source,
        relation: l.relation ?? "related",
        direction: "in",
        confidence: l.confidence ?? "EXTRACTED",
        sourceFile: other?.source_file ?? null,
      });
    }
  }
  return { node: resolved.node, neighbors: out.slice(0, limit) };
}

export interface PathHop {
  id: string;
  label: string;
  relation?: string;
  confidence?: string;
}

export function shortestPath(
  graphPath: string,
  fromQueryOrId: string,
  toQueryOrId: string,
): PathHop[] | null {
  const data = loadRaw(graphPath);
  if (!data) return null;
  const from = resolveNode(graphPath, fromQueryOrId);
  const to = resolveNode(graphPath, toQueryOrId);
  if (!from || !to) return null;
  if (from.node.id === to.node.id) {
    return [{ id: from.node.id, label: from.node.label ?? from.node.id }];
  }

  // Undirected BFS. Neighbour map keyed by node id; value is list of
  // {other, relation, confidence} tuples so we can reconstruct edges.
  const adj = new Map<
    string,
    Array<{ other: string; relation: string; confidence: string }>
  >();
  const push = (a: string, b: string, rel: string, conf: string) => {
    const cur = adj.get(a) ?? [];
    cur.push({ other: b, relation: rel, confidence: conf });
    adj.set(a, cur);
  };
  for (const l of data.links) {
    if (typeof l.source !== "string" || typeof l.target !== "string") continue;
    const rel = l.relation ?? "related";
    const conf = l.confidence ?? "EXTRACTED";
    push(l.source, l.target, rel, conf);
    push(l.target, l.source, rel, conf);
  }

  const byId = new Map<string, GraphNode>();
  for (const n of data.nodes) byId.set(n.id, n);

  const parent = new Map<string, { prev: string; relation: string; confidence: string }>();
  const visited = new Set<string>([from.node.id]);
  const queue: string[] = [from.node.id];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to.node.id) break;
    for (const n of adj.get(cur) ?? []) {
      if (visited.has(n.other)) continue;
      visited.add(n.other);
      parent.set(n.other, { prev: cur, relation: n.relation, confidence: n.confidence });
      queue.push(n.other);
    }
  }
  if (!parent.has(to.node.id)) return null;

  const reversed: PathHop[] = [
    { id: to.node.id, label: byId.get(to.node.id)?.label ?? to.node.id },
  ];
  let cursor = to.node.id;
  while (cursor !== from.node.id) {
    const p = parent.get(cursor);
    if (!p) break;
    reversed.push({
      id: p.prev,
      label: byId.get(p.prev)?.label ?? p.prev,
      relation: p.relation,
      confidence: p.confidence,
    });
    cursor = p.prev;
  }
  return reversed.reverse();
}

export function searchGraph(graphPath: string, query: string, limit = 20): SearchHit[] {
  const data = loadRaw(graphPath);
  if (!data) return [];
  const degree = computeDegrees(data.links);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  for (const n of data.nodes) {
    const label = (n.label ?? n.id).toLowerCase();
    const score = terms.reduce((acc, t) => acc + (label.includes(t) ? 1 : 0), 0);
    if (score === 0) continue;
    hits.push({
      id: n.id,
      label: n.label ?? n.id,
      sourceFile: n.source_file ?? null,
      degree: degree.get(n.id) ?? 0,
      community: typeof n.community === "number" ? n.community : null,
    });
  }
  return hits
    .sort((a, b) => b.degree - a.degree)
    .slice(0, limit);
}
