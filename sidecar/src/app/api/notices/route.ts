/**
 * Project notices (ADR-0131) — the user's side of the store.
 *
 * - GET    /api/notices?projectId=…                  → { notices } (live ones, oldest first)
 * - POST   /api/notices { projectId, text, ttlHours? } → { notice }   ("Tell every tab…")
 * - DELETE /api/notices?projectId=…&id=…             → { ok }         (retire)
 *
 * User-only. Like every supervisor route it needs the per-boot capability
 * token (a tab never holds it: the supervisor data directory is off limits to
 * it) and, on a write, the MARVIN client header; and `/api/notices` is one of
 * the control paths `supervisorBoundaryDenial` refuses a tab (ADR-0127 §5), so
 * a tab's shell cannot reach it either. A notice reaches every tab's next
 * turn, so a secret-shaped string is refused here as in `send`.
 */

import { addNotice, readNotices, retireNotice } from "@marvin/runtime/notices";
import { getProject } from "@marvin/runtime/projects";
import { containsSecretShape } from "@marvin/runtime/session";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_REFUSAL = { error: "notice routes need the per-boot capability token (ADR-0131)" };
const MAX_BODY_BYTES = 8 * 1024;

function workDirOf(projectId: string): string | null {
  return projectId ? (getProject(projectId)?.workDir ?? null) : null;
}

export async function GET(req: NextRequest) {
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const workDir = workDirOf(req.nextUrl.searchParams.get("projectId")?.trim() ?? "");
  if (!workDir) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  return NextResponse.json({ notices: readNotices(workDir) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; text?: unknown; ttlHours?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const workDir = workDirOf(typeof body.projectId === "string" ? body.projectId.trim() : "");
  if (!workDir) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  if (typeof body.text === "string" && containsSecretShape(body.text)) {
    return NextResponse.json({ error: "the notice carries a secret-shaped string — it was not posted" }, { status: 400 });
  }
  const r = addNotice(workDir, { text: body.text, author: "user", ttlHours: body.ttlHours });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.code === "full" ? 409 : 400 });
  return NextResponse.json({ notice: r.notice });
}

export async function DELETE(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const workDir = workDirOf(req.nextUrl.searchParams.get("projectId")?.trim() ?? "");
  if (!workDir) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  const id = req.nextUrl.searchParams.get("id")?.trim() ?? "";
  if (!id || !retireNotice(workDir, id)) return NextResponse.json({ error: `no live notice "${id}"` }, { status: 404 });
  return NextResponse.json({ ok: true });
}
