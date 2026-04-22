import { searchGraph, summarizeGraph } from "@marvin/graphify-bridge";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/graph/query?cwd=…            → summary of the project's graph
 * GET /api/graph/query?cwd=…&q=Term     → search hits + summary
 * POST /api/graph/query { cwd, q?, limit? } — body variant for longer cwds.
 */
export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd")?.trim();
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "20");
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  return answer(cwd, q ?? null, Number.isFinite(limit) ? limit : 20);
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { cwd?: string; q?: string; limit?: number };
  try {
    body = (await req.json()) as { cwd?: string; q?: string; limit?: number };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cwd = body.cwd?.trim();
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  return answer(cwd, body.q?.trim() ?? null, Number(body.limit ?? 20));
}

function answer(cwd: string, q: string | null, limit: number) {
  const summary = summarizeGraph(cwd);
  if (!q) {
    return NextResponse.json({ summary });
  }
  const hits = searchGraph(cwd, q, Number.isFinite(limit) ? limit : 20);
  return NextResponse.json({ summary, query: q, hits });
}
