import { listSessions, loadSession } from "@marvin/runtime/session";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionSummary {
  sessionId: string;
  updatedAt: string;
  bytes: number;
  firstUserMessage: string | null;
  turnCount: number;
}

/**
 * GET /api/sessions?projectId=… → { projectId, sessions: SessionSummary[] }
 *
 * Lists every transcript for the project, newest first, with a short preview
 * of the first user message so the picker can label them usefully.
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const base = listSessions(projectId);
  const summaries: SessionSummary[] = base.map((s) => {
    const record = loadSession(projectId, s.sessionId);
    let firstUserMessage: string | null = null;
    let turnCount = 0;
    if (record) {
      for (const t of record.turns) {
        if (t.type === "turn.user") turnCount += 1;
        if (t.type === "turn.user" && firstUserMessage === null) {
          firstUserMessage = t.message.slice(0, 120);
        }
      }
    }
    return {
      sessionId: s.sessionId,
      updatedAt: s.updatedAt,
      bytes: s.bytes,
      firstUserMessage,
      turnCount,
    };
  });

  return NextResponse.json(
    { projectId, sessions: summaries },
    { headers: { "Cache-Control": "no-store" } },
  );
}
