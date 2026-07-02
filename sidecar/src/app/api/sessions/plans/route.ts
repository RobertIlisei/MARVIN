import { readPlanState, writePlanState } from "@marvin/runtime/plan-state";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADR-0052 — durable per-session plan state.
 *
 * GET  /api/sessions/plans?projectId=…&sessionId=…  → { state } (null = none)
 * PUT  /api/sessions/plans?projectId=…&sessionId=…  body = the client's plan
 *      spine JSON, stored verbatim (server enforces id hygiene + size cap).
 *
 * The client saves on every plan mutation (debounced) and loads on hydrate,
 * replacing the pre-ADR-0052 transcript-scrape reconstruction whose 200-event
 * tail (ADR-0048) silently dropped long-running plans.
 */

function ids(req: NextRequest): { projectId: string; sessionId: string } | null {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim() ?? "";
  if (!projectId || !sessionId) return null;
  return { projectId, sessionId };
}

export async function GET(req: NextRequest) {
  const q = ids(req);
  if (!q) {
    return NextResponse.json({ error: "projectId and sessionId are required" }, { status: 400 });
  }
  const result = readPlanState(q.projectId, q.sessionId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ state: result.state });
}

export async function PUT(req: NextRequest) {
  const q = ids(req);
  if (!q) {
    return NextResponse.json({ error: "projectId and sessionId are required" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const result = writePlanState(q.projectId, q.sessionId, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
