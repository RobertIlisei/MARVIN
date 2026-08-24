/**
 * POST /api/skills/update — pull the latest version of installed skills
 * (ADR-0071).
 *
 * Skills are acquired by cloning a Git repo (ADR-0039). Until ADR-0071 nothing
 * recorded WHERE one came from, so there was no way to re-fetch it; this route
 * is the other half of that record.
 *
 * CSRF-guarded; user-initiated (the Skills pane "Check for updates" / per-row
 * "Update"). Re-clones from the recorded source, compares a content hash, and
 * re-installs only when the upstream folder actually differs.
 *
 * Body (JSON):
 * ```
 * // one skill
 * { "name": "docx", "scope": "user-global", "checkOnly": true? , "url": "..."? }
 * // every skill in a scope that has a recorded source
 * { "all": true, "scope": "project-local", "workDir": "/abs/path", "checkOnly": true? }
 * ```
 *
 * `url` re-binds provenance — the backfill path for skills installed before
 * this existed, and the escape hatch when a skill moves repos.
 */

import { validateProjectCwd } from "@marvin/runtime/projects";
import {
  type SkillScope,
  updateAllSkills,
  updateSkill,
} from "@marvin/runtime/skill-installer";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

interface UpdateBody {
  name?: string;
  scope?: SkillScope;
  workDir?: string;
  url?: string;
  checkOnly?: boolean;
  all?: boolean;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const scope: SkillScope = body.scope === "project-local" ? "project-local" : "user-global";

  // Same rule as /api/skills/add: project-local touches a workspace, so the
  // workDir is validated; user-global writes into ~/.claude/skills.
  let workDir: string | undefined;
  if (scope === "project-local") {
    const v = validateProjectCwd(body.workDir);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
    workDir = v.workDir;
  }

  const checkOnly = body.checkOnly === true;
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined;

  if (body.all === true) {
    // `url` is meaningless for a bulk run — each skill has its own source, and
    // applying one URL to all of them would silently rebind every record.
    if (url) {
      return NextResponse.json(
        { error: "`url` cannot be combined with `all` — rebind one skill at a time." },
        { status: 400 },
      );
    }
    const result = updateAllSkills({
      scope,
      ...(workDir ? { workDir } : {}),
      ...(checkOnly ? { checkOnly: true } : {}),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "update failed" }, { status: 400 });
    }
    return NextResponse.json(result);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "`name` (or `all: true`) is required" }, { status: 400 });
  }

  const outcome = updateSkill({
    name,
    scope,
    ...(workDir ? { workDir } : {}),
    ...(url ? { url } : {}),
    ...(checkOnly ? { checkOnly: true } : {}),
  });
  // A per-skill failure is a 200 with `status: "error"`, not an HTTP error:
  // the bulk shape reports the same way, and the pane renders one row either
  // way. Reserve non-2xx for a malformed request.
  return NextResponse.json({ ok: outcome.status !== "error", results: [outcome] });
}
