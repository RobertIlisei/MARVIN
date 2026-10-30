/**
 * `marvin-supervise` — the supervisor's only acting surface (ADR-0127 §2).
 *
 * Milestone 1 ships three verbs:
 *   - `sessions` — the tabs the user delegated, with what each is waiting on;
 *   - `read`     — a delegated tab's pending question, transcript tail, plan,
 *                  or this supervisor's ledger for it (tab content wrapped as
 *                  untrusted data);
 *   - `answer`   — a proposed answer to a pending AskUserQuestion, or an
 *                  escalation of it. Evaluated by the policy and ledgered;
 *                  in shadow mode it performs NOTHING. This module imports no
 *                  function that could resolve a confirm.
 *
 * Milestone 2 adds `set_posture`; milestone 3 adds `send`, `cancel` and
 * `confirm` — evaluated and ledgered, performing nothing. `confirm` refuses
 * any confirm only the user may answer (a supervisor-touched turn, ADR-0127
 * §5). The remaining verbs (`worktrees`, `close_session`, `new_session`)
 * arrive with milestone 5.
 *
 * Milestone 4 — a verb PERFORMS when the user switched its category to
 * autonomous: `answer` (questions), `send` and `cancel` (nudges),
 * `set_posture` (posture). `confirm` stays shadow until milestone 5. The
 * performing functions are injected (`VerbDeps.perform`): this module still
 * imports nothing that resolves a confirm, starts a turn or changes a
 * posture. An act's ledger line is named before it is performed, so the
 * transcript can cite it; a perform that fails is ledgered as a refusal.
 *
 * Milestone 5 — `confirm` performs for `answer-confirms` tabs once the user
 * switches confirms to autonomous, for the gated strategy's ordinary card
 * only. Every escalation becomes an inbox item (`supervisor-inbox.ts`) that
 * shows the raw act beside the recommendation. New verbs: `worktrees` (list,
 * preview, a safe sweep performed; merge / merge-all / Prepare MR / drop
 * escalated), `close_session` (escalated), `review_scope` (the scope-met
 * trigger's answer, escalated), `new_session` (only on a user request,
 * escalated — the user's confirmation opens the tab) and `reply`.
 *
 * Registered only in the supervisor session; the executor gate denies the
 * server's tools everywhere else (`@marvin/tools/policy`).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { getPendingConfirm } from "./confirm-registry";
import { classifyPostureChange, type ModelLookup, type PosturePatch, validatePosturePatch } from "./posture";
import { containsSecretShape } from "./session";
import type { SessionPosture } from "./session-meta";
import type { SessionWatchRow } from "./session-watch";
import { classifyHumanOnlyAct } from "./supervisor-acts";
import {
  addInboxItem,
  buildRawAct,
  type EscalationCode,
  type InboxDraft,
  type InboxKind,
  listInbox,
  type MergePreview,
} from "./supervisor-inbox";
import {
  appendLedgerEntry,
  capAnswer,
  digestArgs,
  type LedgerDecision,
  type LedgerEntryInput,
  type LedgerGround,
  newLedgerId,
  readLedger,
} from "./supervisor-ledger";
import {
  type ActionLimiter,
  evaluateAnswer,
  evaluateCancel,
  evaluateConfirm,
  evaluateSend,
  evaluateSetPosture,
  type GroundContext,
  type GroundRef,
  type PolicyOutcome,
  questionHeuristic,resolveGround 
} from "./supervisor-policy";
import { wrapUntrusted } from "./supervisor-prompt";
import { MAX_SUPERVISOR_MESSAGE_CHARS } from "./supervisor-send";
import { categoryMode, getSupervisorState, isSupervisorSessionId, overBudget, type SupervisorMode } from "./supervisor-state";
import { isUserOnlyConfirm } from "./supervisor-touch";

export const SUPERVISE_SERVER_NAME = "marvin-supervise";
export const SUPERVISE_TOOL_NAMES = [
  "sessions",
  "read",
  "answer",
  "set_posture",
  "send",
  "cancel",
  "confirm",
  "worktrees",
  "close_session",
  "review_scope",
  "new_session",
  "reply",
] as const;

type Performed = { ok: true } | { ok: false; code?: string; error: string };

/**
 * What an autonomous verb performs through (milestone 4). Injected so this
 * module imports no function that resolves a confirm, starts a turn or
 * changes a posture; the runtime wires the milestone 2 and 3 services.
 */
export interface VerbPerform {
  /** `answerQuestion` with `answeredBy: "supervisor"` — it touches the turn. */
  answer(a: {
    turnId: string;
    toolUseId: string;
    answers: Record<string, string | string[]>;
    other: Record<string, string>;
    grounds: LedgerGround[];
    ledgerId: string;
  }): { ok: true } | { ok: false; error: string };
  /** `sendAsSupervisor` — the turn it starts is the supervisor's and touched. */
  send(m: { projectId: string; marvinSessionId: string; text: string; kind: "nudge" | "instruction"; grounds: LedgerGround[]; ledgerId: string }): Promise<{ ok: true; queued: boolean } | { ok: false; code: string; reason: string }>;
  /** Stop the tab's live turn. False when there was none. */
  cancel(marvinSessionId: string): boolean;
  /** `applyPostureChange` with `actor: "supervisor"`; the verb ledgers, so the service does not. */
  setPosture(a: { marvinSessionId: string; patch: PosturePatch; grounds: LedgerGround[] }): Promise<Performed>;
  /** Milestone 5 — `resolveConfirm` with `answeredBy: "supervisor"`: an ordinary confirm only; it touches the turn. */
  confirm(a: { turnId: string; toolUseId: string; decision: "allow" | "deny"; message?: string | undefined; grounds: LedgerGround[]; ledgerId: string }): { ok: true } | { ok: false; error: string };
}

/** One worktree as the `worktrees` verb lists it (milestone 5). */
export interface WorktreeListing {
  slug: string;
  branch: string;
  state: string;
  sessionId?: string | undefined;
  commits: number;
  dirty: boolean;
}

/** What the verbs read, injected so tests run on fixtures and the runtime on the real stores. */
export interface VerbDeps {
  listRows(): Promise<SessionWatchRow[]>;
  getPending: typeof getPendingConfirm;
  readTranscriptTail(marvinSessionId: string): string;
  readBrief(marvinSessionId: string): string | null;
  tabStartedAt(marvinSessionId: string): number | null;
  readPlanText(marvinSessionId: string): string;
  /** What models cost, for telling a narrowing from a widening (milestone 2). */
  modelLookup(): Promise<ModelLookup>;
  /** Why the tab cannot take a message now (stopped, waiting on its own job, busy shared checkout), or null (milestone 3). */
  sendRefusal(marvinSessionId: string): { code: string; reason: string } | null;
  /** The tab closed its scope and nothing has reopened it (`scopeMetAt`, milestone 4). */
  scopeMet(marvinSessionId: string): boolean;
  /*
   * Milestone 5. Optional so a fixture that predates them still builds; an
   * absent one makes its verb refuse, never act.
   */
  /** When that scope-met close happened; one close item per value. */
  scopeMetAt?(marvinSessionId: string): string | null;
  /** A model's display name, for the new-tab card. */
  modelLabel?(model: string): Promise<string>;
  /** The project's worktrees: list and preview live, sweep performed (what `worktree_sweep` reclaims). */
  worktrees?: {
    list(): Promise<WorktreeListing[]>;
    preview(slugs: string[] | null): Promise<MergePreview | null>;
    sweep(): Promise<Array<{ slug: string; branch: string; deletedBranch: boolean; reason: string }>>;
  };
  /** Milestone 5 — a message the user wrote to the supervisor (`POST /api/supervisor/message`): the only request `new_session` accepts. */
  userRequest?(id: string): { id: string; at: string; text: string } | null;
  /** The posture and base a new tab would start from: the user's most recent tab, and the main checkout's HEAD. */
  newTabBase?(): Promise<{ posture: SessionPosture; baseRef: string | null; baseSha: string | null } | null>;
  /** The supervisor's reply in its conversation with the user (milestone 5). Optional: a wake with no conversation has none. */
  postReply?(text: string): void;
  perform: VerbPerform;
}

