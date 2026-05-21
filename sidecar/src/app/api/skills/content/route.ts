/**
 * GET /api/skills/content?workDir=<abs>&path=<abs>
 *
 * Read a skill's SKILL.md (or any file under a skill directory) and return
 * its content. Skills live OUTSIDE the project workDir — `~/.claude/skills/`
 * for user-global skills — so they can't go through the sandboxed
 * /api/files/raw endpoint (which enforces `validateProjectCwd`).
 *
 * This endpoint applies a tight whitelist instead:
 *
 *   ✓ Anywhere under  <homedir>/.claude/skills/
 *   ✓ Anywhere under  <workDir>/.marvin/skills/  (project-local)
 *
 * Everything else returns 403. Symlink escapes are prevented by realpath
 * resolution before the prefix check.
 *
 * Used by the SwiftUI Skills pane's "View" button (and the equivalent web
 * UI) so users can read a skill without invoking it.
 *
 * Cap: 1 MB. SKILL.md files are typically <100 KB but graphify's is ~57 KB
 * with the documentation; 1 MB gives plenty of headroom without serving
 * arbitrary blobs.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 1 * 1024 * 1024;

function userGlobalRoot(): string {
  return resolve(join(homedir(), ".claude", "skills"));
}

function projectLocalRoot(workDir: string | null | undefined): string | null {
  if (!workDir) return null;
  try {
    return resolve(join(workDir, ".marvin", "skills"));
  } catch {
    return null;
  }
}

async function isUnderRoot(target: string, root: string): Promise<boolean> {
  // realpath both sides so symlinks can't escape.
  let resolved: string;
  let realRoot: string;
  try {
    resolved = await fs.realpath(target);
  } catch {
    // The target may not exist (caller will get 404 below); use the
    // declared path for the prefix check so we still respond with the
    // right error class. Don't fall through to "allowed" on missing.
    resolved = resolve(target);
  }
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = resolve(root);
  }
  // Append a separator to avoid `/skills` matching `/skills-cache`.
  const realRootSep = realRoot.endsWith("/") ? realRoot : realRoot + "/";
  return resolved === realRoot || resolved.startsWith(realRootSep);
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("path");
  const workDir = req.nextUrl.searchParams.get("workDir");
  if (!target) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }

  const absTarget = resolve(target);
  const userRoot = userGlobalRoot();
  const projRoot = projectLocalRoot(workDir);

  const allowed =
    (await isUnderRoot(absTarget, userRoot)) ||
    (projRoot !== null && (await isUnderRoot(absTarget, projRoot)));

  if (!allowed) {
    return NextResponse.json(
      {
        error:
          "path is not under any allowed skills root (~/.claude/skills or <workDir>/.marvin/skills)",
      },
      { status: 403 },
    );
  }

  let stat;
  try {
    stat = await fs.stat(absTarget);
  } catch (e) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "not-a-file" }, { status: 400 });
  }
  if (stat.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "too-large", size: stat.size, cap: MAX_BYTES },
      { status: 413 },
    );
  }

  try {
    const content = await fs.readFile(absTarget, "utf-8");
    return NextResponse.json({
      path: absTarget,
      size: stat.size,
      content,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown io error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
