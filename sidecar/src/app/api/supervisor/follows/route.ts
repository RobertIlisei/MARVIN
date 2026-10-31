/**
 * What the supervisor follows for the user (ADR-0128 §5, plan milestone [7.3]).
 *
 * - GET  /api/supervisor/follows?projectId=… → { follows } (open ones, and the
 *     last 20 ended, oldest first), each with its tab's title for the chip.
 * - POST /api/supervisor/follows { projectId, id, action: "stop" } → { follow }
 *     The *Stop following* chip: the user ends a follow. Ending is once; a
 *     second stop answers 409. Ledgered as the user's control line.
 *
 * A follow is a record, not authority, so stopping one needs no confirm.
 * Token-gated and CSRF-guarded like every supervisor route.
 */

import { readSessionMeta } from "@marvin/runtime/session-meta";
import { endFollow, getFollow, listFollows } from "@marvin/runtime/supervisor-follows";
import { appendLedgerEntry, isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

export async function GET(req: NextRequest) {
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const all = listFollows(projectId);
  const shown = [...all.filter((f) => f.state === "open"), ...all.filter((f) => f.state === "ended").slice(-20)];
  const follows = shown.map((f) => ({ ...f, tabTitle: readSessionMeta(projectId, f.sessionId)?.title ?? null }));
  return NextResponse.json({ follows }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; id?: unknown; action?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  if (body.action !== "stop") return NextResponse.json({ error: 'action must be "stop"' }, { status: 400 });
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const cur = id ? getFollow(projectId, id) : null;
  if (!cur) return NextResponse.json({ error: "no follow with that id" }, { status: 404 });
  const ended = endFollow(projectId, id, "user");
  if (!ended) return NextResponse.json({ error: "the follow has already ended" }, { status: 409 });
  appendLedgerEntry(projectId, { kind: "control", verb: "follow.stop", tab: cur.sessionId, wakeId: null, reason: "user: stopped following the tab", reasonCode: "follow-stop", argSummary: `follow ${id}` });
  return NextResponse.json({ follow: ended });
}
