/**
 * GET /api/sessions/meta?projectId=…&sessionId=…  → { meta } (null when none)
 * PUT /api/sessions/meta { projectId, sessionId, tree?, lane?, title?, worktreeAction? }
 *
 * ADR-0107 — a session's tree and lane, editable from the tab's chip.
 * Switching worktree → shared CLOSES the tree's record (it becomes an
 * ordinary deliverable: ready / empty / merged by derivation; nothing is
 * deleted unless `worktreeAction: "discard"`, and "merge" folds it back
 * first). Switching shared → worktree creates one from the current HEAD.
 * Either switch is refused while a turn is live: the running turn's cwd
 * cannot change under it.
 */

import { getProject } from "@marvin/runtime/projects";
import {
  normaliseLane,
  readSessionMeta,
  type SessionTree,
  updateSessionMeta,
} from "@marvin/runtime/session-meta";
import { announceProjectEvent, getLiveTurn } from "@marvin/runtime/turn-registry";
import { prepareSessionWorktree, readOrDetectWorktreeSetup } from "@marvin/runtime/worktree-setup";
import {
  createSessionWorktree,
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

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim();
  if (!projectId || !sessionId || !SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId)) {
    return NextResponse.json({ error: "projectId and sessionId are required" }, { status: 400 });
  }
  return NextResponse.json({ meta: readSessionMeta(projectId, sessionId) }, { headers: { "Cache-Control": "no-store" } });
}

interface PutBody {
  projectId?: string;
  sessionId?: string;
  tree?: "worktree" | "shared";
  lane?: string[];
  title?: string;
  /** What to do with the worktree when leaving worktree mode. Default: keep. */
  worktreeAction?: "merge" | "keep" | "discard";
  /** Reopen a closed tab: clears `closedAt`, returns a kept worktree to `session`. */
  reopen?: boolean;
}

export async function PUT(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = body.projectId?.trim();
  const sessionId = body.sessionId?.trim();
  if (!projectId || !sessionId || !SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId)) {
    return NextResponse.json({ error: "projectId and sessionId are required" }, { status: 400 });
  }
  const project = getProject(projectId);
  if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
  const meta = readSessionMeta(projectId, sessionId);
  if (!meta) return NextResponse.json({ error: "no meta for that session yet" }, { status: 404 });
  const workDir = project.workDir;

  const patch: Parameters<typeof updateSessionMeta>[2] = {};
  if (typeof body.title === "string") patch.title = body.title.trim().slice(0, 200) || undefined;
  if (body.reopen === true && meta.closedAt) {
    patch.closedAt = undefined;
    if (meta.tree.mode === "worktree") reopenSessionWorktree(workDir, sessionId);
  }

  let tree: SessionTree = meta.tree;
  const wantsSwitch = body.tree && body.tree !== meta.tree.mode;
  if (wantsSwitch) {
    const live = getLiveTurn(sessionId);
    if (live && !live.ended) {
      return NextResponse.json({ error: "a turn is running in this tab — stop it before switching trees", code: "turn-live" }, { status: 409 });
    }
    if (body.tree === "shared") {
      // Leave the worktree: close its record, optionally merge or discard.
      const rec = findSessionWorktree(workDir, sessionId);
      if (rec) {
        markSessionWorktreeClosed(workDir, sessionId);
        if (body.worktreeAction === "merge") {
          const out = mergeWorktree(workDir, rec.slug);
          if (!out.ok) {
            reopenSessionWorktree(workDir, sessionId);
            return NextResponse.json({ error: out.message, code: "merge-failed" }, { status: 409 });
          }
        } else if (body.worktreeAction === "discard") {
          const out = discardWorktree(workDir, rec.slug);
          if (!out.ok) return NextResponse.json({ error: out.message, code: "discard-failed" }, { status: 409 });
        }
      }
      const lane = normaliseLane(body.lane);
      tree = { mode: "shared", ...(lane && lane.length ? { lane } : {}) };
    } else {
      // Enter a worktree: reopen a kept one, or create from the current HEAD.
      const kept = findSessionWorktree(workDir, sessionId);
      const rec = kept ? (reopenSessionWorktree(workDir, sessionId) ?? kept) : createSessionWorktree(workDir, { sessionId, title: meta.title });
      if (!kept) prepareSessionWorktree(workDir, rec.path, readOrDetectWorktreeSetup(workDir).config);
      tree = { mode: "worktree", slug: rec.slug, path: rec.path, branch: rec.branch, base: rec.base, ...(rec.baseRef ? { baseRef: rec.baseRef } : {}) };
    }
    patch.tree = tree;
  } else if (body.lane !== undefined && tree.mode === "shared") {
    const lane = normaliseLane(body.lane);
    if (lane === null) return NextResponse.json({ error: "invalid lane" }, { status: 400 });
    tree = { mode: "shared", ...(lane.length ? { lane } : {}) };
    patch.tree = tree;
  }

  const next = updateSessionMeta(projectId, sessionId, patch);
  if (!next) return NextResponse.json({ error: "could not write meta" }, { status: 500 });
  if (patch.tree) {
    announceProjectEvent({ event: "session.tree", data: { marvinSessionId: sessionId, projectId, tree: next.tree } });
  }
  return NextResponse.json({ meta: next });
}
