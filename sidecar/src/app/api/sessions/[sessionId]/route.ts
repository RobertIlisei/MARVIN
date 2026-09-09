import { loadSession, loadSessionTail } from "@marvin/runtime/session";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/sessions/[sessionId]?projectId=… → SessionRecord | 404 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  // `tail` cap: when present, return only the last N turns. Every routine
  // hydrate passes one — cold start and, since 2026-09-09, the tab-strip
  // click too — so a 100+ MB JSON never crosses loopback for a project with
  // long-running sessions (the 314-turn / 123 MB JSONL in the field was the
  // trigger). Omitting it returns the full transcript, which is now only the
  // explicit "load the whole log" control.
  //
  // A tail request takes `loadSessionTail`, which parses ONLY the lines it
  // returns. The old path parsed all 36,356 lines and then sliced, spending
  // 528 ms to produce 105 ms of answer.
  const tailParam = req.nextUrl.searchParams.get("tail");
  const tail = tailParam ? Math.max(1, Number.parseInt(tailParam, 10)) : undefined;

  if (tail !== undefined && Number.isFinite(tail)) {
    const tailed = loadSessionTail(projectId, sessionId, tail);
    if (!tailed) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json(
      { ...tailed.record, truncated: tailed.truncated, totalTurns: tailed.totalTurns },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const record = loadSession(projectId, sessionId);
  if (!record) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  // Report the true total so the client can tell a complete log from a
  // clipped one (ADR-0048).
  return NextResponse.json(
    { ...record, truncated: false, totalTurns: record.turns.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
