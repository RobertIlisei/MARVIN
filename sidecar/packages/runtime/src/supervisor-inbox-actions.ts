/**
 * Acting on an inbox item (ADR-0127 §5, plan milestone 5, brief §10.2
 * `POST /api/supervisor/inbox {id, actionId, edits?}`).
 *
 * The user's click on the raw act is the consent. What runs is the item's
 * stored act, replayed with the user's authority — answers and confirms
 * recorded `answeredBy: "user"`, posture through `actor: "user"`, a tab
 * opened as the user's act — never the supervisor's description of it.
 *
 * - Only an action the item offers (`actionsFor`) is accepted.
 * - A new tab is never wider than the card showed: an edit may narrow the
 *   posture and rewrite the first message, which stays the supervisor's,
 *   marked `editedByUser` (brief open decision 2). One request, one tab.
 * - A failed act leaves the item open with the reason; a performed one
 *   settles it `resolved` by the user, and the ledger gets an `inbox` line.
 *
 * The performers are injected, as the verbs' are: this module resolves no
 * confirm and starts no turn by itself.
 */

import { classifyPostureChange, type ModelLookup, type PosturePatch, validatePosturePatch } from "./posture";
import { containsSecretShape } from "./session";
import type { SessionPosture } from "./session-meta";
import { actionsFor, getInboxItem, type InboxAction, type InboxRecord, isInboxInFlight, listInbox, markInboxInFlight, settleInboxItem } from "./supervisor-inbox";
import { appendLedgerEntry, type LedgerGround } from "./supervisor-ledger";
import { MAX_SUPERVISOR_MESSAGE_CHARS } from "./supervisor-send";
import type { SupervisorActionResult } from "./supervisor-state";

type Failed = { ok: false; status: number; error: string; code?: string | undefined };
type Done = { ok: true; message?: string; marvinSessionId?: string; editedByUser?: boolean } | Failed;

export interface InboxPerform {
  /** `answerQuestion` with `answeredBy: "user"`. */
  answer(a: { turnId: string; toolUseId: string; answers: Record<string, string | string[]>; other: Record<string, string> }): { ok: true } | { ok: false; status: number; error: string };
  /** `resolveConfirm` with `answeredBy: "user"`. */
  confirm(a: { turnId: string; toolUseId: string; decision: "allow" | "deny" }): { ok: true } | { ok: false; status: number; error: string };
  /** `applyPostureChange` with `actor: "user"`. */
  posture(a: { sessionId: string; patch: PosturePatch }): Promise<Done>;
  /**
   * `sendAsSupervisor`: the words stay the supervisor's; the user's click sent
   * them (ADR-0128 §4), marked `editedByUser` when the user changed the text.
   * Refused for a scope-met tab unless the item is a scope review's reopening.
   */
  send(a: { sessionId: string; text: string; kind: "nudge" | "instruction"; grounds: LedgerGround[]; ledgerId: string | null; editedByUser: boolean; reopensScope: boolean }): Promise<Done>;
  /** Stop the tab's live turn, as the user. */
  cancel(sessionId: string): Done;
  worktrees(a: { op: "merge" | "merge-all" | "prepare-mr" | "drop"; slugs: string[]; push?: boolean | undefined; openMergeRequest?: boolean | undefined }): Promise<Done>;
  close(a: { sessionId: string; worktree: "keep" | "merge" | "discard" }): Promise<Done>;
  /** ADR-0122's atomic path: a fresh worktree or a refusal, nothing in between. */
  openTab(a: { firstMessage: string; title?: string | undefined; posture: SessionPosture; grounds: LedgerGround[]; ledgerId: string | null; editedByUser: boolean }): Promise<{ ok: true; marvinSessionId: string } | Failed>;
  /** The supervisor's own controls a guardrail item offers: resume, raise the cap. */
  supervisor(a: { action: "resume" } | { action: "cap"; capUsd: number }): SupervisorActionResult;
  modelLookup(): Promise<ModelLookup>;
}

export interface InboxActionRequest {
  id: string;
  actionId: string;
  edits?: Record<string, unknown> | undefined;
}

export type InboxActionResult = { ok: true; item: InboxRecord; outcome: { message?: string; marvinSessionId?: string } } | Failed;

