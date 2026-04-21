import {
  addProject,
  getActiveProjectId,
  listProjects,
  removeProject,
  setActiveProjectId,
  verifyWorkDir,
} from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/projects → { projects, active } */
export async function GET() {
  return NextResponse.json(
    {
      projects: listProjects(),
      active: getActiveProjectId(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface AddBody {
  name?: string;
  workDir?: string;
  setActive?: boolean;
}

/** POST /api/projects { name?, workDir, setActive? } → { project } */
export async function POST(req: NextRequest) {
  let body: AddBody;
  try {
    body = (await req.json()) as AddBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const raw = body.workDir?.trim();
  if (!raw) {
    return NextResponse.json({ error: "workDir is required" }, { status: 400 });
  }
  const check = verifyWorkDir(raw);
  if (!check.ok) {
    return NextResponse.json(
      { error: check.error ?? "Invalid workDir", verify: check },
      { status: 400 },
    );
  }
  const project = addProject({ name: body.name, workDir: check.absolutePath });
  if (body.setActive) setActiveProjectId(project.id);
  return NextResponse.json({ project });
}

/** DELETE /api/projects?id=… → { removed: boolean } */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const removed = removeProject(id);
  return NextResponse.json({ removed });
}
