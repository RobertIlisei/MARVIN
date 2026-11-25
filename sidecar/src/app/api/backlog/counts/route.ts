/**
 * GET /api/backlog/counts?workDir=…  → { workDir, revision, counts }
 *
 * The project's backlog counts by status (provisional / open / doing / done /
 * dismissed / blocked, and `active`, the number the chat's strip shows), from
 * the incremental counter — not a parse of every item. The app's one backlog
 * store normally learns of changes from `backlog.changed` on
 * `/api/chat/announce`; this is its re-read for the moments the stream cannot
 * be trusted (the window coming back to the front, a reconnect).
 *
 * Read-only; `workDir` must be a registered project (like `/api/backlog`).
 */

import { getBacklogLive } from "@marvin/runtime/backlog-live";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const v = validateProjectCwd(req.nextUrl.searchParams.get("workDir"));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
  const snap = await getBacklogLive().snapshot(v.workDir);
  return NextResponse.json(
    { workDir: v.workDir, revision: snap.revision, counts: snap.counts },
    { headers: { "Cache-Control": "no-store" } },
  );
}
