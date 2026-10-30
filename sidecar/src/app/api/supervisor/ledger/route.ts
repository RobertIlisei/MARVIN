/**
 * GET /api/supervisor/ledger?projectId=…&before=<seq>&limit=50&sessionId=&decision=
 *   → { entries, hasMore, nextBefore, todayCount }
 *
 * ADR-0127 §6 — the supervisor's append-only ledger, as the design brief's
 * §10.5 reads it (plan milestone 5): the newest page, oldest first inside it;
 * `before` pages backwards by `seq`. Each entry carries `seq`, `actor`
 * (supervisor / user / runtime), `sessionId` and the `tabTitle` snapshotted
 * when it was written, `argDigest`, a server-built `argSummary`,
 * `reason {code, text}` (`code: "unspecified"` on lines from before milestone
 * 3), full grounds, the shadow `pairing`, and the `inboxItemId` it raised.
 * `tab` is accepted for `sessionId` (milestone 1's name). Token-gated: the
 * ledger names tabs and quotes reasons.
 */

import { getProject } from "@marvin/runtime/projects";
import { isSafeProjectId, readLedger } from "@marvin/runtime/supervisor-ledger";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { groundViewContextFor, projectLedger } from "@marvin/runtime/supervisor-view";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DECISIONS = new Set(["propose", "act", "escalate", "refuse", "drop"]);

export async function GET(req: NextRequest) {
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json({ error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" }, { status: 403 });
  }
  const params = req.nextUrl.searchParams;
  const projectId = params.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const sessionId = (params.get("sessionId") ?? params.get("tab"))?.trim() || undefined;
  const decision = params.get("decision")?.trim() || undefined;
  if (decision && !DECISIONS.has(decision)) return NextResponse.json({ error: "decision must be propose, act, escalate, refuse or drop" }, { status: 400 });
  const n = Number(params.get("limit") ?? "50");
  const limit = Number.isFinite(n) ? Math.min(Math.max(1, Math.trunc(n)), 500) : 50;
  const b = params.get("before");
  const before = b !== null && b !== "" && Number.isFinite(Number(b)) ? Math.max(0, Math.trunc(Number(b))) : undefined;
  const workDir = getProject(projectId)?.workDir ?? "";
  const page = projectLedger(projectId, readLedger(projectId), { before, limit, sessionId, decision, groundCtx: groundViewContextFor(projectId, workDir) });
  return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
}
