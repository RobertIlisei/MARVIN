/**
 * GET /api/skills?workDir=<absolute-path>
 *
 * Returns the Skills pane payload (ADR-0025): fingerprint summary,
 * suggestion list, user-global skill listing, project-local skill
 * listing, audit-decision status. Pure read — no CSRF guard needed.
 *
 * The Swift Skills pane calls this on:
 *   - tab open
 *   - explicit refresh button
 *   - after a `park-all` / `unpark` mutation completes
 *
 * The handler does no caching: every call re-walks both skill trees
 * and re-runs the fingerprint. Cheap on the order of a Files-pane
 * refresh; if it ever becomes expensive (huge `~/.claude/skills/`
 * tree), revisit with an in-process LRU keyed on `workDir`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { resolve } from "node:path";
import { buildSkillsIndex } from "@marvin/runtime/skills-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("workDir");
  if (!raw) {
    return NextResponse.json(
      { error: "workDir query is required" },
      { status: 400 },
    );
  }
  // Reject relative paths defensively. The frontend always sends
  // absolute paths from the bridge state, but a relative path would
  // resolve against the sidecar process cwd which is meaningless to
  // the user.
  if (!raw.startsWith("/")) {
    return NextResponse.json(
      { error: "workDir must be an absolute path" },
      { status: 400 },
    );
  }
  const workDir = resolve(raw);
  try {
    const index = buildSkillsIndex(workDir);
    return NextResponse.json(index);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { error: `failed to build skills index: ${message}` },
      { status: 500 },
    );
  }
}
