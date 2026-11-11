/**
 * Closing a tab (ADR-0107, ADR-0111) — the service behind
 * `POST /api/sessions/close`, and since ADR-0127 milestone 5 behind the
 * inbox's close-with-keep consent too. Moved here from the route unchanged,
 * so the two cannot drift.
 *
 *   merge   — fold the branch into the current branch of the main tree,
 *             locally, never pushed (ADR-0103). A dirty worktree is refused
 *             unless `commitFirst`, which commits everything in it first.
 *             A conflict aborts cleanly and leaves the branch in place.
 *   keep    — the branch is kept for integration (Merge all / Prepare MR,
 *             ADR-0109). With `commitFirst`, uncommitted work is committed
 *             as WIP first so nothing kept can be lost to a sweep (ADR-0111).
 *   discard — checkout AND branch removed.
 *
 * After every close the sweep runs, bounded and best-effort, so closed
 * `empty` and `merged` trees leave the disk without a button (ADR-0111).
 * Refused while the tab has a live turn.
 */

import { readSessionMeta, updateSessionMeta } from "./session-meta";
import { endFollows } from "./supervisor-follows";
import { logTelemetry } from "./telemetry";
import { announceProjectEvent, getLiveTurn } from "./turn-registry";
import { readWorktreeSetupConfig } from "./worktree-setup";
import {
  commitWorktreeWorkInProgress,
  discardWorktree,
  excludeFromStatus,
  findSessionWorktree,
  markSessionWorktreeClosed,
  mergeWorktree,
  recoverSessionWorktree,
  reopenSessionWorktree,
  sweepWorktreesAsync,
  symlinkExcludePattern,
  unstageSymlinkedDirs,
  worktreeHasWork,
} from "./worktrees";

export type CloseAction = "merge" | "keep" | "discard";

/** ADR-0128 §5 — a follow ends at its tab's close. Best-effort: the close stands either way. */
function endFollowsOf(projectId: string, sessionId: string): void {
  try {
    endFollows(projectId, (f) => f.sessionId === sessionId, "closed");
  } catch {
    /* an unreadable follows file must not fail a close */
  }
}

/** ADR-0133 — a slot may have freed; the approved queue's opener looks again. */
function announceClosed(projectId: string, marvinSessionId: string): void {
  try {
    announceProjectEvent({ event: "session.closed", data: { marvinSessionId, projectId } });
  } catch {
    /* the close stands; only the notification is lost */
  }
}

export interface CloseResult {
  status: number;
  body: Record<string, unknown>;
}

export async function closeSession(args: { projectId: string; workDir: string; sessionId: string; action: CloseAction; commitFirst?: boolean | undefined }): Promise<CloseResult> {
  const { projectId, workDir, sessionId, action } = args;
  const live = getLiveTurn(sessionId);
  if (live && !live.ended) {
    return { status: 409, body: { error: "a turn is running in this tab — stop it first", code: "turn-live" } };
  }
  const meta = readSessionMeta(projectId, sessionId);
  // A tab whose meta says it runs in a worktree but whose registry binding was
  // lost: re-bind from the meta rather than read "no record" as "no worktree"
  // — that answered a merge with "closed" and merged nothing (2026-10-31).
  const rec = findSessionWorktree(workDir, sessionId) ?? (meta?.tree.mode === "worktree" ? recoverSessionWorktree(workDir, sessionId, meta.tree) : null);
  const closedAt = new Date().toISOString();

  if (!rec) {
    if (meta?.tree.mode === "worktree" && action !== "keep") {
      return {
        status: 409,
        body: {
          error: `this tab's worktree (${meta.tree.branch}) has no registry record and could not be recovered — nothing was ${action === "merge" ? "merged" : "discarded"}`,
          code: "worktree-lost",
          branch: meta.tree.branch,
        },
      };
    }
    if (meta) updateSessionMeta(projectId, sessionId, { closedAt });
    endFollowsOf(projectId, sessionId);
    announceClosed(projectId, sessionId);
    return { status: 200, body: { ok: true, worktree: null, message: "closed" } };
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
      if (!args.commitFirst) {
        reopenSessionWorktree(workDir, sessionId);
        return { status: 409, body: { error: "the worktree has uncommitted changes", code: "worktree-dirty", branch: rec.branch } };
      }
      const committed = await commitWorktreeWorkInProgress(rec.path, rec.slug);
      if (!committed.ok) {
        reopenSessionWorktree(workDir, sessionId);
        return { status: 409, body: { error: `could not commit the worktree: ${committed.message}`, code: "commit-failed", branch: rec.branch } };
      }
    }
    const out = mergeWorktree(workDir, rec.slug);
    if (!out.ok) {
      reopenSessionWorktree(workDir, sessionId);
      return { status: 409, body: { error: out.message, code: "merge-failed", branch: rec.branch } };
    }
    message = out.message;
  } else if (action === "discard") {
    const out = discardWorktree(workDir, rec.slug);
    if (!out.ok) return { status: 409, body: { error: out.message, code: "discard-failed" } };
    message = out.message;
  } else if (args.commitFirst && worktreeHasWork(rec.path)) {
    // ADR-0111 — "keep" on a dirty tree commits the work so the kept branch
    // holds it; a clean tree is left exactly as it is.
    const linked = readWorktreeSetupConfig(workDir).symlinkDirectories;
    excludeFromStatus(workDir, linked.map(symlinkExcludePattern));
    unstageSymlinkedDirs(rec.path, linked);
    const committed = await commitWorktreeWorkInProgress(rec.path, rec.slug);
    if (!committed.ok) {
      reopenSessionWorktree(workDir, sessionId);
      return { status: 409, body: { error: `could not commit the worktree: ${committed.message}`, code: "commit-failed", branch: rec.branch } };
    }
    message = `kept ${rec.branch} with its changes committed`;
  }
  if (meta) updateSessionMeta(projectId, sessionId, { closedAt });
  // ADR-0111 — reclaim what this close (or an earlier one) left spent.
  // In the background: a sweep reconciles every worktree of the project, and
  // closing a tab waited on it (2026-09-30, "closing tabs is very slow"). The
  // client never read the count; the busy guard still protects live turns.
  void sweepWorktreesAsync(workDir, Date.now(), { isSessionBusy: (id) => !!getLiveTurn(id) && !getLiveTurn(id)?.ended })
    .then((out) => {
      const swept = out.filter((s) => s.deletedBranch).length;
      if (swept) logTelemetry({ kind: "worktree.session.swept", trigger: "close", swept });
    })
    .catch(() => {
      /* best-effort */
    });
  endFollowsOf(projectId, sessionId);
  announceClosed(projectId, sessionId);
  return { status: 200, body: { ok: true, worktree: { slug: rec.slug, branch: rec.branch, action }, message } };
}
