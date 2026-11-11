/**
 * The approved queue (ADR-0133) — the user's side.
 *
 * - GET  /api/supervisor/queue?projectId=…
 *     → { cap, effectiveCap, capLowered, guard, guardLast, entries }  order, the cap,
 *       each hold with its reason, each brief's first lines.
 * - POST /api/supervisor/queue { projectId, action, … }
 *     action `cap` { cap }            the user's number (0–20, default 1)
 *     action `restore-cap`            undo the supervisor's lowering
 *     action `release` { id }         lift a hold, or retry a failed entry
 *     action `remove` { id }          take an entry out of the queue
 *     action `propose-guard` { command }  raise the card that shows the command in full;
 *                                     the user's click on THAT card sets it
 *
 * Entries are approved only by the user's click on a queue card
 * (`POST /api/supervisor/inbox`), never here. Token-gated like every supervisor
 * route, POST also CSRF-guarded, and under `/api/supervisor` — a control path
 * `supervisorBoundaryDenial` refuses a tab (ADR-0127 §5).
 */

import { getProject } from "@marvin/runtime/projects";
import { addInboxItem, buildRawAct } from "@marvin/runtime/supervisor-inbox";
import { digestArgs, isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { guardCommandError, queueView, readQueue, releaseEntry, removeEntry, restoreCap, setUserCap } from "@marvin/runtime/supervisor-queue";
import { ensureQueueOpener } from "@marvin/runtime/supervisor-queue-opener";
import { getSupervisorState, SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

export async function GET(req: NextRequest) {
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  return NextResponse.json(queueView(projectId), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; action?: unknown; cap?: unknown; id?: unknown; command?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  if (!getProject(projectId)) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  // The opener hears the changes below (and an approval from the inbox route) on the project event stream.
  ensureQueueOpener();
  const id = typeof body.id === "string" ? body.id.trim() : "";
  switch (body.action) {
    case "cap": {
      const r = setUserCap(projectId, body.cap);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      break;
    }
    case "restore-cap": {
      const r = restoreCap(projectId);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
      break;
    }
    case "release":
      if (!id || !releaseEntry(projectId, id)) return NextResponse.json({ error: `no held or failed entry "${id}"` }, { status: 404 });
      break;
    case "remove":
      if (!id || !removeEntry(projectId, id)) return NextResponse.json({ error: `no entry "${id}" that can be removed` }, { status: 404 });
      break;
    case "propose-guard": {
      const err = guardCommandError(body.command);
      if (err) return NextResponse.json({ error: err }, { status: 400 });
      const command = (body.command as string).trim();
      const previous = readQueue(projectId).guard?.command ?? null;
      if (previous === command) return NextResponse.json({ error: "that command is already the approved guard" }, { status: 409 });
      const st = getSupervisorState(projectId);
      const item = addInboxItem(projectId, {
        sessionId: null,
        kind: "queue",
        escalatedBecause: { code: "human-only", label: "A command the runtime executes is the user's to set", rule: "ADR-0133 decision 1" },
        rawAct: buildRawAct("propose_guard", { command }),
        queue: { kind: "guard", command, previous },
        recommendation: { actionId: "approve", text: "You wrote this command; approve it here to set it." },
        grounds: [],
        act: { type: "queue", what: "guard" },
        dedupeKey: `queue-guard:${digestArgs({ command, previous, at: Date.now() })}`,
        modeAtCreation: st.mode === "autonomous" ? "autonomous" : "shadow",
      });
      return NextResponse.json({ ok: true, itemId: item.id });
    }
    default:
      return NextResponse.json({ error: "action must be cap, restore-cap, release, remove or propose-guard" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, queue: queueView(projectId) });
}
