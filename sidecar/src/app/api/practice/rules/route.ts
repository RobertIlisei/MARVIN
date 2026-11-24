/**
 * POST /api/practice/rules { projectId, id, tier?, status?, message?, global? } → { ok, rule, view }
 * POST /api/practice/rules { projectId, adopt: <ruleId> }                      → { ok, rule, view }
 *   Cold start: copy a rule confirmed in another project into this one.
 * POST /api/practice/rules { projectId, create: { skills, paths?, tier?, title?, message?, global? } } → { ok, rule, view }
 *   ADR-0138: a rule that asks for any skill on a commit, optionally only when
 *   the commit touches the given globs. The trigger is built server-side.
 *
 * Edit an accepted rule (ADR-0105 §6): change its tier (restarts
 * verification), retire it, reword it, or promote it to global.
 */

import { type NextRequest, NextResponse } from "next/server";
import { adoptRule, createSkillRule, practiceView, updateRule, type RuleStatus, type RuleTier } from "@marvin/runtime/practice";
import { requireMarvinClient } from "@/lib/csrf";
import { projectIdFrom } from "@/lib/practice-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIERS: readonly RuleTier[] = ["prompt", "nudge", "deny"];
const STATUSES: readonly RuleStatus[] = ["active", "retired"];

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: {
    projectId?: string;
    id?: string;
    adopt?: string;
    tier?: string;
    status?: string;
    message?: string;
    global?: boolean;
    create?: { skills?: string[]; paths?: string[]; tier?: string; title?: string; message?: string; global?: boolean };
  };
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
  if (body.create && typeof body.create === "object") {
    // ADR-0138 — a rule that asks for a skill on a commit, optionally on paths.
    const c = body.create;
    const res = createSkillRule(projectId, {
      skills: Array.isArray(c.skills) ? c.skills : [],
      ...(Array.isArray(c.paths) ? { paths: c.paths } : {}),
      ...(c.tier === "nudge" || c.tier === "deny" ? { tier: c.tier } : {}),
      ...(typeof c.title === "string" ? { title: c.title } : {}),
      ...(typeof c.message === "string" ? { message: c.message } : {}),
      ...(c.global === true ? { global: true } : {}),
    });
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
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
