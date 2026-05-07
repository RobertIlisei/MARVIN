import { loadSession } from "@marvin/runtime/session";
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
  // `tail` cap: when present, return only the last N turns. autoHydrate
  // on the native client passes tail=200 so cold-start doesn't ship a
  // 100+ MB JSON over loopback for projects with long-running sessions
  // (the 314-turn / 123 MB JSONL in the field was the trigger). When
  // omitted the full transcript is returned — selectSession from the
  // history menu intentionally pays that cost since the user asked.
  const tailParam = req.nextUrl.searchParams.get("tail");
  const tail = tailParam ? Math.max(1, Number.parseInt(tailParam, 10)) : undefined;
  const record = loadSession(projectId, sessionId);
  if (!record) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const out =
    tail !== undefined && Number.isFinite(tail) && record.turns.length > tail
      ? { ...record, turns: record.turns.slice(-tail) }
      : record;
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}
