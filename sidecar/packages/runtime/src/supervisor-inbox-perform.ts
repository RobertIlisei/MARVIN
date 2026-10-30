/**
 * The services an inbox consent performs through (ADR-0127 §5, plan
 * milestone 5) — each with the USER's authority, because the user's click on
 * the raw act is the consent:
 *
 * - answers and confirms are recorded `answeredBy: "user"`;
 * - posture goes through `applyPostureChange` with `actor: "user"`, so the
 *   milestone 2 rule still holds: a widening the app cannot yet show is
 *   refused, the user's included (until milestone 6);
 * - merges stay local and never push (ADR-0103); Prepare MR pushes only when
 *   the act the user saw said so;
 * - a closed tab keeps its work: `keep` commits a dirty tree first (ADR-0111);
 * - a new tab is opened through ADR-0122's atomic path — a fresh worktree or
 *   a refusal, never the shared checkout and never a fallback — at the posture
 *   confirmed on the item, and its first message is the supervisor's, so the
 *   turn it starts is supervisor-authored and touched (§4 item 7).
 */

import { randomUUID } from "node:crypto";

import { answerQuestion, resolveConfirm } from "./confirm-answer";
import { activeModelLookup, applyPostureChange } from "./posture";
import { closeSession } from "./session-close";
import { type SessionPosture, type SessionTree, upsertSessionMeta } from "./session-meta";
import type { InboxPerform } from "./supervisor-inbox-actions";
import type { LedgerGround } from "./supervisor-ledger";
import { sendAsSupervisor } from "./supervisor-send";
import { applySupervisorAction, getSupervisorState, overBudget } from "./supervisor-state";
import { announceProjectEvent, cancelLiveTurn, getLiveTurn } from "./turn-registry";
import { createPreparedSessionWorktree, prepareSessionWorktree, readOrDetectWorktreeSetup } from "./worktree-setup";
import { discardFreshSessionWorktree, discardWorktree, mergeAllWorktrees, mergeWorktree, prepareMergeRequest } from "./worktrees";

type Failed = { ok: false; status: number; error: string; code?: string };

const isSessionBusy = (id: string) => {
  const t = getLiveTurn(id);
  return !!t && !t.ended;
};

/**
 * Open the tab a user confirmed (ADR-0127 §4 item 7). Nothing is written
 * until the worktree exists: a refused worktree answers the ADR-0122 refusal
 * and leaves no tab, no meta and no transcript behind.
 */
export async function openSupervisorTab(
  projectId: string,
  workDir: string,
  a: { firstMessage: string; title?: string | undefined; posture: SessionPosture; grounds: LedgerGround[]; ledgerId: string | null; editedByUser: boolean },
): Promise<{ ok: true; marvinSessionId: string } | Failed> {
  // Every opening counts against the spend cap (§6).
  if (overBudget(getSupervisorState(projectId))) return { ok: false, status: 409, code: "budget", error: "the supervisor's daily cap is reached — raise it first" };
  const marvinSessionId = randomUUID();
  let rec: ReturnType<typeof createPreparedSessionWorktree>["record"];
  try {
    rec = createPreparedSessionWorktree(workDir, { sessionId: marvinSessionId, title: a.title }).record;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 409, code: "worktree-failed", error: `worktree could not be created: ${reason}` };
  }
  const tree: SessionTree = { mode: "worktree", slug: rec.slug, path: rec.path, branch: rec.branch, base: rec.base, ...(rec.baseRef ? { baseRef: rec.baseRef } : {}) };
  const meta = upsertSessionMeta(projectId, marvinSessionId, { workDir, tree, posture: a.posture }, { posture: a.posture, tree, ...(a.title ? { title: a.title } : {}) });
  if (!meta) {
    discardFreshSessionWorktree(workDir, rec);
    return { ok: false, status: 500, code: "meta-failed", error: "the tab's record could not be written; nothing was opened" };
  }
  announceProjectEvent({ event: "session.tree", data: { marvinSessionId, projectId, tree } });
  const sent = await sendAsSupervisor({
    projectId,
    marvinSessionId,
    text: a.firstMessage,
    kind: "first-message",
    grounds: a.grounds,
    ledgerId: a.ledgerId,
    ...(a.editedByUser ? { editedByUser: true } : {}),
  });
  if (!sent.ok) return { ok: false, status: 409, code: sent.code, error: `the tab opened, but its first message was refused: ${sent.reason}` };
  return { ok: true, marvinSessionId };
}

export function defaultInboxPerform(projectId: string, workDir: string, token: string | null): InboxPerform {
  return {
    answer: (a) => {
      const r = answerQuestion({ ...a, answeredBy: "user" });
      return r.ok ? { ok: true } : r;
    },
    confirm: (a) => resolveConfirm({ ...a, answeredBy: "user" }),
    posture: async (a) => {
      const r = applyPostureChange({ projectId, marvinSessionId: a.sessionId, patch: a.patch, actor: "user", lookup: await activeModelLookup() });
      return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.error };
    },
    send: async (a) => {
      const r = await sendAsSupervisor({ projectId, marvinSessionId: a.sessionId, text: a.text, kind: a.kind, grounds: a.grounds, ledgerId: a.ledgerId });
      return r.ok ? { ok: true, message: r.queued ? "queued until the tab's turn ends" : "sent" } : { ok: false, status: 409, code: r.code, error: r.reason };
    },
    cancel: (sessionId) => (cancelLiveTurn(sessionId, "user") ? { ok: true } : { ok: false, status: 409, error: "the tab has no turn running" }),
    worktrees: async (a) => {
      if (a.op === "merge") {
        const out = mergeWorktree(workDir, a.slugs[0] ?? "", { isSessionBusy });
        return out.ok ? { ok: true, message: out.message } : { ok: false, status: 409, error: out.message };
      }
      if (a.op === "merge-all") {
        const out = mergeAllWorktrees(workDir, { isSessionBusy });
        return out.stopped ? { ok: false, status: 409, error: out.stopped.message } : { ok: true, message: `merged ${out.merged.length}` };
      }
      if (a.op === "prepare-mr") {
        const out = await prepareMergeRequest(workDir, {
          slugs: a.slugs,
          prepare: (p) => prepareSessionWorktree(workDir, p, readOrDetectWorktreeSetup(workDir).config),
          push: a.push === true,
          openMergeRequest: a.openMergeRequest === true,
        });
        return out.ok ? { ok: true, message: out.summary } : { ok: false, status: 409, error: out.summary };
      }
      for (const slug of a.slugs) {
        const out = discardWorktree(workDir, slug);
        if (!out.ok) return { ok: false, status: 409, error: out.message };
      }
      return { ok: true, message: `dropped ${a.slugs.join(", ")}` };
    },
    close: async (a) => {
      // Keep commits a dirty tree first, so nothing kept can be lost to a sweep (ADR-0111).
      const out = await closeSession({ projectId, workDir, sessionId: a.sessionId, action: a.worktree, commitFirst: a.worktree === "keep" });
      return out.status === 200
        ? { ok: true, message: String(out.body.message ?? "closed") }
        : { ok: false, status: out.status, error: String(out.body.error ?? "could not close"), ...(typeof out.body.code === "string" ? { code: out.body.code } : {}) };
    },
    openTab: (a) => openSupervisorTab(projectId, workDir, a),
    supervisor: (a) => applySupervisorAction({ projectId, ...a }, token),
    modelLookup: activeModelLookup,
  };
}
