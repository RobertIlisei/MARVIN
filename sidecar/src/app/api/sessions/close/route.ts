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
 *   keep    — nothing more; the tree derives to ready / empty and shows in
 *             Source Control. An `empty` clean tree is reclaimed by the next
 *             sweep.
 *   discard — checkout AND branch removed. The one destructive option, and
 *             only ever taken on an explicit request.
 *
 * Refused while the tab has a live turn.
 */

import { execFileSync } from "node:child_process";
import { getProject } from "@marvin/runtime/projects";
import { readSessionMeta, updateSessionMeta } from "@marvin/runtime/session-meta";
import { getLiveTurn } from "@marvin/runtime/turn-registry";
import {
  discardWorktree,
  findSessionWorktree,
  markSessionWorktreeClosed,
  mergeWorktree,
  reopenSessionWorktree,
} from "@marvin/runtime/worktrees";
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
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
  const live = getLiveTurn(sessionId);
  if (live && !live.ended) {
    return NextResponse.json({ error: "a turn is running in this tab — stop it first", code: "turn-live" }, { status: 409 });
  }
  const workDir = project.workDir;
  const meta = readSessionMeta(projectId, sessionId);
  const rec = findSessionWorktree(workDir, sessionId);
  const closedAt = new Date().toISOString();

  if (!rec) {
    if (meta) updateSessionMeta(projectId, sessionId, { closedAt });
    return NextResponse.json({ ok: true, worktree: null, message: "closed" });
  }

  markSessionWorktreeClosed(workDir, sessionId);
  let message = `kept ${rec.branch}`;
  if (action === "merge") {
    const dirty = git(rec.path, ["status", "--porcelain"]) !== "";
    if (dirty) {
      if (!body.commitFirst) {
        reopenSessionWorktree(workDir, sessionId);
        return NextResponse.json(
          { error: "the worktree has uncommitted changes", code: "worktree-dirty", branch: rec.branch },
          { status: 409 },
        );
      }
      try {
        git(rec.path, ["add", "-A"]);
        git(rec.path, ["commit", "-qm", `chore: work in progress from tab ${rec.slug}`]);
      } catch (err) {
        reopenSessionWorktree(workDir, sessionId);
        return NextResponse.json(
          { error: `could not commit the worktree: ${err instanceof Error ? err.message : String(err)}`, code: "commit-failed" },
          { status: 409 },
        );
      }
    }
    const out = mergeWorktree(workDir, rec.slug);
    if (!out.ok) {
      reopenSessionWorktree(workDir, sessionId);
      return NextResponse.json({ error: out.message, code: "merge-failed", branch: rec.branch }, { status: 409 });
    }
    message = out.message;
  } else if (action === "discard") {
    const out = discardWorktree(workDir, rec.slug);
    if (!out.ok) return NextResponse.json({ error: out.message, code: "discard-failed" }, { status: 409 });
    message = out.message;
  }
  if (meta) updateSessionMeta(projectId, sessionId, { closedAt });
  return NextResponse.json({ ok: true, worktree: { slug: rec.slug, branch: rec.branch, action }, message });
}
