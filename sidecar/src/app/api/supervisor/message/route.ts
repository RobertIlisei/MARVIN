/**
 * The user's conversation with the supervisor (ADR-0127 §2, plan milestone 5).
 *
 * - POST /api/supervisor/message { projectId, text } → { id, at }
 *     Records the message and wakes the supervisor with it. It CANNOT grant
 *     consent: telling the supervisor "approve X" here resolves nothing — at
 *     most the supervisor escalates X, and the user consents on the raw act in
 *     the inbox (§5). It is the one request `new_session` accepts: the
 *     supervisor cites this message's id, and one message opens at most one tab.
 * - GET  /api/supervisor/message?projectId=… → { messages } (the last 100, oldest first)
 *
 * Token-gated and CSRF-guarded like every supervisor route.
 */

import { containsSecretShape } from "@marvin/runtime/session";
import { appendLedgerEntry, isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { ensureSupervisorLoop } from "@marvin/runtime/supervisor-loop";
import { addUserMessage, listMessages, MAX_USER_MESSAGE_CHARS } from "@marvin/runtime/supervisor-messages";
import { getSupervisorState, SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

export async function GET(req: NextRequest) {
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  return NextResponse.json({ messages: listMessages(projectId, { limit: 100 }) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; text?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_USER_MESSAGE_CHARS) return NextResponse.json({ error: `text must be 1–${MAX_USER_MESSAGE_CHARS} characters` }, { status: 400 });
  // It reaches a model and a file on disk; a pasted key should do neither (ADR-0127 §6).
  if (containsSecretShape(text)) return NextResponse.json({ error: "the message carries a secret-shaped string — it was not sent" }, { status: 400 });
  if (getSupervisorState(projectId).mode === "off") return NextResponse.json({ error: "the supervisor is off — start it first" }, { status: 409 });
  const loop = ensureSupervisorLoop();
  const m = addUserMessage(projectId, text);
  appendLedgerEntry(projectId, { kind: "message", verb: "message", tab: null, wakeId: null, reason: "user: wrote to the supervisor", reasonCode: "user-message", argSummary: `message ${m.id}` });
  loop.noteUserMessage(projectId, m.id);
  return NextResponse.json({ id: m.id, at: m.at });
}
