/**
 * POST /api/practice/run { projectId, force? } → { run: RunRecord, view }
 *
 * "Run now" (ADR-0105). `force` ignores the watermarks and re-reads every
 * transcript — the backtest.
 */

import { type NextRequest, NextResponse } from "next/server";
import { practiceView, runPractice } from "@marvin/runtime/practice";
import { requireMarvinClient } from "@/lib/csrf";
import { projectIdFrom } from "@/lib/practice-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectId?: string; force?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine — projectId may be a query param */
  }
  const projectId = projectIdFrom(req, body);
  if (!projectId) return NextResponse.json({ error: "unknown or missing projectId" }, { status: 400 });
  try {
    const run = runPractice(projectId, { force: body.force === true, trigger: body.force ? "backtest" : "manual" });
    return NextResponse.json({ run, view: practiceView(projectId) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
