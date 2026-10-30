/**
 * GET /api/supervisor/ledger?projectId=…&tab=…&limit=… → { entries }
 *
 * ADR-0127 §6 — the supervisor's append-only ledger, oldest first (`limit`
 * keeps the newest N, default 200, max 2000). Token-gated like every
 * supervisor route: the ledger names tabs and quotes reasons.
 */

import { isSafeProjectId, readLedger } from "@marvin/runtime/supervisor-ledger";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json({ error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" }, { status: 403 });
  }
  const params = req.nextUrl.searchParams;
  const projectId = params.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const tab = params.get("tab")?.trim() || undefined;
  const n = Number(params.get("limit") ?? "200");
  const limit = Number.isFinite(n) ? Math.min(Math.max(1, Math.trunc(n)), 2000) : 200;
  return NextResponse.json(
    { entries: readLedger(projectId, { limit, ...(tab ? { tab } : {}) }) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
