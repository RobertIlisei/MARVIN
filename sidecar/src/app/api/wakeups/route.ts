/**
 * GET    /api/wakeups?projectId=…&sessionId=…  → { wakeups: WakeupSummary[] }
 * DELETE /api/wakeups?id=…&projectId=…         → { ok } (cancel a pending wakeup)
 *
 * The first HTTP surface for the ADR-0031 scheduler — until 2026-07-03
 * `listWakeups` / `cancelWakeup` were reachable only through the model's
 * `marvin-control` MCP tools, so no UI could show or cancel scheduled
 * work (the frontend-vs-backend audit's parity gap). Feeds the native
 * Activity popover.
 *
 * The summary deliberately OMITS the record's `prompt` (the full
 * injected turn text — noisy and potentially sensitive in a list) and
 * the model/permission plumbing fields; `reason` is the human string.
 * Only pending timed wakeups appear — event-driven completions
 * (background jobs) never enter the persisted set.
 */

import { type NextRequest, NextResponse } from "next/server";
import { cancelWakeup, listWakeups } from "@marvin/runtime/wakeup-scheduler";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() || undefined;
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim() || undefined;
  const wakeups = listWakeups({
    ...(projectId ? { projectId } : {}),
    ...(sessionId ? { marvinSessionId: sessionId } : {}),
  }).map((w) => ({
    id: w.id,
    projectId: w.projectId,
    marvinSessionId: w.marvinSessionId,
    reason: w.reason,
    createdAt: w.createdAt,
    fireAt: w.fireAt,
    deferrals: w.deferrals ?? 0,
  }));
  return NextResponse.json({ wakeups }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  const id = req.nextUrl.searchParams.get("id")?.trim();
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() || undefined;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const ok = cancelWakeup(id, projectId);
  if (!ok) return NextResponse.json({ error: `no wakeup "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true });
}
