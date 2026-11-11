/**
 * POST /api/sessions/attention { projectId, marvinSessionId } — dismiss a
 * session's attention item (ADR-0130): the closing question or the chain-cap
 * refusal that marks a stopped tab `awaiting-you`.
 *
 * The user's act. It sits under `/api/sessions`, one of the control paths the
 * side-door rule keeps a tab's shell off (`supervisorBoundaryDenial`,
 * ADR-0127 §5), and takes no supervisor capability: the supervisor answers an
 * item by messaging the tab, never by dismissing it. Sending the tab a
 * message clears it too (any turn start does).
 */

import { readSessionMeta, updateSessionMeta } from "@marvin/runtime/session-meta";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectId?: unknown; marvinSessionId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const sessionId = typeof body.marvinSessionId === "string" ? body.marvinSessionId.trim() : "";
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId)) {
    return NextResponse.json({ error: "projectId and marvinSessionId are required" }, { status: 400 });
  }
  const meta = readSessionMeta(projectId, sessionId);
  if (!meta) return NextResponse.json({ error: "unknown session" }, { status: 404 });
  const had = !!meta.attention;
  if (had) updateSessionMeta(projectId, sessionId, { attention: undefined });
  return NextResponse.json({ ok: true, dismissed: had });
}