export interface VerbContext {
  projectId: string;
  /** The project root — the main checkout grounds resolve against. */
  workDir: string;
  wakeId: string | null;
  /** Act verbs invoked in this wake, for the per-wake breaker. */
  wake: { acts: number };
  limiter: ActionLimiter;
  deps: VerbDeps;
}

export interface AnswerArgs {
  marvinSessionId: string;
  toolUseId: string;
  /** Full question text → chosen option label(s). */
  answers?: Record<string, string | string[]>;
  /** Full question text → free-text "Other" answer. */
  other?: Record<string, string>;
  grounds?: GroundRef[];
  escalate?: { reason: string; recommendation?: string };
}

export interface SetPostureArgs {
  marvinSessionId: string;
  posture: PosturePatch;
  grounds?: GroundRef[];
}

export interface SendArgs {
  marvinSessionId: string;
  message: string;
  kind: "nudge" | "instruction";
  grounds?: GroundRef[];
}

export interface CancelArgs {
  marvinSessionId: string;
  reason: string;
  grounds?: GroundRef[];
}

export interface ConfirmArgs {
  marvinSessionId: string;
  toolUseId: string;
  decision: "allow" | "deny";
  message?: string;
  grounds?: GroundRef[];
}

export interface WorktreesArgs {
  op: "list" | "preview" | "sweep" | "merge" | "merge-all" | "prepare-mr" | "drop";
  slugs?: string[];
  push?: boolean;
  openMergeRequest?: boolean;
  recommendation?: string;
  grounds?: GroundRef[];
}

export interface CloseSessionArgs {
  marvinSessionId: string;
  worktree: "keep" | "merge" | "discard";
  recommendation?: string;
  grounds?: GroundRef[];
}

export interface ReviewScopeArgs {
  marvinSessionId: string;
  verdict: "ready" | "missing";
  text: string;
  grounds?: GroundRef[];
}

export interface NewSessionArgs {
  requestId: string;
  firstMessage: string;
  title?: string;
  posture?: PosturePatch;
  /** Only "worktree" is accepted: a new tab never runs in the shared checkout or an existing tree. */
  tree?: string;
  recommendation?: string;
  grounds?: GroundRef[];
}

export interface ReadArgs {
  marvinSessionId: string;
  what: "question" | "transcript" | "plan" | "ledger";
  toolUseId?: string;
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      question: String(q.question ?? ""),
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .map((o) => ({ label: String(o.label ?? ""), ...(typeof o.description === "string" ? { description: o.description } : {}) })),
    }));
}

/** Null when the answer fits the question; otherwise why not. */
function validateAnswers(qs: Question[], answers: Record<string, string | string[]>, other: Record<string, string>): string | null {
  const known = new Map(qs.map((q) => [q.question, q]));
  const keys = [...new Set([...Object.keys(answers), ...Object.keys(other)])];
  if (keys.length === 0) return "no answer given";
  for (const k of keys) {
    const q = known.get(k);
    if (!q) return `"${k.slice(0, 80)}" is not one of the pending questions`;
    const picked = answers[k] === undefined ? [] : Array.isArray(answers[k]) ? (answers[k] as string[]) : [answers[k] as string];
    const free = other[k];
    if (free !== undefined && (typeof free !== "string" || !free.trim() || free.length > 2_000)) return `the "Other" answer to "${k.slice(0, 80)}" must be 1–2000 characters`;
    if (!q.multiSelect && picked.length + (free !== undefined ? 1 : 0) > 1) return `"${k.slice(0, 80)}" takes one answer`;
    for (const label of picked) {
      if (!q.options.some((o) => o.label === label)) {
        return `"${label}" is not an option of "${k.slice(0, 80)}" (options: ${q.options.map((o) => o.label).join(", ")})`;
      }
    }
  }
  return null;
}

/** The labels an answer picks, per question in question order — exactly what `buildAnswerInput` will write, unannotated. */
function answerValues(qs: Question[], answers: Record<string, string | string[]>, other: Record<string, string>): string[] {
  return qs.map((q) => {
    const raw = answers[q.question];
    const picked = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const parts = q.options.map((o) => o.label).filter((l) => picked.includes(l));
    const free = typeof other[q.question] === "string" ? (other[q.question] as string).trim() : "";
    if (free) parts.push(free);
    return parts.join(",");
  });
}

/** An inbox draft as a verb builds it; the runtime adds the mode, wake and ledger link. */
type ItemDraft = Omit<InboxDraft, "modeAtCreation" | "wakeId" | "ledgerId" | "id">;

/** A policy reason code as the inbox's `escalatedBecause.code` (brief §10.2). */
function escalationCode(reasonCode: string | undefined): EscalationCode {
  switch (reasonCode) {
    case "heuristic":
    case "nudge-cap":
    case "weak-grounds-only":
    case "ungrounded":
    case "unresolvable-citation":
      return reasonCode;
    default:
      return "human-only";
  }
}

/** Which card a confirm escalation is: the act it would perform, or the rule that raised it. */
function confirmKind(raisedBy: string | null, act: { item: string } | null): InboxKind {
  if (act) return act.item === "external-mcp" ? "confirm" : (act.item as InboxKind);
  if (raisedBy === "metered-ci") return "integration";
  if (raisedBy === "shared-tree" || raisedBy === "lane" || raisedBy === "session-worktree") return "containment";
  return "confirm";
}

const REPLY: Record<LedgerDecision, (reason: string) => string> = {
  propose: () =>
    "Recorded as a proposal (shadow mode). Nothing was answered — the question stays pending for the user, and your proposal is compared with their answer later.",
  act: () => "Answered (the questions category is autonomous). The tab reads the answer as yours, not the user's, and this turn is now supervisor-touched.",
  escalate: (r) => `Escalated to the user: ${r}. The question stays pending for them.`,
  refuse: (r) => `Refused: ${r}.`,
  drop: (r) => `Dropped: ${r}.`,
};

