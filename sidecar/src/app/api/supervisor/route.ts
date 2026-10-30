/**
 * Supervisor control API (ADR-0127, milestones 1 and 4).
 *
 * - GET  /api/supervisor?projectId=…  → { state, status }
 *     `status` is the design brief's §10.1 object (revision, mode, autonomy,
 *     run, pause, currentWake, queuedEvents, lastWake, health, watchedTabs,
 *     openEscalations, budget, charter, model, stats, suggestedBar,
 *     confirmsEligible, caps). `health` and `budget.level` are derived here.
 * - POST /api/supervisor  { projectId, action, … } → { state, status }
 *     action: start {charter?, capUsd?, delegations?: [{sessionId, level}]} |
 *             stop | disable | pause | resume | kill | wakeNow |
 *             mode (off|shadow) | delegate { marvinSessionId, level } |
 *             charter { text } | cap { capUsd } |
 *             autonomy { category: questions|nudges|posture|confirms, value: shadow|autonomous }
 *     `confirms` may leave shadow from milestone 5. `status.openEscalations`
 *     counts open inbox items (`/api/supervisor/inbox`).
 *
 * Every call needs the per-boot capability token in `x-marvin-supervisor-token`
 * (read from `<MARVIN_DATA_DIR>/supervisor/token`) — GET too, because the state
 * names the tabs and the charter. POST is also CSRF-guarded like every
 * mutating route. A tab's model cannot reach this route: the gate denies a tab
 * tool call that names MARVIN's control API (ADR-0127 §5).
 */

import { openEscalationCounts } from "@marvin/runtime/supervisor-inbox";
import { readLedger } from "@marvin/runtime/supervisor-ledger";
import { ensureSupervisorLoop } from "@marvin/runtime/supervisor-loop";
import {
  applySupervisorAction,
  getSupervisorState,
  SUPERVISOR_TOKEN_HEADER,
  type SupervisorState,
  verifySupervisorToken,
} from "@marvin/runtime/supervisor-state";
import { buildSupervisorStatus, supervisorModelInfo } from "@marvin/runtime/supervisor-status";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

async function statusOf(state: SupervisorState) {
  const loop = ensureSupervisorLoop();
  return buildSupervisorStatus(state, loop.snapshot(state.projectId), readLedger(state.projectId), await supervisorModelInfo(), Date.now(), openEscalationCounts(state.projectId).total);
}

export async function GET(req: NextRequest) {
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const state = getSupervisorState(projectId);
  return NextResponse.json({ state, status: await statusOf(state) }, { headers: { "Cache-Control": "no-store" } });
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
  // The loop subscribes before the action fires, so `wakeNow` and `resume` reach it.
  ensureSupervisorLoop();
  const result = applySupervisorAction(body, req.headers.get(SUPERVISOR_TOKEN_HEADER));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ state: result.state, status: await statusOf(result.state) });
}
