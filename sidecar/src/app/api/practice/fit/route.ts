/**
 * POST /api/practice/fit { projectIds?: string[], apply?: boolean } → { fit, config? }
 *
 * Phase 5 (ADR-0105): fit the five score weights from every ledger's own
 * outcomes. Dry by default; `apply: true` writes them (the pane's Apply).
 */

import { type NextRequest, NextResponse } from "next/server";
import { applyFittedWeights, fitPracticeWeights } from "@marvin/runtime/practice-fit";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectIds?: unknown; apply?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const projectIds = Array.isArray(body.projectIds)
    ? body.projectIds.filter((x): x is string => typeof x === "string")
    : undefined;
  try {
    const fit = fitPracticeWeights(projectIds);
    if (body.apply === true) return NextResponse.json({ fit, config: applyFittedWeights(fit) });
    return NextResponse.json({ fit });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
