import { NextResponse, type NextRequest } from "next/server";

import { summarizeCost } from "@marvin/runtime/cost-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/cost?projectId=… → CostSummary */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() || undefined;
  const summary = summarizeCost(projectId ? { projectId } : {});
  return NextResponse.json(summary, {
    headers: { "Cache-Control": "no-store" },
  });
}
