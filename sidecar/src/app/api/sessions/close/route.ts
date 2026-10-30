/**
 * POST /api/sessions/close { projectId, marvinSessionId, worktree: "merge" | "keep" | "discard", commitFirst? }
 *
 * ADR-0107 — a tab is closing. Its worktree (if any) leaves the `session`
 * state and becomes an ordinary deliverable; what happens next is the user's
 * choice:
 *
 *   merge   — fold the branch into the current branch of the main tree,
 *             locally, never pushed (ADR-0103). A dirty worktree is refused
 *             unless `commitFirst`, which commits everything in it first.
 *             A conflict aborts cleanly and leaves the branch in place.
 *   keep    — the branch is kept for integration (Merge all / Prepare MR,
 *             ADR-0109). With `commitFirst`, uncommitted work is committed
 *             as WIP first so nothing kept can be lost to a sweep (ADR-0111).
 *   discard — checkout AND branch removed. Taken on an explicit request, and
 *             by the client's silent path for a tree with nothing in it
 *             (ADR-0111: nothing survives a tab unless it holds a commit).
 *
 * After every close the sweep runs, bounded and best-effort, so closed
 * `empty` and `merged` trees leave the disk without a button (ADR-0111).
 *
 * Refused while the tab has a live turn. The logic is `closeSession` in
 * `@marvin/runtime/session-close`, which the supervisor inbox shares.
 */

import { getProject } from "@marvin/runtime/projects";
import { closeSession } from "@marvin/runtime/session-close";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

interface CloseBody {
  projectId?: string;
  marvinSessionId?: string;
  worktree?: "merge" | "keep" | "discard";
  commitFirst?: boolean;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: CloseBody;
  try {
    body = (await req.json()) as CloseBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = body.projectId?.trim();
  const sessionId = body.marvinSessionId?.trim();
  const action = body.worktree ?? "keep";
  if (!projectId || !sessionId || !SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId)) {
    return NextResponse.json({ error: "projectId and marvinSessionId are required" }, { status: 400 });
  }
  if (action !== "merge" && action !== "keep" && action !== "discard") {
    return NextResponse.json({ error: "worktree must be merge | keep | discard" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  // The close itself lives in the runtime (`session-close.ts`), shared with the
  // supervisor inbox's close-with-keep consent (ADR-0127 milestone 5).
  const out = await closeSession({ projectId, workDir: project.workDir, sessionId, action, commitFirst: body.commitFirst });
  return NextResponse.json(out.body, { status: out.status });
}
