/**
 * POST /api/skills/add — fetch a skill from a Git repo (ADR-0039, phase A).
 *
 * CSRF-guarded; user-initiated only (the Skills pane "Add from GitHub"
 * sheet). Clones the repo, discovers SKILL.md folders, and installs the
 * selected ones into `~/.claude/skills/` (user-global) or
 * `<workDir>/.marvin/skills/` (project-local). A repo with >1 skill and no
 * `only` selection returns the candidate list instead of installing.
 *
 * Body (JSON):
 * ```
 * { "url": "...", "scope": "user-global" | "project-local",
 *   "workDir": "/abs/path"?, "only": ["skill-name", ...]? }
 * ```
 */

import { type NextRequest, NextResponse } from "next/server";
import { addSkillFromGit, type SkillScope } from "@marvin/runtime/skill-installer";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

interface AddBody {
  url?: string;
  scope?: SkillScope;
  workDir?: string;
  only?: string[];
  /** Marketplace flow (phase B): plugin to install from a marketplace URL. */
  plugin?: string;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: AddBody;
  try {
    body = (await req.json()) as AddBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return NextResponse.json({ error: "`url` is required" }, { status: 400 });

  const scope: SkillScope = body.scope === "project-local" ? "project-local" : "user-global";

  // project-local writes into a workspace — validate it like the rest of the
  // route family. user-global writes into ~/.claude/skills (no project).
  let workDir: string | undefined;
  if (scope === "project-local") {
    const v = validateProjectCwd(body.workDir);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
    workDir = v.workDir;
  }

  const only = Array.isArray(body.only)
    ? body.only.filter((x): x is string => typeof x === "string")
    : undefined;

  const plugin = typeof body.plugin === "string" && body.plugin.trim() ? body.plugin.trim() : undefined;
  const result = addSkillFromGit({ url, scope, workDir, only, plugin });
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "add failed" }, { status: 400 });
  }
  return NextResponse.json(result);
}
