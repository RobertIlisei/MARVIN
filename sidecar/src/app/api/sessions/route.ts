import { listSessionSummaries } from "@marvin/runtime/session";
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

  // Previously this called `loadSession` per entry — a full JSON.parse of
  // every line of every transcript, just to read two summary fields. On a
  // 347-session / 2.6 GB project that measured 23 SECONDS, long enough that
  // the client cancelled and restarted the fetch (a SwiftUI rebuild re-fires
  // the tab strip's `.onAppear`) before it could ever return, leaving the
  // picker permanently empty AND — because autoHydrate gates on this list —
  // the chat blank. `listSessionSummaries` scans instead of parsing and
  // caches on (mtime, size). See ADR-0072.
  const summaries: SessionSummary[] = listSessionSummaries(projectId);

  return NextResponse.json(
    { projectId, sessions: summaries },
    { headers: { "Cache-Control": "no-store" } },
  );
}
