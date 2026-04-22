import {
  getActiveProjectId,
  getProject,
  setActiveProjectId,
} from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects/active → { id, project } */
export async function GET() {
  const id = getActiveProjectId();
  return NextResponse.json(
    { id, project: id ? getProject(id) : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** PUT /api/projects/active { id } → { id, project } */
export async function PUT(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { id?: string | null };
  try {
    body = (await req.json()) as { id?: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = body.id ?? null;
  if (id !== null) {
    const hit = getProject(id);
    if (!hit) {
      return NextResponse.json({ error: "Unknown project id" }, { status: 404 });
    }
  }
  setActiveProjectId(id);
  return NextResponse.json({ id, project: id ? getProject(id) : null });
}
