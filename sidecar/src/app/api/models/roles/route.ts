import { describeRoleModels, validateRoleModels, writeRoleModels } from "@marvin/runtime/role-models";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models/roles — every helper role (ADR-0126) with its stored
 * choice and what it resolves to against the active provider right now.
 *
 * PUT /api/models/roles — `{ roles: { <role>: <model id> | "off" | null } }`.
 * Replaces the whole map: a role left out (or null) goes back to its default.
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
  writeRoleModels(v.roles);
  return NextResponse.json({ roles: await describeRoleModels() });
}