export function createSupervisorVerbs(ctx: VerbContext) {
  const { projectId } = ctx;

  const visible = (id: string) => !isSupervisorSessionId(id) && !!getSupervisorState(projectId).delegation[id];

  /**
   * Milestone 5 — an escalation is an inbox item. The line and the item name
   * each other: both ids are chosen first, and an item that already exists
   * for the same cause (its `dedupeKey`) is cited rather than duplicated.
   */
  function raise(draft: ItemDraft, mode: SupervisorMode, ledgerId: string): string {
    return addInboxItem(projectId, { ...draft, modeAtCreation: mode === "autonomous" ? "autonomous" : "shadow", wakeId: ctx.wakeId, ledgerId }).id;
  }

  /**
   * Read again at the moment of acting: a pause, a kill or the budget cap
   * reached during this wake stops every act that has not happened yet (§6).
   * Null when the act may go ahead.
   */
  function actHold(): { reasonCode: string; reason: string } | null {
    const now = getSupervisorState(projectId);
    if (now.mode === "off") return { reasonCode: "off", reason: "the supervisor was turned off during this wake; nothing was performed" };
    if (now.paused) {
      return now.pause?.reason === "budget"
        ? { reasonCode: "budget", reason: "the daily cap was reached during this wake; nothing was performed" }
        : { reasonCode: "paused", reason: "the supervisor was paused during this wake; nothing was performed" };
    }
    if (overBudget(now)) return { reasonCode: "budget", reason: "the daily cap was reached during this wake; nothing was performed" };
    return null;
  }

  async function sessions(): Promise<string> {
    const st = getSupervisorState(projectId);
    const rows = await ctx.deps.listRows();
    const out = rows
      .filter((r) => visible(r.marvinSessionId))
      .map((r) => ({
        marvinSessionId: r.marvinSessionId,
        title: r.title,
        delegation: st.delegation[r.marvinSessionId],
        state: r.state,
        pending: r.pending.map((p) => ({
          turnId: p.turnId,
          toolUseId: p.toolUseId,
          toolName: p.toolName,
          raisedBy: p.raisedBy ?? null,
          excerpt: p.excerpt ?? null,
          since: p.since,
        })),
        plan: r.plan,
        lastTurn: r.lastTurn ? r.lastTurn.outcome : null,
      }));
    return JSON.stringify(out, null, 2);
  }

  async function read(args: ReadArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    if (!visible(tab)) return `Refused: tab ${tab} is not delegated to you (or is a supervisor session).`;
    switch (args.what) {
      case "question": {
        const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
        const p = row?.turn && args.toolUseId ? ctx.deps.getPending(row.turn.turnId, args.toolUseId) : null;
        if (!p || p.raisedBy !== "ask-user-question") return `No pending question ${args.toolUseId ?? "(none given)"} on tab ${tab}.`;
        return wrapUntrusted("question", tab, JSON.stringify(parseQuestions(p.originalInput), null, 2));
      }
      case "transcript":
        return wrapUntrusted("transcript", tab, ctx.deps.readTranscriptTail(tab));
      case "plan": {
        const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
        const head = row?.plan
          ? `${row.plan.total} step(s), ${row.plan.done} done, ${row.plan.seeded ? "seeded from the user's brief" : "presented by the tab"}`
          : "no plan";
        return `${head}\n${wrapUntrusted("plan", tab, ctx.deps.readPlanText(tab))}`;
      }
      case "ledger": {
        const lines = readLedger(projectId, { tab, limit: 20 }).map(
          (e) => `- ${e.at} ${e.kind}/${e.verb}${e.decision ? ` → ${e.decision}` : ""}: ${e.reason}`,
        );
        return lines.length ? lines.join("\n") : "(no ledger entries for this tab)";
      }
      default:
        return "Refused: `what` must be question, transcript, plan or ledger.";
    }
  }

  async function answer(args: AnswerArgs): Promise<string> {
    const st = getSupervisorState(projectId);
    const tab = String(args.marvinSessionId ?? "").trim();
    const toolUseId = String(args.toolUseId ?? "").trim();
    const argsDigest = digestArgs({ toolUseId, answers: args.answers ?? {}, other: args.other ?? {}, escalate: args.escalate ?? null });
    const mode = categoryMode(st, "questions");
    let target: Pick<LedgerEntryInput, "turnId" | "toolUseId" | "answer"> = {};
    const log = (decision: LedgerDecision, reason: string, extra: { grounds?: LedgerGround[]; heuristic?: string; reasonCode?: string; id?: string; inboxItemId?: string } = {}) => {
      appendLedgerEntry(projectId, {
        ...(extra.id ? { id: extra.id } : {}),
        ...(extra.inboxItemId ? { inboxItemId: extra.inboxItemId } : {}),
        kind: "verb",
        verb: "answer",
        ...(extra.reasonCode ? { reasonCode: extra.reasonCode } : {}),
        tab: tab || null,
        wakeId: ctx.wakeId,
        mode: mode === "off" ? st.mode : mode,
        decision,
        reason,
        argsDigest,
        grounds: extra.grounds ?? [],
        ...(extra.heuristic ? { heuristic: extra.heuristic } : {}),
        ...target,
      });
      return REPLY[decision](reason);
    };

    if (isSupervisorSessionId(tab)) return log("refuse", "a supervisor session is never a target (no recursion)");
    const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
    if (!row) return log("refuse", `no open tab ${tab}`);
    const pending = row.turn && toolUseId ? ctx.deps.getPending(row.turn.turnId, toolUseId) : null;
    if (!pending || pending.raisedBy !== "ask-user-question") {
      const why = pending ? ` — that confirm was raised by the ${pending.raisedBy ?? "unknown"} rule, not a question` : "";
      return log("refuse", `no pending question ${toolUseId} on tab ${tab}${why}`);
    }
    const questions = parseQuestions(pending.originalInput);
    target = { ...(row.turn ? { turnId: row.turn.turnId } : {}), toolUseId };
    if (!args.escalate) {
      const bad = validateAnswers(questions, args.answers ?? {}, args.other ?? {});
      if (bad) return log("refuse", bad);
      // ADR-0127 §6 — secret hygiene on answer text.
      if (Object.values(args.other ?? {}).some((t) => typeof t === "string" && containsSecretShape(t))) {
        return log("refuse", "the answer carries a secret-shaped string (ADR-0127 §6)", { reasonCode: "secret" });
      }
      target.answer = capAnswer(answerValues(questions, args.answers ?? {}, args.other ?? {}));
    }
    const key = `answer:${toolUseId}`;
    const gate = ctx.limiter.check(projectId, tab, key, ctx.wake.acts);
    if (!gate.ok) return log("drop", gate.reason);
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, tab, key);

    const outcome = evaluateAnswer({
      mode,
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      // The supervisor's own "Other" text too: an answer can name a §4 act the question did not.
      questionTexts: [
        ...questions.flatMap((q) => [q.question, q.header ?? "", ...q.options.flatMap((o) => [o.label, o.description ?? ""])]),
        ...Object.values(args.other ?? {}).filter((t): t is string => typeof t === "string"),
      ],
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: {
        mainRoot: ctx.workDir,
        tabRoot: row.tree.mode === "worktree" ? row.tree.path : null,
        charter: st.charter,
        brief: ctx.deps.readBrief(tab),
        planStepCount: row.plan?.total ?? 0,
        planSeeded: row.plan?.seeded ?? false,
        tabStartedAt: ctx.deps.tabStartedAt(tab),
      },
      ...(args.escalate ? { escalate: { reason: String(args.escalate.reason ?? "").slice(0, 500) } } : {}),
    });
    const rec = args.escalate?.recommendation ? ` — recommendation: ${String(args.escalate.recommendation).slice(0, 500)}` : "";
    if (outcome.decision === "act" && row.turn) {
      const hold = actHold();
      if (hold) return log("refuse", hold.reason, { grounds: outcome.grounds, reasonCode: hold.reasonCode });
      // Named before it is performed, so the transcript's `confirm.decision` can cite it.
      const id = newLedgerId();
      const done = ctx.deps.perform.answer({
        turnId: row.turn.turnId,
        toolUseId,
        answers: args.answers ?? {},
        other: args.other ?? {},
        grounds: outcome.grounds,
        ledgerId: id,
      });
      if (!done.ok) return log("refuse", `could not answer: ${done.error}`, { grounds: outcome.grounds, reasonCode: "perform-failed", id });
      return log("act", outcome.reason, { grounds: outcome.grounds, id });
    }
    if (outcome.decision === "escalate" && row.turn) {
      // Milestone 5 — the question waits for the user as an inbox item, with the proposed answer beside it.
      const id = newLedgerId();
      const code: EscalationCode = outcome.heuristic ? "heuristic" : args.escalate ? "ungrounded" : "weak-grounds-only";
      const proposed = args.escalate ? undefined : args.answers;
      const inboxItemId = raise(
        {
          sessionId: tab,
          tabTitle: row.title ?? null,
          kind: "question",
          escalatedBecause: { code, label: outcome.reason.slice(0, 200) },
          heuristic: outcome.heuristic ? { matched: outcome.heuristic } : null,
          question: { questions: Array.isArray(pending.originalInput.questions) ? (pending.originalInput.questions as unknown[]) : [] },
          linkedConfirm: { sessionId: tab, turnId: row.turn.turnId, toolUseId, raisingRule: "ask-user-question" },
          recommendation: {
            actionId: "answer",
            ...(proposed && Object.keys(proposed).length ? { answer: proposed } : {}),
            text: String(args.escalate?.recommendation ?? args.escalate?.reason ?? outcome.reason),
          },
          grounds: outcome.grounds,
          act: { type: "answer", turnId: row.turn.turnId, toolUseId, answers: args.answers ?? {}, other: args.other ?? {} },
        },
        mode,
        id,
      );
      return log("escalate", `${outcome.reason}${rec}`, { grounds: outcome.grounds, ...(outcome.heuristic ? { heuristic: outcome.heuristic } : {}), id, inboxItemId });
    }
    return log(outcome.decision, `${outcome.reason}${rec}`, {
      grounds: outcome.grounds,
      ...(outcome.heuristic ? { heuristic: outcome.heuristic } : {}),
    });
  }

  /** Milestone 2 — a narrowing is proposed, a widening escalates; in shadow nothing changes. */
  async function set_posture(args: SetPostureArgs): Promise<string> {
    const st = getSupervisorState(projectId);
    const tab = String(args.marvinSessionId ?? "").trim();
    const argsDigest = digestArgs({ posture: args.posture ?? {} });
    const mode = categoryMode(st, "posture");
    const log = (decision: LedgerDecision, reason: string, grounds: LedgerGround[] = [], reasonCode?: string, link: { id?: string; inboxItemId?: string } = {}) => {
      appendLedgerEntry(projectId, {
        ...link,
        kind: "verb",
        verb: "set_posture",
        tab: tab || null,
        wakeId: ctx.wakeId,
        mode: mode === "off" ? st.mode : mode,
        decision,
        reason,
        ...(reasonCode ? { reasonCode } : {}),
        argsDigest,
        grounds,
      });
      if (decision === "propose") return "Recorded as a proposal (shadow mode). The tab's posture is unchanged; your proposal is compared with what the user does later.";
      if (decision === "act") return "Narrowed (the posture category is autonomous). It applies from the tab's next tool call.";
      return REPLY[decision](reason);
    };
    if (isSupervisorSessionId(tab)) return log("refuse", "a supervisor session is never a target (no recursion)");
    const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
    if (!row?.posture) return log("refuse", `no open tab ${tab} with a recorded posture`);
    const valid = validatePosturePatch(args.posture);
    if (!valid.ok) return log("refuse", valid.error);
    const key = `set_posture:${argsDigest}`;
    const gate = ctx.limiter.check(projectId, tab, key, ctx.wake.acts);
    if (!gate.ok) return log("drop", gate.reason);
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, tab, key);
    const lookup = await ctx.deps.modelLookup();
    const outcome = evaluateSetPosture({
      mode,
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      from: row.posture,
      patch: valid.patch,
      lookup,
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: groundContextFor(row, st.charter),
    });
    if (outcome.decision === "act") {
      const hold = actHold();
      if (hold) return log("refuse", hold.reason, outcome.grounds, hold.reasonCode);
      // The service re-classifies against the stored posture, so a widening
      // that slipped in since the row was read is refused there too.
      const done = await ctx.deps.perform.setPosture({ marvinSessionId: tab, patch: valid.patch, grounds: outcome.grounds });
      if (!done.ok) return log("refuse", `could not change posture: ${done.error}`, outcome.grounds, done.code ?? "perform-failed");
    }
    if (outcome.decision === "escalate") {
      const changes = classifyPostureChange(row.posture, valid.patch, lookup);
      const widened = changes.filter((c) => c.direction === "widen").map((c) => c.field);
      const pick = (side: "from" | "to") => Object.fromEntries(changes.map((c) => [c.field, c[side] ?? null]));
      const id = newLedgerId();
      const inboxItemId = raise(
        {
          sessionId: tab,
          tabTitle: row.title ?? null,
          kind: widened.length ? "posture-widen" : "scope",
          escalatedBecause: widened.length
            ? { code: "human-only", label: "Widening a tab's posture is the user's act", rule: "§4.5 posture" }
            : { code: "weak-grounds-only", label: outcome.reason.slice(0, 200) },
          rawAct: buildRawAct("set_posture", { marvinSessionId: tab, posture: valid.patch }),
          postureChange: { from: pick("from"), to: pick("to"), widenedDimensions: widened },
          recommendation: { actionId: "perform", text: outcome.reason },
          grounds: outcome.grounds,
          act: { type: "posture", sessionId: tab, patch: valid.patch },
        },
        mode,
        id,
      );
      return log("escalate", outcome.reason, outcome.grounds, outcome.reasonCode, { id, inboxItemId });
    }
    return log(outcome.decision, outcome.reason, outcome.grounds, outcome.reasonCode);
  }

  function groundContextFor(row: SessionWatchRow, charter: string): GroundContext {
    return {
      mainRoot: ctx.workDir,
      tabRoot: row.tree.mode === "worktree" ? row.tree.path : null,
      charter,
      brief: ctx.deps.readBrief(row.marvinSessionId),
      planStepCount: row.plan?.total ?? 0,
      planSeeded: row.plan?.seeded ?? false,
      tabStartedAt: ctx.deps.tabStartedAt(row.marvinSessionId),
    };
  }

  const CATEGORY = { send: "nudges", cancel: "nudges", confirm: "confirms" } as const;

  /** Ledger a milestone 3 verb's outcome and reply to the model. */
  function settle(
    verb: "send" | "cancel" | "confirm",
    tab: string,
    argsDigest: string,
    o: PolicyOutcome,
    extra: { planSignature?: string; id?: string } & Pick<LedgerEntryInput, "turnId" | "toolUseId" | "answer"> = {},
    /** Milestone 5 — what the inbox item shows when this escalates. */
    item?: () => ItemDraft,
  ): string {
    const st = getSupervisorState(projectId);
    const mode = categoryMode(st, CATEGORY[verb]);
    const { planSignature, ...rest } = extra;
    let link: { id?: string; inboxItemId?: string } = {};
    if (o.decision === "escalate" && item) {
      const id = rest.id ?? newLedgerId();
      link = { id, inboxItemId: raise(item(), mode, id) };
    }
    appendLedgerEntry(projectId, {
      ...rest,
      ...link,
      kind: "verb",
      verb,
      tab: tab || null,
      wakeId: ctx.wakeId,
      mode: mode === "off" ? st.mode : mode,
      decision: o.decision,
      reason: o.reason,
      ...(o.reasonCode ? { reasonCode: o.reasonCode } : {}),
      argsDigest,
      grounds: o.grounds,
      ...(o.heuristic ? { heuristic: o.heuristic } : {}),
      ...(planSignature ? { planSignature } : {}),
    });
    if (o.decision === "act") {
      if (verb === "confirm") return `${rest.answer?.[0] === "deny" ? "Denied" : "Allowed"} (the confirms category is autonomous). The tab reads it as yours, and this turn is now supervisor-touched.`;
      return verb === "send"
        ? "Sent (the nudges category is autonomous). It reaches the tab marked as yours, after any live turn ends."
        : "Cancelled the tab's running turn (the nudges category is autonomous).";
    }
    if (o.decision !== "propose") return REPLY[o.decision](o.reason);
    const what = { send: "Nothing was sent", cancel: "Nothing was cancelled", confirm: "Nothing was answered — the confirm stays pending for the user" }[verb];
    return `Recorded as a proposal (shadow mode). ${what}; your proposal is compared with what the user does later.`;
  }

  const refused = (reasonCode: string, reason: string): PolicyOutcome => ({ decision: "refuse", reason, reasonCode, grounds: [] });

  /** Rate limits and the per-wake breaker, shared by every act verb. Null when the act may be evaluated. */
  function limited(tab: string, key: string): PolicyOutcome | null {
    const gate = ctx.limiter.check(projectId, tab, key, ctx.wake.acts);
    if (!gate.ok) return { decision: "drop", reason: gate.reason, reasonCode: "rate-limit", grounds: [] };
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, tab, key);
    return null;
  }

  async function rowFor(tab: string): Promise<SessionWatchRow | null> {
    if (isSupervisorSessionId(tab)) return null;
    return (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab) ?? null;
  }

  /** Milestone 3 — a message to a tab, proposed; in shadow nothing is sent. */
  async function send(args: SendArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    const kind = args.kind === "nudge" ? "nudge" : "instruction";
    const message = String(args.message ?? "");
    const argsDigest = digestArgs({ kind, message });
    if (isSupervisorSessionId(tab)) return settle("send", tab, argsDigest, refused("supervisor-session", "a supervisor session is never a target (no recursion)"));
    const row = await rowFor(tab);
    if (!row) return settle("send", tab, argsDigest, refused("no-tab", `no open tab ${tab}`));
    const planSignature = kind === "nudge" ? (row.plan ? `${row.plan.done}/${row.plan.total}@${row.plan.lastTodoAt ?? "-"}` : "no-plan") : undefined;
    const drop = limited(tab, `send:${argsDigest}`);
    if (drop) return settle("send", tab, argsDigest, drop, planSignature ? { planSignature } : {});
    // Counted from the ledger, not memory, so a restart does not reset the cap (§6).
    const priorNudgesAtStep = planSignature
      ? readLedger(projectId, { tab, limit: 200 }).filter((e) => e.verb === "send" && e.planSignature === planSignature && (e.decision === "propose" || e.decision === "act")).length
      : 0;
    const st = getSupervisorState(projectId);
    const outcome = evaluateSend({
      mode: categoryMode(st, "nudges"),
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      kind,
      tabRefusal: ctx.deps.sendRefusal(tab),
      scopeMet: ctx.deps.scopeMet(tab),
      secret: containsSecretShape(message),
      heuristic: questionHeuristic([message]),
      priorNudgesAtStep,
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: groundContextFor(row, st.charter),
    });
    const sig = planSignature ? { planSignature } : {};
    const sendItem = (): ItemDraft => ({
      sessionId: tab,
      tabTitle: row.title ?? null,
      kind: "scope",
      escalatedBecause: { code: escalationCode(outcome.reasonCode), label: outcome.reason.slice(0, 200) },
      heuristic: outcome.heuristic ? { matched: outcome.heuristic } : null,
      rawAct: buildRawAct("send", { marvinSessionId: tab, message, kind }),
      recommendation: { actionId: "perform", text: outcome.reason },
      grounds: outcome.grounds,
      act: { type: "send", sessionId: tab, text: message, kind, grounds: outcome.grounds },
    });
    if (outcome.decision === "act") {
      const hold = actHold();
      if (hold) return settle("send", tab, argsDigest, { ...outcome, decision: "refuse", ...hold }, sig);
      const id = newLedgerId();
      const sent = await ctx.deps.perform.send({ projectId, marvinSessionId: tab, text: message, kind, grounds: outcome.grounds, ledgerId: id });
      if (!sent.ok) return settle("send", tab, argsDigest, { ...outcome, decision: "refuse", reasonCode: sent.code, reason: `could not send: ${sent.reason}` }, { ...sig, id });
      return settle("send", tab, argsDigest, outcome, { ...sig, id });
    }
    return settle("send", tab, argsDigest, outcome, sig, sendItem);
  }

  /** Milestone 3 — stop a runaway turn, proposed; in shadow nothing is cancelled. */
  async function cancel(args: CancelArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    const argsDigest = digestArgs({ reason: String(args.reason ?? "").slice(0, 500) });
    if (isSupervisorSessionId(tab)) return settle("cancel", tab, argsDigest, refused("supervisor-session", "a supervisor session is never a target (no recursion)"));
    const row = await rowFor(tab);
    if (!row) return settle("cancel", tab, argsDigest, refused("no-tab", `no open tab ${tab}`));
    const drop = limited(tab, `cancel:${row.turn?.turnId ?? "none"}`);
    if (drop) return settle("cancel", tab, argsDigest, drop);
    const st = getSupervisorState(projectId);
    const outcome = evaluateCancel({
      mode: categoryMode(st, "nudges"),
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      hasLiveTurn: !!row.turn,
      turn: row.turn ? { kind: row.turn.kind, author: row.turn.author, mutated: row.turn.mutated } : null,
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: groundContextFor(row, st.charter),
    });
    if (outcome.decision === "act") {
      const hold = actHold();
      if (hold) return settle("cancel", tab, argsDigest, { ...outcome, decision: "refuse", ...hold });
    }
    if (outcome.decision === "act" && !ctx.deps.perform.cancel(tab)) {
      return settle("cancel", tab, argsDigest, { ...outcome, decision: "refuse", reasonCode: "no-live-turn", reason: "the turn ended before it could be cancelled" });
    }
    return settle("cancel", tab, argsDigest, outcome, {}, () => ({
      sessionId: tab,
      tabTitle: row.title ?? null,
      kind: "scope",
      escalatedBecause: { code: escalationCode(outcome.reasonCode), label: outcome.reason.slice(0, 200) },
      rawAct: buildRawAct("cancel", { marvinSessionId: tab }),
      recommendation: { actionId: "perform", text: String(args.reason ?? "").slice(0, 500) },
      grounds: outcome.grounds,
      act: { type: "cancel", sessionId: tab },
    }));
  }

  /** Milestone 3 — an ordinary confirm, proposed; never one only the user may answer. In shadow nothing resolves. */
  async function confirm(args: ConfirmArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    const toolUseId = String(args.toolUseId ?? "").trim();
    const argsDigest = digestArgs({ toolUseId, decision: args.decision, message: args.message ?? null });
    if (isSupervisorSessionId(tab)) return settle("confirm", tab, argsDigest, refused("supervisor-session", "a supervisor session is never a target (no recursion)"));
    const row = await rowFor(tab);
    if (!row) return settle("confirm", tab, argsDigest, refused("no-tab", `no open tab ${tab}`));
    const turnId = row.turn?.turnId;
    const pending = turnId && toolUseId ? ctx.deps.getPending(turnId, toolUseId) : null;
    if (!turnId || !pending) return settle("confirm", tab, argsDigest, refused("no-pending", `no pending confirm ${toolUseId} on tab ${tab}`));
    const drop = limited(tab, `confirm:${toolUseId}`);
    if (drop) return settle("confirm", tab, argsDigest, drop);
    const st = getSupervisorState(projectId);
    const humanAct = classifyHumanOnlyAct({ toolName: pending.toolName, input: pending.originalInput, cwd: row.tree.cwd, treeMode: row.tree.mode });
    const outcome = evaluateConfirm({
      mode: categoryMode(st, "confirms"),
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      raisedBy: pending.raisedBy,
      userOnly: isUserOnlyConfirm(turnId, toolUseId),
      act: humanAct,
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: groundContextFor(row, st.charter),
    });
    const decision = args.decision === "deny" ? "deny" : "allow";
    const target = { turnId, toolUseId, answer: [decision] };
    if (outcome.decision === "act") {
      const hold = actHold();
      if (hold) return settle("confirm", tab, argsDigest, { ...outcome, decision: "refuse", ...hold }, target);
      const id = newLedgerId();
      const done = ctx.deps.perform.confirm({ turnId, toolUseId, decision, message: args.message, grounds: outcome.grounds, ledgerId: id });
      if (!done.ok) return settle("confirm", tab, argsDigest, { ...outcome, decision: "refuse", reasonCode: "perform-failed", reason: `could not answer: ${done.error}` }, { ...target, id });
      return settle("confirm", tab, argsDigest, outcome, { ...target, id });
    }
    return settle("confirm", tab, argsDigest, outcome, target, () => {
      const kind = confirmKind(pending.raisedBy, humanAct);
      return {
        sessionId: tab,
        tabTitle: row.title ?? null,
        kind,
        escalatedBecause: {
          code: escalationCode(outcome.reasonCode),
          label: outcome.reason.slice(0, 200),
          ...(humanAct ? { rule: `§4 ${humanAct.item}: ${humanAct.label}`.slice(0, 120) } : pending.raisedBy && kind !== "confirm" ? { rule: `§4 ${pending.raisedBy}` } : {}),
        },
        rawAct: buildRawAct(pending.toolName, pending.originalInput),
        linkedConfirm: { sessionId: tab, turnId, toolUseId, raisingRule: pending.raisedBy },
        recommendation: { actionId: decision, text: String(args.message ?? outcome.reason).slice(0, 500) },
        grounds: outcome.grounds,
        act: { type: "confirm", turnId, toolUseId },
      };
    });
  }

  // ── Milestone 5: worktrees, close_session, review_scope, new_session, reply ──

  /** Project-level grounds (a worktree or a new tab has no tab of its own to cite). */
  function projectGrounds(refs: GroundRef[] | undefined): LedgerGround[] {
    const gctx: GroundContext = { mainRoot: ctx.workDir, tabRoot: null, charter: getSupervisorState(projectId).charter, brief: null, planStepCount: 0, planSeeded: false, tabStartedAt: null };
    return (Array.isArray(refs) ? refs : []).slice(0, 10).map((g) => {
      const { kind, ref, provenance } = resolveGround(g, gctx);
      return { kind, ref, provenance };
    });
  }

  /** A ledger line for the milestone 5 verbs. */
  function note(verb: string, tab: string | null, decision: LedgerDecision, reasonCode: string, reason: string, extra: Partial<LedgerEntryInput> = {}): string {
    const st = getSupervisorState(projectId);
    appendLedgerEntry(projectId, { kind: "verb", verb, tab, wakeId: ctx.wakeId, mode: st.mode, decision, reason, reasonCode, ...extra });
    return REPLY[decision](reason);
  }

  async function worktrees(args: WorktreesArgs): Promise<string> {
    const op = args.op;
    const wt = ctx.deps.worktrees;
    if (!wt) return "Refused: worktree access is not wired in this wake.";
    if (op === "list") return JSON.stringify(await wt.list(), null, 2);
    if (op === "preview") return JSON.stringify(await wt.preview(args.slugs?.length ? args.slugs.map(String).slice(0, 20) : null), null, 2);
    const verb = `worktrees.${op}`;
    const slugs = (Array.isArray(args.slugs) ? args.slugs : []).map(String).slice(0, 20);
    const push = op === "prepare-mr" && args.push === true;
    const openMergeRequest = op === "prepare-mr" && args.openMergeRequest === true;
    const argsDigest = digestArgs({ op, slugs, push, openMergeRequest });
    const st = getSupervisorState(projectId);
    if (st.mode === "off") return note(verb, null, "refuse", "off", "the supervisor is off", { argsDigest });
    const gate = ctx.limiter.check(projectId, "", `${verb}:${argsDigest}`, ctx.wake.acts);
    if (!gate.ok) return note(verb, null, "drop", "rate-limit", gate.reason, { argsDigest });
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, "", `${verb}:${argsDigest}`);

    if (op === "sweep") {
      // Not discarding (ADR-0127 §4 item 3): exactly what `worktree_sweep` reclaims — empty or
      // merged, clean, never an open tab's tree. MARVIN already sweeps on every tab close.
      const hold = actHold();
      if (hold) return note(verb, null, "refuse", hold.reasonCode, hold.reason, { argsDigest });
      const out = await wt.sweep();
      const reclaimed = out.filter((o) => o.deletedBranch);
      const summary = reclaimed.length ? `reclaimed ${reclaimed.map((o) => o.slug).join(", ")}` : "nothing spent to reclaim";
      note(verb, null, "act", "safe-sweep", `swept: ${summary}`, { argsDigest, argSummary: summary.slice(0, 300) });
      return `Swept. ${JSON.stringify(out, null, 2)}`;
    }

    const all = await wt.list();
    if (op !== "merge-all") {
      if (!slugs.length) return note(verb, null, "refuse", "no-slugs", `${op} needs the worktree slug(s)`, { argsDigest });
      if (op === "merge" && slugs.length !== 1) return note(verb, null, "refuse", "one-slug", "merge takes one slug; merge-all takes none", { argsDigest });
      for (const slug of slugs) {
        const w = all.find((x) => x.slug === slug);
        if (!w) return note(verb, null, "refuse", "no-worktree", `no worktree ${slug}`, { argsDigest });
        if (w.state === "session") return note(verb, null, "refuse", "open-tab", `${slug} belongs to an open tab — its branch is decided when the user closes the tab (ADR-0109)`, { argsDigest });
      }
    }
    const grounds = projectGrounds(args.grounds);
    const rawAct = buildRawAct(verb, { slugs, ...(op === "prepare-mr" ? { push, openMergeRequest } : {}) });
    const preview = op === "drop" ? null : await wt.preview(op === "merge-all" ? null : slugs);
    const id = newLedgerId();
    const label = op === "drop" ? "Dropping a worktree that holds work is the user's act" : "Integration is the user's act";
    const inboxItemId = raise(
      {
        sessionId: null,
        kind: op === "drop" ? "discard" : "integration",
        escalatedBecause: { code: "human-only", label, rule: op === "drop" ? "§4.3 discard" : "§4.1 integration" },
        rawAct,
        preview,
        recommendation: { actionId: "perform", text: String(args.recommendation ?? "").slice(0, 500) || rawAct.summary },
        grounds,
        act: { type: "worktrees", op, slugs, ...(op === "prepare-mr" ? { push, openMergeRequest } : {}) },
      },
      st.mode,
      id,
    );
    return note(verb, null, "escalate", "human-only", `${label} (ADR-0127 §4) — it is in the user's inbox with a preview`, { id, inboxItemId, argsDigest, grounds, argSummary: rawAct.summary });
  }

  /** A close-with-keep item for a scope-met tab, keyed on its scope-met close so it is raised once. */
  function closeItem(row: SessionWatchRow, worktree: CloseSessionArgs["worktree"], text: string, grounds: LedgerGround[], mode: SupervisorMode, id: string): string {
    const tab = row.marvinSessionId;
    const scopeMetAt = (ctx.deps.scopeMetAt?.(tab) ?? null);
    return raise(
      {
        sessionId: tab,
        tabTitle: row.title ?? null,
        kind: worktree === "keep" ? "scope" : worktree === "merge" ? "integration" : "discard",
        escalatedBecause: {
          code: "human-only",
          label: "Closing a tab is the user's act",
          rule: worktree === "merge" ? "§4.1 integration" : "§4.3 discard",
        },
        rawAct: buildRawAct("close_session", { marvinSessionId: tab, worktree }),
        recommendation: { actionId: "perform", text: text.slice(0, 500) || "Close this tab" },
        grounds,
        act: { type: "close", sessionId: tab, worktree },
        ...(worktree === "keep" && scopeMetAt ? { dedupeKey: `close:${tab}:${scopeMetAt}` } : {}),
      },
      mode,
      id,
    );
  }

  async function close_session(args: CloseSessionArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    const worktree = args.worktree === "merge" || args.worktree === "discard" ? args.worktree : "keep";
    const argsDigest = digestArgs({ worktree });
    if (!visible(tab)) return note("close_session", tab || null, "refuse", "delegation", `tab ${tab} is not delegated to you (or is a supervisor session)`, { argsDigest });
    const row = await rowFor(tab);
    if (!row) return note("close_session", tab, "refuse", "no-tab", `no open tab ${tab}`, { argsDigest });
    if (row.turn) return note("close_session", tab, "refuse", "turn-live", "a turn is running in this tab", { argsDigest });
    const drop = limited(tab, `close_session:${argsDigest}`);
    if (drop) return note("close_session", tab, "drop", "rate-limit", drop.reason, { argsDigest });
    const st = getSupervisorState(projectId);
    const grounds = (Array.isArray(args.grounds) ? args.grounds : []).map((g) => {
      const { kind, ref, provenance } = resolveGround(g, groundContextFor(row, st.charter));
      return { kind, ref, provenance };
    });
    const id = newLedgerId();
    const inboxItemId = closeItem(row, worktree, String(args.recommendation ?? ""), grounds, st.mode, id);
    return note("close_session", tab, "escalate", "human-only", "closing a tab is the user's act (ADR-0127 §4, ADR-0111) — it is in the user's inbox", { id, inboxItemId, argsDigest, grounds, argSummary: `close ${worktree}` });
  }

  /**
   * ADR-0127 §2 trigger 4 — a tab claimed its scope met. The supervisor reads
   * the claim against the evidence and either marks the tab ready for the
   * user's review (a close-with-keep item) or says what is missing (an item
   * that sends it, on the user's click: reopening scope is theirs, §4 item 6).
   */
  async function review_scope(args: ReviewScopeArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    const text = String(args.text ?? "").trim();
    const verdict = args.verdict === "missing" ? "missing" : "ready";
    const argsDigest = digestArgs({ verdict, text });
    if (!visible(tab)) return note("review_scope", tab || null, "refuse", "delegation", `tab ${tab} is not delegated to you (or is a supervisor session)`, { argsDigest });
    const row = await rowFor(tab);
    if (!row) return note("review_scope", tab, "refuse", "no-tab", `no open tab ${tab}`, { argsDigest });
    if (!(ctx.deps.scopeMetAt?.(tab) ?? null)) return note("review_scope", tab, "refuse", "no-scope-met", "the tab has not claimed its scope met — there is no claim to review", { argsDigest });
    if (!text || text.length > MAX_SUPERVISOR_MESSAGE_CHARS) return note("review_scope", tab, "refuse", "text", `the review needs 1–${MAX_SUPERVISOR_MESSAGE_CHARS} characters`, { argsDigest });
    if (containsSecretShape(text)) return note("review_scope", tab, "refuse", "secret", "the review carries a secret-shaped string (ADR-0127 §6)", { argsDigest });
    const drop = limited(tab, `review_scope:${argsDigest}`);
    if (drop) return note("review_scope", tab, "drop", "rate-limit", drop.reason, { argsDigest });
    const st = getSupervisorState(projectId);
    const grounds = (Array.isArray(args.grounds) ? args.grounds : []).map((g) => {
      const { kind, ref, provenance } = resolveGround(g, groundContextFor(row, st.charter));
      return { kind, ref, provenance };
    });
    const id = newLedgerId();
    const inboxItemId =
      verdict === "ready"
        ? closeItem(row, "keep", text, grounds, st.mode, id)
        : raise(
            {
              sessionId: tab,
              tabTitle: row.title ?? null,
              kind: "scope",
              escalatedBecause: { code: "human-only", label: "Reopening a finished tab's scope is the user's act", rule: "§4.6 scope" },
              rawAct: buildRawAct("send", { marvinSessionId: tab, message: text, kind: "instruction" }),
              recommendation: { actionId: "perform", text: "The scope-met claim misses something; send the tab what is missing" },
              grounds,
              act: { type: "send", sessionId: tab, text, kind: "instruction", grounds },
            },
            st.mode,
            id,
          );
    return note("review_scope", tab, "escalate", "human-only", `scope review (${verdict}) — it is in the user's inbox`, { id, inboxItemId, argsDigest, grounds, argSummary: `scope ${verdict}` });
  }

  /**
   * ADR-0127 §4 item 7 — open a tab, only on the user's word. The verb never
   * opens one: it proposes an inbox item with the first message, the tree (a
   * fresh worktree, always) and the posture, and the user's confirmation opens
   * it. One request, one tab.
   */
  async function new_session(args: NewSessionArgs): Promise<string> {
    const requestId = String(args.requestId ?? "").trim();
    const firstMessage = String(args.firstMessage ?? "").trim();
    const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
    const argsDigest = digestArgs({ requestId, firstMessage, posture: args.posture ?? {}, tree: args.tree ?? null, title });
    const refuse = (code: string, reason: string) => note("new_session", null, "refuse", code, reason, { argsDigest });
    const st = getSupervisorState(projectId);
    if (st.mode === "off") return refuse("off", "the supervisor is off");
    const request = requestId ? (ctx.deps.userRequest?.(requestId) ?? null) : null;
    if (!request) return refuse("no-request", "a new tab is proposed only on the user's own request — cite the id of their message (ADR-0127 §4 item 7)");
    if (listInbox(projectId).some((i) => i.act?.type === "new-tab" && i.act.requestId === requestId && (i.state === "open" || i.state === "resolved"))) {
      return refuse("request-used", "that request already has its tab — one request, one tab");
    }
    if (args.tree !== undefined && args.tree !== "worktree") {
      return refuse("tree", "a new tab always gets a fresh worktree — never the shared checkout or an existing tree (ADR-0122)");
    }
    if (!firstMessage || firstMessage.length > MAX_SUPERVISOR_MESSAGE_CHARS) return refuse("text", `the first message needs 1–${MAX_SUPERVISOR_MESSAGE_CHARS} characters`);
    if (containsSecretShape(firstMessage) || containsSecretShape(title)) return refuse("secret", "the first message carries a secret-shaped string (ADR-0127 §6)");
    // No posture given: the base posture as it is.
    const valid: ReturnType<typeof validatePosturePatch> = args.posture && Object.keys(args.posture).length ? validatePosturePatch(args.posture) : { ok: true, patch: {} };
    if (!valid.ok) return refuse("posture", valid.error);
    const key = `new_session:${requestId}`;
    const gate = ctx.limiter.check(projectId, "", key, ctx.wake.acts);
    if (!gate.ok) return note("new_session", null, "drop", "rate-limit", gate.reason, { argsDigest });
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, "", key);

    const base = await ctx.deps.newTabBase?.();
    if (!base) return note("new_session", null, "refuse", "no-base", "the project has no posture to start a tab from", { argsDigest });
    const patch = valid.patch;
    const posture: SessionPosture = {
      ...base.posture,
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.thinkingMode !== undefined ? { thinkingMode: patch.thinkingMode } : {}),
      ...(patch.permissionStrategy !== undefined ? { permissionStrategy: patch.permissionStrategy } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    };
    const wider = classifyPostureChange(base.posture, patch, await ctx.deps.modelLookup())
      .filter((c) => c.direction === "widen")
      .map((c) => c.field);
    const grounds = projectGrounds(args.grounds);
    const rawAct = buildRawAct("new_session", { firstMessage, tree: "worktree", posture: patch, ...(title ? { title } : {}) });
    const id = newLedgerId();
    const inboxItemId = raise(
      {
        sessionId: null,
        kind: "new-tab",
        escalatedBecause: { code: "human-only", label: "Opening a tab is the user's act", rule: "§4.7 topology" },
        rawAct,
        newTab: {
          firstMessage,
          tree: { baseRef: base.baseRef, baseSha: base.baseSha, mode: "worktree" },
          posture: {
            model: posture.model,
            modelLabel: (await ctx.deps.modelLabel?.(posture.model)) ?? posture.model,
            effort: String(posture.thinkingMode ?? ""),
            strategy: String(posture.permissionStrategy ?? ""),
            mode: String(posture.mode ?? "agent"),
          },
          wider,
          requestedBy: { kind: "user-message", ref: requestId, at: request.at },
        },
        recommendation: { actionId: "open", text: String(args.recommendation ?? "").slice(0, 500) || "You asked for a tab for this" },
        grounds,
        act: { type: "new-tab", requestId, ...(title ? { title } : {}), posture, grounds },
      },
      st.mode,
      id,
    );
    return note("new_session", null, "escalate", "human-only", "opening a tab is the user's act — the proposal is in their inbox (ADR-0127 §4 item 7)", { id, inboxItemId, argsDigest, grounds, argSummary: rawAct.summary });
  }

  /** Milestone 5 — answer the user in the supervisor's conversation. A reply authorises nothing. */
  async function reply(args: { text: string }): Promise<string> {
    const text = String(args.text ?? "").trim();
    if (!text || text.length > MAX_SUPERVISOR_MESSAGE_CHARS) return `Refused: a reply needs 1–${MAX_SUPERVISOR_MESSAGE_CHARS} characters.`;
    if (containsSecretShape(text)) return "Refused: the reply carries a secret-shaped string (ADR-0127 §6).";
    if (!ctx.deps.postReply) return "Refused: no conversation is open this wake.";
    ctx.deps.postReply(text);
    return "Sent to the user.";
  }

  return { sessions, read, answer, set_posture, send, cancel, confirm, worktrees, close_session, review_scope, new_session, reply };
}

