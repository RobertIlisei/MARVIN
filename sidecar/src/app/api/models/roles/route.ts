import { describeRoleModels, readRoleModels, ROLE_NAMES, type Role, setRoleModel, validateRoleModels, writeRoleModels } from "@marvin/runtime/role-models";
import { isEffortRole, isEffortRung, readRoleEfforts, setRoleEffort } from "@marvin/runtime/role-efforts";
import { noteSupervisorEffortChange, noteSupervisorModelChange } from "@marvin/runtime/supervisor-state";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The supervisor role's stored choice moved: tell every enabled supervisor so its status refetches. */
function announceSupervisorChange(before: string | null, after: string | null) {
  if (before !== after) noteSupervisorModelChange(after);
}

/**
 * GET /api/models/roles — every helper role (ADR-0126) with its stored
 * choice and what it resolves to against the active provider right now.
 *
 * PUT /api/models/roles — `{ roles: { <role>: <model id> | "off" | null } }`.
 * Replaces the whole map: a role left out (or null) goes back to its default.
 *
 * PATCH /api/models/roles — `{ role, model: <model id> | "off" | null }`.
 * Changes one role and leaves every other choice alone (the Supervisor
 * workspace's inline picker). Both writers tell the enabled supervisors when
 * the supervisor role's choice changed.
 *
 * PATCH /api/models/roles — `{ role: "supervisor", effort: low|medium|high|xhigh|max|null }`
 * sets the role's reasoning effort instead (role-efforts.json; null = Default).
 * One of `model` / `effort` per request. Like the model it is app-wide and the
 * user's click: no supervisor verb reaches it.
 */
export async function GET() {
  return NextResponse.json({ roles: await describeRoleModels() }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { roles?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const v = validateRoleModels(body.roles ?? {});
  if (!v.ok) return NextResponse.json({ error: v.errors.join("; ") }, { status: 400 });
  const before = readRoleModels().supervisor ?? null;
  writeRoleModels(v.roles);
  announceSupervisorChange(before, v.roles.supervisor ?? null);
  return NextResponse.json({ roles: await describeRoleModels() });
}

export async function PATCH(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: { role?: unknown; model?: unknown; effort?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.role !== "string" || !(ROLE_NAMES as string[]).includes(body.role)) {
    return NextResponse.json({ error: "role must be a known helper role" }, { status: 400 });
  }
  if ("effort" in body) {
    if ("model" in body) return NextResponse.json({ error: "set model or effort, not both" }, { status: 400 });
    if (!isEffortRole(body.role)) return NextResponse.json({ error: `${body.role} has no effort setting` }, { status: 400 });
    if (body.effort !== null && !isEffortRung(body.effort)) {
      return NextResponse.json({ error: "effort must be low, medium, high, xhigh, max or null" }, { status: 400 });
    }
    const beforeEffort = readRoleEfforts()[body.role] ?? null;
    const afterEffort = setRoleEffort(body.role, body.effort)[body.role] ?? null;
    if (beforeEffort !== afterEffort) noteSupervisorEffortChange(afterEffort);
    return NextResponse.json({ roles: await describeRoleModels() });
  }
  if (body.model !== null && typeof body.model !== "string") {
    return NextResponse.json({ error: "model must be a model id or null" }, { status: 400 });
  }
  const role = body.role as Role;
  const check = validateRoleModels({ [role]: body.model });
  if (!check.ok) return NextResponse.json({ error: check.errors.join("; ") }, { status: 400 });
  const before = readRoleModels().supervisor ?? null;
  const next = setRoleModel(role, body.model);
  if (role === "supervisor") announceSupervisorChange(before, next.supervisor ?? null);
  return NextResponse.json({ roles: await describeRoleModels() });
}
