/**
 * POST /api/sessions/sync { projectId, marvinSessionId } → 202 { queued: true, branch, target }
 *
 * ADR-0111 — the session that owns a branch resolves its conflicts. One turn
 * is dispatched into the tab's own worktree through the resume path, with a
 * fixed instruction: merge the current branch of the main checkout into this
 * branch, resolve, test, commit — never push. Refused while the tab has a
 * turn in flight, when it has no worktree, or when the worktree is gone.
 */
import { syncWithTarget } from "@marvin/runtime/integration";
import { getProject } from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";

import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectId?: string; marvinSessionId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = body.projectId?.trim();
  const sessionId = body.marvinSessionId?.trim();
  if (!projectId || !sessionId || !SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId)) {
    return NextResponse.json({ error: "projectId and marvinSessionId are required" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  const result = await syncWithTarget(projectId, sessionId, project.workDir);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ queued: true, branch: result.branch, target: result.target }, { status: 202 });
}
