/**
 * The supervisor's escalation inbox (ADR-0127 §4–§5, plan milestone 5,
 * design brief §10.2).
 *
 * - GET  /api/supervisor/inbox?projectId=…&state=open|resolved|dismissed|superseded|all
 *     → { items }  oldest first (default `open`). Each item shows the raw act
 *     (tool, full input, digest, a server-built summary), the supervisor's
 *     recommendation beside it, full grounds, and the actions it offers.
 *     An item whose confirm or question went away unanswered is expired here.
 * - POST /api/supervisor/inbox { projectId, id, actionId, edits? }
 *     → { ok, item, outcome } | { error, code? }
 *     The user's click on the raw act is the consent: the item's stored act is
 *     performed with the user's authority (`actor: "user"`). `edits` only for
 *     `new-tab` (first message, title, a NARROWER posture), a question's own
 *     answer, or a raised cap.
 *
 * Token-gated like every supervisor route (the items name tabs and quote
 * acts); POST is also CSRF-guarded. A tab's model cannot reach this route:
 * the gate denies a tab tool call that names MARVIN's control API (§5).
 */

import { getPendingConfirm } from "@marvin/runtime/confirm-registry";
import { getProject } from "@marvin/runtime/projects";
import { type InboxState, listInbox, projectInboxItem, resolveInboxForConfirm } from "@marvin/runtime/supervisor-inbox";
import { actOnInboxItem } from "@marvin/runtime/supervisor-inbox-actions";
import { defaultInboxPerform } from "@marvin/runtime/supervisor-inbox-perform";
import { isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { ensureSupervisorLoop } from "@marvin/runtime/supervisor-loop";
import { currentSupervisorToken, SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { groundViewContextFor } from "@marvin/runtime/supervisor-view";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };
const STATES = new Set(["open", "resolved", "dismissed", "superseded", "all"]);

/** An item whose confirm or question is no longer pending — answered, timed out, or its turn unwound — is not open any more. */
function expireStale(projectId: string): void {
  for (const i of listInbox(projectId, { state: "open" })) {
    const c = i.linkedConfirm;
    if (c && !getPendingConfirm(c.turnId, c.toolUseId)) resolveInboxForConfirm(projectId, { toolUseId: c.toolUseId });
  }
}

export async function GET(req: NextRequest) {
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const params = req.nextUrl.searchParams;
  const projectId = params.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const state = params.get("state")?.trim() || "open";
  if (!STATES.has(state)) return NextResponse.json({ error: "state must be open, resolved, dismissed, superseded or all" }, { status: 400 });
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  expireStale(projectId);
  const all = listInbox(projectId);
  const ctx = groundViewContextFor(projectId, project.workDir);
  const items = (state === "all" ? all : all.filter((i) => i.state === (state as InboxState))).map((i) => projectInboxItem(i, ctx, all));
  return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  const presented = req.headers.get(SUPERVISOR_TOKEN_HEADER);
  if (!verifySupervisorToken(presented)) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; id?: unknown; actionId?: unknown; edits?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const actionId = typeof body.actionId === "string" ? body.actionId.trim() : "";
  if (!id || id.length > 100 || !actionId || actionId.length > 40) return NextResponse.json({ error: "id and actionId are required" }, { status: 400 });
  if (body.edits !== undefined && (typeof body.edits !== "object" || body.edits === null || Array.isArray(body.edits))) {
    return NextResponse.json({ error: "edits must be an object" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  // The loop hears the confirm this may resolve (pairing, the other items about it).
  ensureSupervisorLoop();
  const r = await actOnInboxItem(projectId, { id, actionId, edits: body.edits as Record<string, unknown> | undefined }, defaultInboxPerform(projectId, project.workDir, currentSupervisorToken()));
  if (!r.ok) return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
  const all = listInbox(projectId);
  return NextResponse.json({ ok: true, item: projectInboxItem(r.item, groundViewContextFor(projectId, project.workDir), all), outcome: r.outcome });
}
