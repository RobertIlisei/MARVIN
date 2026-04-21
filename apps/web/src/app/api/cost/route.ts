import { summarizeCost } from "@marvin/runtime/cost-tracker";
import { type NextRequest, NextResponse } from "next/server";

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
