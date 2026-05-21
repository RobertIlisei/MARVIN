import {
  type GraphScope,
  graphPathForScope,
  searchGraph,
  summarizeGraph,
} from "@marvin/graphify-bridge";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/graph/query?cwd=…                  → code-graph summary
 * GET /api/graph/query?cwd=…&q=Term           → search hits + summary (code)
 * GET /api/graph/query?cwd=…&scope=knowledge  → knowledge-graph variant
 * POST /api/graph/query { cwd, q?, limit?, scope? } — body variant for longer cwds.
 *
 * scope defaults to "code" for backwards compat (ADR-0028).
 */
function parseScope(raw: string | null | undefined): GraphScope {
  return raw === "knowledge" ? "knowledge" : "code";
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd")?.trim();
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "20");
  const scope = parseScope(req.nextUrl.searchParams.get("scope"));
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  return answer(cwd, q ?? null, Number.isFinite(limit) ? limit : 20, scope);
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { cwd?: string; q?: string; limit?: number; scope?: string };
  try {
    body = (await req.json()) as { cwd?: string; q?: string; limit?: number; scope?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cwd = body.cwd?.trim();
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  return answer(cwd, body.q?.trim() ?? null, Number(body.limit ?? 20), parseScope(body.scope));
}

function answer(cwd: string, q: string | null, limit: number, scope: GraphScope) {
  const graphPath = graphPathForScope(cwd, scope);
  const summary = summarizeGraph(graphPath);
  if (!q) {
    return NextResponse.json({ scope, summary });
  }
  const hits = searchGraph(graphPath, q, Number.isFinite(limit) ? limit : 20);
  return NextResponse.json({ scope, summary, query: q, hits });
}
