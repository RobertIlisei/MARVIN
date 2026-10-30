/**
 * GET /api/supervisor/stats?projectId=… → { stats, suggestedBar }
 *
 * ADR-0127 milestone 4 — shadow agreement per category (questions, nudges,
 * posture, confirms): `proposals`, `agreed`, `agreedBlind`, `agreementRate`,
 * `humanOnlyProposedAsAct`, `heuristicMisses`. Agreement counts only answers
 * the USER gave (the sheet, `/api/confirm`, `/api/confirm/answer`). The same
 * object rides `GET /api/supervisor`'s `status.stats`; this route is the cheap
 * read for the autonomy toggles. Token-gated.
 */

import { isSafeProjectId, readLedger } from "@marvin/runtime/supervisor-ledger";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { computeSupervisorStats, SUGGESTED_BAR } from "@marvin/runtime/supervisor-status";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json({ error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" }, { status: 403 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  return NextResponse.json(
    { stats: computeSupervisorStats(readLedger(projectId)), suggestedBar: SUGGESTED_BAR },
    { headers: { "Cache-Control": "no-store" } },
  );
}
