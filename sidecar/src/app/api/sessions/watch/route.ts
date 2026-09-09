/**
 * GET /api/sessions/watch?projectId=…&ids=a,b,c → { projectId, rows, generatedAt }
 *
 * ADR-0107 — the cold-start snapshot for the multi-session watch UI: one row
 * per session with its live state, pending confirms, tree, diff badge, plan
 * progress and cost. Live changes after this ride `/api/chat/announce`.
 * Read-only; no CSRF guard (matches the other GET reads).
 */

import { getProject } from "@marvin/runtime/projects";
import { buildSessionWatch } from "@marvin/runtime/session-watch";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const projectId = params.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "unknown project" }, { status: 404 });
  }
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9._-]{1,128}$/.test(s))
    .slice(0, 50);
  const rows = buildSessionWatch({ projectId, workDir: project.workDir, sessionIds: ids });
  return NextResponse.json(
    { projectId, rows, generatedAt: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
