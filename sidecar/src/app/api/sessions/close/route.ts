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
 * Refused while the tab has a live turn.
 */

import { getProject } from "@marvin/runtime/projects";
import { readSessionMeta, updateSessionMeta } from "@marvin/runtime/session-meta";
import { logTelemetry } from "@marvin/runtime/telemetry";
import { getLiveTurn } from "@marvin/runtime/turn-registry";
import { readWorktreeSetupConfig } from "@marvin/runtime/worktree-setup";
import {
  commitWorktreeWorkInProgress,
  discardWorktree,
  excludeFromStatus,
  findSessionWorktree,
  markSessionWorktreeClosed,
  mergeWorktree,
  reopenSessionWorktree,
  sweepWorktrees,
  symlinkExcludePattern,
  unstageSymlinkedDirs,
  worktreeHasWork,
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
    // MARVIN's own symlinks (node_modules and friends) are not the tab's work:
    // exclude them by name — a worktree created before the exclude line
    // existed has none — and unstage any a previous attempt's `add -A` caught.
    const linked = readWorktreeSetupConfig(workDir).symlinkDirectories;
    excludeFromStatus(workDir, linked.map(symlinkExcludePattern));
    unstageSymlinkedDirs(rec.path, linked);
    if (worktreeHasWork(rec.path)) {
      if (!body.commitFirst) {
        reopenSessionWorktree(workDir, sessionId);
        return NextResponse.json(
          { error: "the worktree has uncommitted changes", code: "worktree-dirty", branch: rec.branch },
          { status: 409 },
        );
      }
      const committed = await commitWorktreeWorkInProgress(rec.path, rec.slug);
      if (!committed.ok) {
        reopenSessionWorktree(workDir, sessionId);
        return NextResponse.json(
          { error: `could not commit the worktree: ${committed.message}`, code: "commit-failed", branch: rec.branch },
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
  } else if (body.commitFirst && worktreeHasWork(rec.path)) {
    // ADR-0111 — "keep" on a dirty tree commits the work so the kept branch
    // holds it; a clean tree is left exactly as it is.
    const linked = readWorktreeSetupConfig(workDir).symlinkDirectories;
    excludeFromStatus(workDir, linked.map(symlinkExcludePattern));
    unstageSymlinkedDirs(rec.path, linked);
    const committed = await commitWorktreeWorkInProgress(rec.path, rec.slug);
    if (!committed.ok) {
      reopenSessionWorktree(workDir, sessionId);
      return NextResponse.json(
        { error: `could not commit the worktree: ${committed.message}`, code: "commit-failed", branch: rec.branch },
        { status: 409 },
      );
    }
    message = `kept ${rec.branch} with its changes committed`;
  }
  if (meta) updateSessionMeta(projectId, sessionId, { closedAt });
  // ADR-0111 — reclaim what this close (or an earlier one) left spent.
  let swept = 0;
  try {
    swept = sweepWorktrees(workDir, Date.now(), { isSessionBusy: (id) => !!getLiveTurn(id) && !getLiveTurn(id)?.ended }).filter((s) => s.deletedBranch).length;
    if (swept) logTelemetry({ kind: "worktree.session.swept", trigger: "close", swept });
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true, worktree: { slug: rec.slug, branch: rec.branch, action }, message, swept });
}
