/**
 * POST /api/skills/scaffold
 *
 * Body: { workDir, name, description, body }
 *
 * Creates `<workDir>/.marvin/skills/<name>/SKILL.md` with proper YAML
 * frontmatter + the given body. Used by the Skills pane's "Build" button
 * to materialise an LLM-discovered suggestion (ADR-0028 development branch)
 * or any other source of structured skill content.
 *
 * Refuses to overwrite an existing skill — caller must delete first.
 * Refuses non-kebab-case names. Refuses absolute / traversal paths.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type NextRequest, NextResponse } from "next/server";

import { requireMarvinClient } from "@/lib/csrf";
import { validateProjectCwd } from "@marvin/runtime/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function escapeYamlString(s: string): string {
  // Single-line YAML: wrap in double-quotes and escape \ and ".
  const escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  return `"${escaped}"`;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { workDir?: string; name?: string; description?: string; body?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = validateProjectCwd(body.workDir);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  const name = body.name?.trim();
  const description = body.description?.trim();
  const skillBody = body.body?.trim();
  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json(
      { error: "name must be kebab-case, 1-80 chars, [a-z0-9-]" },
      { status: 400 },
    );
  }
  if (!description) {
    return NextResponse.json({ error: "description required" }, { status: 400 });
  }
  if (!skillBody) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  const skillDir = resolve(join(v.workDir, ".marvin", "skills", name));
  const skillFile = join(skillDir, "SKILL.md");
  // Defensive: ensure the resolved path is actually under workDir/.marvin/skills/
  const allowedRoot = resolve(join(v.workDir, ".marvin", "skills"));
  if (!skillDir.startsWith(allowedRoot + "/") && skillDir !== allowedRoot) {
    return NextResponse.json({ error: "path traversal rejected" }, { status: 400 });
  }
  if (existsSync(skillFile)) {
    return NextResponse.json(
      {
        error: "skill already exists",
        path: skillFile,
      },
      { status: 409 },
    );
  }
  await mkdir(skillDir, { recursive: true });
  const content =
    `---\nname: ${name}\ndescription: ${escapeYamlString(description)}\n---\n\n${skillBody}\n`;
  await writeFile(skillFile, content, "utf-8");
  return NextResponse.json({ ok: true, path: skillFile, name });
}
