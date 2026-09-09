/**
 * POST /api/sessions/resume { projectId, marvinSessionId, prompt? } → 202 { queued: true }
 *
 * ADR-0107 — pick up a turn a crash or restart cut off. The turn is
 * server-initiated through the wakeup path (`fireNow` → `startScheduledTurn`):
 * it yields to a live human turn, runs with the session's persisted posture
 * in the session's current tree, and announces itself on `/api/chat/announce`
 * so the client attaches exactly as it does to a scheduled wakeup. The
 * client never has to post a synthetic user message.
 */

import { getProject } from "@marvin/runtime/projects";
import { resumeSession } from "@marvin/runtime/session-recovery";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectId?: string; marvinSessionId?: string; prompt?: string };
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
  if (!getProject(projectId)) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim().slice(0, 4000) : undefined;
  const result = await resumeSession(projectId, sessionId, prompt ? { prompt } : {});
  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ queued: true }, { status: 202 });
}
