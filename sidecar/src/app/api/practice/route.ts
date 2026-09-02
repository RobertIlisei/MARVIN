/**
 * GET  /api/practice?projectId=…   → PracticeView (config, findings, rules, runs)
 * POST /api/practice  { config: Partial<PracticeConfig> } → { config }
 *
 * The practice loop's read model and its settings (ADR-0105). Every verb the
 * pane has lives under /api/practice/*: run, findings, rules. Mutations are
 * CSRF-guarded like the backlog routes.
 */

import { type NextRequest, NextResponse } from "next/server";
import { practiceView, readPracticeConfig, writePracticeConfig, type PracticeConfig } from "@marvin/runtime/practice";
import { requireMarvinClient } from "@/lib/csrf";
import { projectIdFrom } from "@/lib/practice-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const projectId = projectIdFrom(req);
  if (!projectId) return NextResponse.json({ error: "unknown or missing projectId" }, { status: 400 });
  return NextResponse.json(practiceView(projectId), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { config?: Partial<PracticeConfig> };
  try {
    body = (await req.json()) as { config?: Partial<PracticeConfig> };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.config || typeof body.config !== "object") {
    return NextResponse.json({ config: readPracticeConfig() });
  }
  const allowed: Partial<PracticeConfig> = {};
  if (typeof body.config.enabled === "boolean") allowed.enabled = body.config.enabled;
  if (typeof body.config.hour === "number") allowed.hour = body.config.hour;
  if (body.config.weights) allowed.weights = body.config.weights;
  if (body.config.thresholds) allowed.thresholds = body.config.thresholds;
  if (body.config.costScale) allowed.costScale = body.config.costScale;
  if (typeof body.config.verifyWindow === "number") allowed.verifyWindow = Math.max(1, body.config.verifyWindow);
  return NextResponse.json({ config: writePracticeConfig(allowed) });
}
