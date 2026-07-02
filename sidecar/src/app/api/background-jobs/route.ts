/**
 * GET    /api/background-jobs?sessionId=…  → { jobs: BackgroundJobSummary[] }
 * DELETE /api/background-jobs?id=…         → { ok } (cancel a running job)
 *
 * The first HTTP surface for ADR-0038 background jobs — until
 * 2026-07-03 `listBackgroundJobs` / `cancelBackgroundJob` were
 * reachable only through the model's MCP tools; the UI could learn a
 * job FINISHED (announce SSE) but never see or stop a running one.
 * Feeds the native Activity popover.
 *
 * Jobs are in-memory per sidecar process (they die with it); no
 * projectId scoping exists on the registry — sessionId is the only
 * filter. Cancelling marks the job `cancelled`, so its completion
 * wakeup is suppressed (stopped-by-user ≠ finished; no chat turn).
 */

import { type NextRequest, NextResponse } from "next/server";
import { cancelBackgroundJob, listBackgroundJobs } from "@marvin/runtime/background-jobs";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim() || undefined;
  return NextResponse.json(
    { jobs: listBackgroundJobs(sessionId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const ok = cancelBackgroundJob(id);
  if (!ok) return NextResponse.json({ error: `no background job "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true });
}
