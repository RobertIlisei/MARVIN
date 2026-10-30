/**
 * Supervisor control API (ADR-0127, milestone 1).
 *
 * - GET  /api/supervisor?projectId=…  → { state }
 * - POST /api/supervisor  { projectId, action, … } → { state }
 *     action: start | stop | pause | resume | kill | mode (off|shadow) |
 *             delegate { marvinSessionId, level } | charter { text }
 *
 * Every call needs the per-boot capability token in `x-marvin-supervisor-token`
 * (read from `<MARVIN_DATA_DIR>/supervisor/token`) — GET too, because the state
 * names the tabs and the charter. POST is also CSRF-guarded like every
 * mutating route. A tab's model cannot reach this route: the gate denies a tab
 * tool call that names MARVIN's control API (ADR-0127 §5).
 */

import { ensureSupervisorLoop } from "@marvin/runtime/supervisor-loop";
import {
  applySupervisorAction,
  getSupervisorState,
  SUPERVISOR_TOKEN_HEADER,
  verifySupervisorToken,
} from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

export async function GET(req: NextRequest) {
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  ensureSupervisorLoop();
  return NextResponse.json({ state: getSupervisorState(projectId) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const result = applySupervisorAction(body, req.headers.get(SUPERVISOR_TOKEN_HEADER));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  ensureSupervisorLoop();
  return NextResponse.json({ state: result.state });
}
