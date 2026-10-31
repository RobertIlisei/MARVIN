import { describeRoleModels, readRoleModels, ROLE_NAMES, type Role, setRoleModel, validateRoleModels, writeRoleModels } from "@marvin/runtime/role-models";
import { noteSupervisorModelChange } from "@marvin/runtime/supervisor-state";
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
  let body: { role?: unknown; model?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.role !== "string" || !(ROLE_NAMES as string[]).includes(body.role)) {
    return NextResponse.json({ error: "role must be a known helper role" }, { status: 400 });
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