const fail = (status: number, error: string, code?: string): Failed => ({ ok: false, status, error, ...(code ? { code } : {}) });

function asAnswers(v: unknown): Record<string, string | string[]> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string | string[]> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "string") out[k] = x;
    else if (Array.isArray(x) && x.every((y) => typeof y === "string")) out[k] = x as string[];
    else return null;
  }
  return out;
}

function asOther(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}

async function perform(projectId: string, item: InboxRecord, action: InboxAction, edits: Record<string, unknown>, p: InboxPerform): Promise<Done> {
  const act = item.act;
  if (!act) return fail(409, "this item carries no act to perform");
  switch (act.type) {
    case "answer": {
      if (action.id === "answer-edit") {
        const answers = asAnswers(edits.answers);
        const other = asOther(edits.other);
        if (!answers && !Object.keys(other).length) return fail(400, "edits.answers (question text → label) or edits.other is required");
        const r = p.answer({ turnId: act.turnId, toolUseId: act.toolUseId, answers: answers ?? {}, other });
        return r.ok ? { ok: true } : fail(r.status, r.error);
      }
      const r = p.answer({ turnId: act.turnId, toolUseId: act.toolUseId, answers: act.answers, other: act.other });
      return r.ok ? { ok: true } : fail(r.status, r.error);
    }
    case "confirm": {
      const r = p.confirm({ turnId: act.turnId, toolUseId: act.toolUseId, decision: action.id === "deny" ? "deny" : "allow" });
      return r.ok ? { ok: true } : fail(r.status, r.error);
    }
    case "posture":
      return p.posture({ sessionId: act.sessionId, patch: act.patch });
    case "send": {
      // ADR-0128 §4 — the text may change, never the tab or the kind; the edit is checked again here.
      let text = act.text;
      if (action.id === "edit") {
        if (typeof edits.text !== "string" || !edits.text.trim() || edits.text.length > MAX_SUPERVISOR_MESSAGE_CHARS) {
          return fail(400, `the message needs 1–${MAX_SUPERVISOR_MESSAGE_CHARS} characters`, "text");
        }
        text = edits.text.trim();
      }
      if (containsSecretShape(text)) return fail(400, "the message carries a secret-shaped string (ADR-0127 §6) — it was not sent", "secret");
      const editedByUser = text !== act.text;
      const sent = await p.send({ sessionId: act.sessionId, text, kind: act.kind, grounds: act.grounds, ledgerId: item.ledgerId, editedByUser, reopensScope: act.reopensScope === true });
      return sent.ok ? { ...sent, editedByUser } : sent;
    }
    case "cancel":
      return p.cancel(act.sessionId);
    case "worktrees":
      return p.worktrees({ op: act.op, slugs: act.slugs, push: act.push, openMergeRequest: act.openMergeRequest });
    case "close":
      return p.close({ sessionId: act.sessionId, worktree: act.worktree });
    case "guardrail": {
      if (action.id === "raise-cap") {
        const capUsd = edits.capUsd;
        if (typeof capUsd !== "number") return fail(400, "edits.capUsd is required");
        const capped = p.supervisor({ action: "cap", capUsd });
        if (!capped.ok) return fail(capped.status, capped.error);
      }
      const resumed = p.supervisor({ action: "resume" });
      return resumed.ok ? { ok: true } : fail(resumed.status, resumed.error);
    }
    case "new-tab": {
      // One request, one tab: an item for this request already opened one.
      if (listInbox(projectId).some((i) => i.id !== item.id && i.state === "resolved" && i.act?.type === "new-tab" && i.act.requestId === act.requestId)) {
        return fail(409, "that request already opened its tab — one request, one tab", "request-used");
      }
      let posture: SessionPosture = act.posture;
      if (edits.posture !== undefined) {
        const valid = validatePosturePatch(edits.posture);
        if (!valid.ok) return fail(400, valid.error);
        const widened = classifyPostureChange(act.posture, valid.patch, await p.modelLookup()).filter((c) => c.direction === "widen");
        if (widened.length) {
          return fail(409, `an edit may only narrow the posture shown: ${widened.map((c) => `${c.field} ${c.from ?? "?"} → ${c.to}`).join("; ")}`, "widening");
        }
        posture = { ...posture, ...valid.patch } as SessionPosture;
      } else if (action.id === "edit" && edits.firstMessage === undefined && edits.title === undefined) {
        return fail(400, "an edit changes the first message, the title or the posture");
      }
      const proposed = item.newTab?.firstMessage ?? "";
      let firstMessage = proposed;
      if (edits.firstMessage !== undefined) {
        if (typeof edits.firstMessage !== "string" || !edits.firstMessage.trim() || edits.firstMessage.length > MAX_SUPERVISOR_MESSAGE_CHARS) {
          return fail(400, `the first message needs 1–${MAX_SUPERVISOR_MESSAGE_CHARS} characters`);
        }
        firstMessage = edits.firstMessage.trim();
      }
      if (!firstMessage) return fail(409, "the item has no first message");
      if (containsSecretShape(firstMessage)) return fail(400, "the first message carries a secret-shaped string (ADR-0127 §6)");
      const title = typeof edits.title === "string" ? edits.title.trim().slice(0, 120) : act.title;
      const opened = await p.openTab({ firstMessage, ...(title ? { title } : {}), posture, grounds: act.grounds, ledgerId: item.ledgerId, editedByUser: firstMessage !== proposed });
      return opened.ok ? { ok: true, marvinSessionId: opened.marvinSessionId } : opened;
    }
    default:
      return fail(409, "unknown act");
  }
}