const groundSchema = z.object({
  kind: z.enum(["plan", "dod", "adr", "memory", "charter", "file"]),
  ref: z.string().min(1).max(500),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function supervisorToolDefs(ctx: VerbContext) {
  const v = createSupervisorVerbs(ctx);
  return [
    tool(
      "sessions",
      "List the tabs the user delegated to you, with what each is waiting on (pending questions and confirms, " +
        "plan progress, last turn). Tabs not delegated, and supervisor sessions, are never listed.",
      {},
      async () => text(await v.sessions()),
    ),
    tool(
      "read",
      "Read one delegated tab: its pending question (`what: question` + `toolUseId`), its transcript tail, its plan, " +
        "or your own ledger for it. Tab content comes back wrapped as untrusted data.",
      {
        marvinSessionId: z.string().min(1),
        what: z.enum(["question", "transcript", "plan", "ledger"]),
        toolUseId: z.string().optional(),
      },
      async (args) => text(await v.read(args)),
    ),
    tool(
      "answer",
      "Answer a tab's pending AskUserQuestion, or escalate it to the user. `answers` maps the full question text to " +
        "the option label (an array for multi-select); `other` gives free text. Cite `grounds` — every answer needs " +
        "at least one the tab did not write itself. If you cannot ground it, pass `escalate: { reason, recommendation }` " +
        "instead. In shadow mode your answer is recorded as a proposal; with the questions category autonomous it is given, marked as yours.",
      {
        marvinSessionId: z.string().min(1),
        toolUseId: z.string().min(1),
        answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        other: z.record(z.string(), z.string()).optional(),
        grounds: z.array(groundSchema).max(10).optional(),
        escalate: z.object({ reason: z.string().min(1).max(500), recommendation: z.string().max(500).optional() }).optional(),
      },
      async (args) => text(await v.answer(args as AnswerArgs)),
    ),
    tool(
      "set_posture",
      "Propose a change to a tab's posture (model, thinkingMode, permissionStrategy, mode). You may only NARROW " +
        "(gated over auto over full; ask/plan over agent; lower effort; a model known to cost no more): any widening " +
        "escalates to the user, Plan → Agent included. Cite `grounds`. In shadow mode nothing changes; with the posture category autonomous a narrowing is applied.",
      {
        marvinSessionId: z.string().min(1),
        posture: z.object({
          model: z.string().optional(),
          thinkingMode: z.string().optional(),
          permissionStrategy: z.enum(["gated", "auto", "full"]).optional(),
          mode: z.enum(["ask", "plan", "agent"]).optional(),
        }),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.set_posture(args as SetPostureArgs)),
    ),
    tool(
      "send",
      "Propose a message to a delegated tab: a `nudge` toward its approved plan, or an `instruction`. It reaches the tab " +
        "marked as yours, never as the user's, and it can authorise nothing on the human-only list. Cite `grounds`. " +
        "Refused for a tab the user stopped, one waiting on its own build or wakeup, or one sharing a busy checkout; a " +
        "third nudge at the same plan step without progress escalates, and a tab whose scope is met is not messaged. In shadow mode nothing is sent; " +
        "with the nudges category autonomous it is sent.",
      {
        marvinSessionId: z.string().min(1),
        message: z.string().min(1).max(4_000),
        kind: z.enum(["nudge", "instruction"]),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.send(args as SendArgs)),
    ),
    tool(
      "cancel",
      "Propose cancelling a delegated tab's running turn — a runaway loop. Give the `reason` and cite `grounds`. " +
        "In shadow mode nothing is cancelled; with the nudges category autonomous the turn is stopped.",
      {
        marvinSessionId: z.string().min(1),
        reason: z.string().min(1).max(500),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.cancel(args as CancelArgs)),
    ),
    tool(
      "confirm",
      "Propose allowing or denying an ORDINARY permission confirm (a gated Edit / Write / shell card) in a tab delegated " +
        "at answer-confirms. A confirm in a turn you touched is the user's alone and is refused; containment, money and " +
        "every other human-only act escalate. Cite `grounds`. In shadow mode nothing is answered.",
      {
        marvinSessionId: z.string().min(1),
        toolUseId: z.string().min(1),
        decision: z.enum(["allow", "deny"]),
        message: z.string().max(500).optional(),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.confirm(args as ConfirmArgs)),
    ),
    tool(
      "worktrees",
      "The project's worktrees. `list` and `preview` (a merge-tree dry run against the current branch) read live. " +
        "`sweep` reclaims exactly what is provably spent — empty or merged, clean, never an open tab's tree — and is performed. " +
        "`merge`, `merge-all`, `prepare-mr` and `drop` are the user's acts: each becomes an inbox item with the raw act and a preview. " +
        "Give your `recommendation` and `grounds`.",
      {
        op: z.enum(["list", "preview", "sweep", "merge", "merge-all", "prepare-mr", "drop"]),
        slugs: z.array(z.string().min(1).max(200)).max(20).optional(),
        push: z.boolean().optional(),
        openMergeRequest: z.boolean().optional(),
        recommendation: z.string().max(500).optional(),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.worktrees(args as WorktreesArgs)),
    ),
    tool(
      "close_session",
      "Propose closing a delegated tab: `keep` (its branch stays — reversible), `merge` or `discard`. Closing is the user's act: " +
        "it becomes an inbox item, never performed by you.",
      {
        marvinSessionId: z.string().min(1),
        worktree: z.enum(["keep", "merge", "discard"]),
        recommendation: z.string().max(500).optional(),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.close_session(args as CloseSessionArgs)),
    ),
    tool(
      "review_scope",
      "Review a tab's scope-met claim against its plan and DoD. `ready` proposes closing it with its branch kept; " +
        "`missing` proposes sending the tab `text` (what is missing). Both go to the user's inbox — reopening scope is theirs.",
      {
        marvinSessionId: z.string().min(1),
        verdict: z.enum(["ready", "missing"]),
        text: z.string().min(1).max(4_000),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.review_scope(args as ReviewScopeArgs)),
    ),
    tool(
      "new_session",
      "Propose opening ONE new tab, only when the user asked you for one: cite the id of their message as `requestId`. " +
        "Give the `firstMessage`, an optional `title` and `posture`. The tab always gets a fresh worktree. The user confirms " +
        "it from the inbox; you never open a tab yourself, and one request is one tab.",
      {
        requestId: z.string().min(1).max(100),
        firstMessage: z.string().min(1).max(4_000),
        title: z.string().max(120).optional(),
        posture: z
          .object({
            model: z.string().optional(),
            thinkingMode: z.string().optional(),
            permissionStrategy: z.enum(["gated", "auto", "full"]).optional(),
            mode: z.enum(["ask", "plan", "agent"]).optional(),
          })
          .optional(),
        tree: z.string().max(200).optional(),
        recommendation: z.string().max(500).optional(),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.new_session(args as NewSessionArgs)),
    ),
    tool(
      "reply",
      "Answer the user in your conversation with them (their messages reach you as `message` items). A reply authorises nothing.",
      { text: z.string().min(1).max(4_000) },
      async (args) => text(await v.reply(args)),
    ),
  ];
}

export function createSupervisorMcpServer(ctx: VerbContext) {
  return createSdkMcpServer({
    name: SUPERVISE_SERVER_NAME,
    version: "1.0.0",
    // The supervisor's canUseTool admits no ToolSearch, so a deferred tool set
    // would leave it unable to act at all.
    alwaysLoad: true,
    tools: supervisorToolDefs(ctx),
  });
}
