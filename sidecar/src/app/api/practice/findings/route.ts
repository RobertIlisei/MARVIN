/**
 * POST /api/practice/findings
 *   { projectId, id, action: "approve", tier?, message?, global? }
 *   { projectId, id, action: "dismiss", reason }
 *   { projectId, id, action: "escalate" }
 *   { projectId, id, action: "fixed", reason }   ← "I changed MARVIN's code"; verified like a rule
 * → { ok, rule?, view }
 *
 * The three verbs a finding has (ADR-0105 §6). Approve creates the rule from
 * the kind's template; dismiss suppresses until recurrence doubles; escalate
 * moves a regressed rule one tier up and restarts its verification.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  approveFinding,
  dismissFinding,
  escalateFinding,
  markFindingFixed,
  practiceView,
  type RuleTier,
} from "@marvin/runtime/practice";
import { requireMarvinClient } from "@/lib/csrf";
import { projectIdFrom } from "@/lib/practice-project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIERS: readonly RuleTier[] = ["prompt", "nudge", "deny"];

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: {
    projectId?: string;
    id?: string;
    action?: string;
    tier?: string;
    message?: string;
    global?: boolean;
    reason?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const projectId = projectIdFrom(req, body);
  if (!projectId) return NextResponse.json({ error: "unknown or missing projectId" }, { status: 400 });
  const id = body.id?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  switch (body.action) {
    case "approve": {
      const tier = TIERS.includes(body.tier as RuleTier) ? (body.tier as RuleTier) : undefined;
      const res = approveFinding(projectId, id, {
        ...(tier ? { tier } : {}),
        ...(typeof body.message === "string" ? { message: body.message } : {}),
        ...(typeof body.global === "boolean" ? { global: body.global } : {}),
      });
      if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 409 });
      return NextResponse.json({ ok: true, rule: res.rule, view: practiceView(projectId) });
    }
    case "dismiss": {
      const ok = dismissFinding(projectId, id, body.reason ?? "");
      if (!ok) return NextResponse.json({ ok: false, error: "unknown finding" }, { status: 404 });
      return NextResponse.json({ ok: true, view: practiceView(projectId) });
    }
    case "fixed": {
      const ok = markFindingFixed(projectId, id, body.reason ?? "");
      if (!ok) return NextResponse.json({ ok: false, error: "unknown or success finding" }, { status: 404 });
      return NextResponse.json({ ok: true, view: practiceView(projectId) });
    }
    case "escalate": {
      const res = escalateFinding(projectId, id);
      if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 409 });
      return NextResponse.json({ ok: true, rule: res.rule, view: practiceView(projectId) });
    }
    default:
      return NextResponse.json({ error: "action must be approve | dismiss | escalate | fixed" }, { status: 400 });
  }
}
