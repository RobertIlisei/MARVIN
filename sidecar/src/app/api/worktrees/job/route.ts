/**
 * GET /api/worktrees/job?cwd=… — what the project's running integration is
 * doing right now, or the outcome of the last one while it is still fresh.
 *
 * Deliberately separate from `GET /api/worktrees`: that route reconciles every
 * worktree with synchronous git (measured at 1.2 s for twelve of them), which
 * is far too expensive to poll once a second. This one reads an in-memory
 * record and touches no git at all.
 *
 * ADR-0109 amendment (2026-09-11) — the surface the user asked for: *"where do
 * I track it? … how do I know it's working or not?"*
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { getIntegrationJob } from "@marvin/runtime/integration-job";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const sandbox = await checkFsPath({ cwd, target: cwd, mustExist: true, allowDirectory: true });
  if (!sandbox.ok || !sandbox.isDirectory) {
    return NextResponse.json({ error: sandbox.ok ? "cwd is not a directory" : sandbox.error }, { status: 400 });
  }
  return NextResponse.json({ job: getIntegrationJob(sandbox.absolutePath) });
}
