/**
 * GET /api/sessions/interrupted?projectId=… → { sessions: InterruptedSession[] }
 *
 * ADR-0107 — sessions whose last turn was cut off by a crash or restart and
 * is not running now. Marked at boot by `markInterruptedAtBoot`; this lists
 * them (including already-marked ones) for the "Resume" affordance.
 */

import { getProject } from "@marvin/runtime/projects";
import { findInterruptedSessions } from "@marvin/runtime/session-recovery";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  return NextResponse.json(
    { sessions: findInterruptedSessions(projectId, { includeMarked: true }) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