/** The user acts on an item. */
export async function actOnInboxItem(projectId: string, req: InboxActionRequest, p: InboxPerform): Promise<InboxActionResult> {
  const item = getInboxItem(projectId, req.id);
  if (!item) return fail(404, "no inbox item with that id");
  if (item.state !== "open") return fail(409, `the item is already ${item.state}${item.resolvedBy ? ` (by ${item.resolvedBy})` : ""}`);
  // One act per item: a second click while the first is performing must not perform it twice (two tabs for one request).
  if (isInboxInFlight(item.id)) return fail(409, "this item is being acted on right now", "in-flight");
  const action = actionsFor(item).find((a) => a.id === req.actionId);
  if (!action) return fail(400, `this item offers ${actionsFor(item).map((a) => a.id).join(", ")}`);
  const edits = req.edits && typeof req.edits === "object" && !Array.isArray(req.edits) ? req.edits : {};

  if (action.role === "dismiss") {
    const settled = settleInboxItem(projectId, item.id, { state: "dismissed", resolvedBy: "user" });
    if (!settled) return fail(409, "the item was settled a moment ago");
    note(projectId, item, action);
    return { ok: true, item: settled, outcome: {} };
  }

  // The confirm this performs resolves inside it; the item is the user's to settle, not the tab's.
  markInboxInFlight(item.id, true);
  try {
    const done = await perform(projectId, item, action, edits, p);
    if (!done.ok) return done;
    const settled = settleInboxItem(projectId, item.id, { state: "resolved", resolvedBy: "user" }) ?? getInboxItem(projectId, item.id) ?? item;
    note(projectId, item, action, done.marvinSessionId, done.editedByUser === true);
    return { ok: true, item: settled, outcome: { ...(done.message ? { message: done.message } : {}), ...(done.marvinSessionId ? { marvinSessionId: done.marvinSessionId } : {}) } };
  } finally {
    markInboxInFlight(item.id, false);
  }
}

/** The user's act, ledgered (`actor: "user"` in the read shape). */
function note(projectId: string, item: InboxRecord, action: InboxAction, openedSessionId?: string, editedByUser = false): void {
  try {
    appendLedgerEntry(projectId, {
      kind: "inbox",
      verb: `inbox.${action.role}`,
      tab: item.sessionId ?? openedSessionId ?? null,
      wakeId: null,
      reason: `user: ${action.label} — ${item.rawAct?.summary ?? item.kind}${openedSessionId ? ` (opened tab ${openedSessionId})` : ""}`,
      reasonCode: action.id,
      ...(item.rawAct ? { argsDigest: item.rawAct.digest, argSummary: item.rawAct.summary } : {}),
      inboxItemId: item.id,
      ...(editedByUser ? { editedByUser: true } : {}),
    });
  } catch {
    /* the act happened; only its line is lost */
  }
}
