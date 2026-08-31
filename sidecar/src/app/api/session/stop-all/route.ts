import {
  describeStopScope,
  previewStopAll,
  stopAll,
} from "@marvin/runtime/stop-all";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/session/stop-all?marvinSessionId=…&projectId=…
 *   → { turnRunning, jobs, wakeups, summary }
 *   What WOULD be stopped. The confirmation dialog names this, so the user
 *   is agreeing to a specific list rather than to the word "everything".
 *
 * POST /api/session/stop-all { marvinSessionId, projectId }
 *   → { turnCancelled, jobsCancelled, wakeupsCancelled, failed }
 *   Cancels the live turn, every background job, and every pending wakeup.
 *
 * Separate from `/api/chat/cancel`, which is turn-only and stays that way:
 * Stop means "stop talking", this means "stop everything you have running".
 */
export async function GET(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const marvinSessionId = req.nextUrl.searchParams
    .get("marvinSessionId")
    ?.trim();
  if (!marvinSessionId) {
    return NextResponse.json(
      { error: "marvinSessionId is required" },
      { status: 400 },
    );
  }
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  const scope = previewStopAll({ marvinSessionId, projectId: projectId || undefined });
  return NextResponse.json({ ...scope, summary: describeStopScope(scope) });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { marvinSessionId?: string; projectId?: string };
  try {
    body = (await req.json()) as { marvinSessionId?: string; projectId?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const marvinSessionId = body.marvinSessionId?.trim();
  if (!marvinSessionId) {
    return NextResponse.json(
      { error: "marvinSessionId is required" },
      { status: 400 },
    );
  }
  const result = stopAll({
    marvinSessionId,
    projectId: body.projectId?.trim() || undefined,
  });
  return NextResponse.json(result);
}
