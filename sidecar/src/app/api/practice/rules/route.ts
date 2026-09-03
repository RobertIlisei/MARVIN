/**
 * POST /api/practice/rules { projectId, id, tier?, status?, message?, global? } → { ok, rule, view }
 * POST /api/practice/rules { projectId, adopt: <ruleId> }                      → { ok, rule, view }
 *   Cold start: copy a rule confirmed in another project into this one.
 *
 * Edit an accepted rule (ADR-0105 §6): change its tier (restarts
 * verification), retire it, reword it, or promote it to global.
 */

import { type NextRequest, NextResponse } from "next/server";
import { adoptRule, practiceView, updateRule, type RuleStatus, type RuleTier } from "@marvin/runtime/practice";
import { requireMarvinClient } from "@/lib/csrf";
import { projectIdFrom } from "@/lib/practice-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIERS: readonly RuleTier[] = ["prompt", "nudge", "deny"];
const STATUSES: readonly RuleStatus[] = ["active", "retired"];

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { projectId?: string; id?: string; adopt?: string; tier?: string; status?: string; message?: string; global?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const projectId = projectIdFrom(req, body);
  if (!projectId) return NextResponse.json({ error: "unknown or missing projectId" }, { status: 400 });
  if (typeof body.adopt === "string" && body.adopt.trim()) {
    const res = adoptRule(projectId, body.adopt.trim());
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 409 });
    return NextResponse.json({ ok: true, rule: res.rule, view: practiceView(projectId) });
  }
  const id = body.id?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const rule = updateRule(id, {
    ...(TIERS.includes(body.tier as RuleTier) ? { tier: body.tier as RuleTier } : {}),
    ...(STATUSES.includes(body.status as RuleStatus) ? { status: body.status as RuleStatus } : {}),
    ...(typeof body.message === "string" ? { message: body.message } : {}),
    ...(typeof body.global === "boolean" ? { global: body.global } : {}),
  });
  if (!rule) return NextResponse.json({ ok: false, error: "unknown rule" }, { status: 404 });
  return NextResponse.json({ ok: true, rule, view: practiceView(projectId) });
}
