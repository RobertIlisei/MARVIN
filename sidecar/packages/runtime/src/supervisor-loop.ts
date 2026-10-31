/**
 * The supervisor's wake loop (ADR-0127 §2) — deterministic code decides WHEN
 * the supervisor runs; the model decides only what to say.
 *
 * Milestone 1 wakes on one trigger: a pending question (`AskUserQuestion`,
 * by the registry's raising rule) in a tab delegated to the supervisor.
 * Milestone 4 adds two, with rules from a day of real supervision, when tabs
 * that had finished kept starting $12–57 turns on their own:
 *
 *   - **turn ended** — only a turn a person or the supervisor started. A
 *     machine turn the supervisor did not author (a job completion, a wakeup,
 *     a resume, a guard's corrective turn) never wakes it; a question such a
 *     turn asks still does, through `confirm.pending`. Never a stopped turn,
 *     never a tab whose scope is met (`scopeMetAt`).
 *   - **idle with an open plan** — a runtime timer, armed when a delegated
 *     tab's turn ends and cleared when the next one starts, never the
 *     supervisor scheduling itself. Once per plan signature: an unchanged idle
 *     tab is not woken for again. Never a scope-met tab, a stopped one, or one
 *     waiting on its own job or wakeup.
 *
 * It also pairs each shadow proposal with the answer that resolved it
 * (`confirm.resolved` carries who answered), and records a heuristic miss
 * when a turn the supervisor answered into raises a human-only confirm.
 *
 *   - debounced per project, and coalesced: one wake carries every pending item;
 *   - one wake at a time per project; events arriving mid-wake are queued for
 *     the next one, never dropped;
 *   - nothing while the supervisor is off, paused or over its daily budget;
 *   - kill aborts the wake in flight (via the state module's control hook).
 *
 * Started lazily from route code (`ensureSupervisorLoop`), never from
 * `instrumentation.ts`: Next may load instrumentation as a separate module
 * graph, and the project event bus in `turn-registry.ts` is a plain module
 * EventEmitter — a loop subscribed from there would hear nothing.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

import { answerQuestion, resolveConfirm } from "./confirm-answer";
import { getPendingConfirm, listPendingConfirms } from "./confirm-registry";
import { previewIntegration } from "./integration";
import { listModelsCached } from "./models";
import { marvinPaths } from "./paths";
import { readPlanState } from "./plan-state";
import { activeModelLookup, applyPostureChange } from "./posture";
import { getProject } from "./projects";
import { loadSessionTail } from "./session";
import { listSessionMetas, readSessionMeta, type SessionPosture } from "./session-meta";
import { buildSessionWatch, planProgress } from "./session-watch";
import { runSupervisorWake, type WakeResult } from "./supervisor-dispatch";
import { addInboxItem, buildRawAct, type MergePreview, resolveInboxForConfirm, supersedeInbox } from "./supervisor-inbox";
import { appendLedgerEntry, newLedgerId, readLedger } from "./supervisor-ledger";
import type { VerbContext, VerbDeps, VerbPerform } from "./supervisor-mcp";
import { addSupervisorReply, getUserMessage } from "./supervisor-messages";
import { ActionLimiter } from "./supervisor-policy";
import type { WakeItem } from "./supervisor-prompt";
import { sendAsSupervisor, tabSendRefusal } from "./supervisor-send";
import {
  delegationRank,
  getSupervisorState,
  isSupervisorSessionId,
  onSupervisorControl,
  overBudget,
  pauseSupervisorForFault,
  type SupervisorLastWake,
  updateSupervisorRuntime,
} from "./supervisor-state";
import { type LoopSnapshot, noteHeuristicMiss, pairOnResolved } from "./supervisor-status";
import { cancelLiveTurn, getLiveTurn, listLiveTurns, type ProjectEvent, subscribeProjectEvents } from "./turn-registry";
import { reconcileWorktreesAsync, sweepWorktreesAsync } from "./worktrees";

/** Bookkeeping must never break the loop: a failed pairing or ledger write is lost, the wake is not. */
function guarded(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[marvin.supervisor] bookkeeping failed: ${(err as Error).message}`);
  }
}

/**
 * Why a wake was raised. A question or confirm ref names it; turn-ended, idle
 * and scope-met name the turn that ended; a message ref names the user's message.
 */
export type WakeTrigger = "question" | "turn-ended" | "idle" | "confirm" | "scope-met" | "message";

export interface PendingRef {
  trigger?: WakeTrigger;
  marvinSessionId: string;
  turnId: string;
  /** Set for a question or confirm (a message ref carries its message id here); a turn-ended or idle ref carries none. */
  toolUseId: string;
  /** An idle ref's plan signature — the idle trigger fires once per signature. */
  planSignature?: string;
}

/** What the idle and turn-ended rules read about a tab. */
export interface TabFacts {
  live: boolean;
  pending: number;
  /** `done/total@lastTodoAt`, as the nudge cap keys it; null with no plan. */
  planSignature: string | null;
  planOpen: number;
  scopeMet: boolean;
  /** The last turn was stopped — by the user, or cancelled by the supervisor. Either way the user decides next. */
  stopped: boolean;
  waitingOnOwn: boolean;
  /** Milestone 5 — when the tab closed its scope, or null. One scope-met wake and one close item per value. */
  scopeMetAt?: string | null;
}

export interface LoopDeps {
  subscribe(listener: (e: ProjectEvent) => void): () => void;
  workDirOf(projectId: string): string | null;
  verbDeps(projectId: string, workDir: string): VerbDeps;
  buildItems(projectId: string, workDir: string, refs: PendingRef[]): Promise<WakeItem[]>;
  runWake(args: { projectId: string; workDir: string; items: WakeItem[]; verbCtx: VerbContext; abortController: AbortController }): Promise<WakeResult>;
  /** Milestone 4 — a tab's facts for the idle and turn-ended rules; null when it is gone. */
  tabFacts(projectId: string, marvinSessionId: string): Promise<TabFacts | null>;
  /** Milestone 4 — pending questions in delegated tabs, for `wakeNow`'s re-scan. */
  pendingQuestions(projectId: string): PendingRef[];
  /**
   * Milestone 5 — a finished tab idle past the threshold gets one inbox item
   * proposing to close it with its branch kept. Deterministic: no wake, no
   * model. Optional so earlier fixtures build; the default writes the item.
   */
  proposeClose?(projectId: string, marvinSessionId: string, scopeMetAt: string): void;
}

const refKey = (r: PendingRef) => {
  switch (r.trigger) {
    case "turn-ended":
      return `ended:${r.marvinSessionId}`;
    case "idle":
      return `idle:${r.marvinSessionId}`;
    case "scope-met":
      return `scope:${r.marvinSessionId}`;
    case "message":
      return `message:${r.toolUseId}`;
    default:
      return r.toolUseId;
  }
};

export class SupervisorLoop {
  private readonly queues = new Map<string, Map<string, PendingRef>>();
  private readonly queuedAt = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, AbortController>();
  private readonly current = new Map<string, { wakeId: string; startedAt: string; itemCount: number }>();
  private readonly limiters = new Map<string, ActionLimiter>();
  /** `projectId:sessionId` → the tab's idle timer. */
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `projectId:sessionId` → the plan signature an idle wake was last raised for. */
  private readonly idleWoken = new Map<string, string>();
  /** `projectId:sessionId` → the scope-met close a review wake was last raised for (milestone 5). */
  private readonly scopeWoken = new Map<string, string>();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: LoopDeps) {}

  start(): void {
    if (this.unsubscribers.length) return;
    this.unsubscribers.push(this.deps.subscribe((e) => this.onEvent(e)));
    this.unsubscribers.push(
      onSupervisorControl(({ projectId, action }) => {
        if (action === "kill" || action === "stop" || action === "disable") this.kill(projectId);
        else if (action === "pause") this.clearTimer(projectId);
        else if (action === "wakeNow") this.wakeNow(projectId);
        else if (action === "resume" || action === "start" || action === "delegate") this.schedule(projectId);
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    for (const p of [...this.timers.keys()]) this.clearTimer(p);
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
    for (const c of this.running.values()) c.abort();
  }

  /** What the status projection reads (brief §10.1 `currentWake`, `queuedEvents`). */
  snapshot(projectId: string): LoopSnapshot {
    const q = this.queues.get(projectId);
    return {
      currentWake: this.current.get(projectId) ?? null,
      queuedEvents: q?.size ?? 0,
      oldestQueuedAt: q?.size ? (this.queuedAt.get(projectId) ?? null) : null,
    };
  }

  /**
   * Milestone 5 — the user wrote to the supervisor (`POST /api/supervisor/message`).
   * The message wakes it; nothing about it is consent.
   */
  noteUserMessage(projectId: string, messageId: string): void {
    if (getSupervisorState(projectId).mode === "off") return;
    this.enqueue(projectId, { trigger: "message", marvinSessionId: "", turnId: "", toolUseId: messageId });
    this.schedule(projectId);
  }

  /** The user's Restart (brief §10.1 `wakeNow`): re-scan pending questions and wake without the debounce. */
  wakeNow(projectId: string): void {
    for (const r of this.deps.pendingQuestions(projectId)) {
      if (this.eligibleTab(projectId, r.marvinSessionId)) this.enqueue(projectId, { ...r, trigger: "question" });
    }
    this.clearTimer(projectId);
    void this.flush(projectId);
  }

  private enqueue(projectId: string, ref: PendingRef): void {
    let q = this.queues.get(projectId);
    if (!q) this.queues.set(projectId, (q = new Map()));
    if (q.size === 0) this.queuedAt.set(projectId, Date.now());
    q.set(refKey(ref), ref);
  }

  private eligibleTab(projectId: string, marvinSessionId: string): boolean {
    const st = getSupervisorState(projectId);
    return (
      st.mode !== "off" &&
      !isSupervisorSessionId(marvinSessionId) &&
      delegationRank(st.delegation[marvinSessionId]) >= delegationRank("observe")
    );
  }

  /**
   * The turn-ended and idle triggers wake only for a tab the supervisor may act
   * on: an `observe` tab has nothing it could do and, until the inbox
   * (milestone 5), nowhere to escalate — a wake there would be spend for nothing.
   */
  private actionableTab(projectId: string, marvinSessionId: string): boolean {
    return this.eligibleTab(projectId, marvinSessionId) && delegationRank(getSupervisorState(projectId).delegation[marvinSessionId]) >= delegationRank("answer-questions");
  }

  private onEvent(e: ProjectEvent): void {
    if (e.event === "confirm.pending") {
      const { projectId, marvinSessionId, turnId, toolUseId } = e.data;
      if (!this.eligibleTab(projectId, marvinSessionId)) return;
      // The registry's raising rule, not the tool name, says it is a question.
      const rule = getPendingConfirm(turnId, toolUseId)?.raisedBy;
      if (rule && rule !== "ask-user-question") {
        guarded(() => noteHeuristicMiss(projectId, { marvinSessionId, turnId, rule }));
        // Milestone 5 — an ordinary confirm wakes it for an `answer-confirms` tab. Any other is the user's.
        if (rule === "gated" && delegationRank(getSupervisorState(projectId).delegation[marvinSessionId]) >= delegationRank("answer-confirms")) {
          this.enqueue(projectId, { trigger: "confirm", marvinSessionId, turnId, toolUseId });
          this.schedule(projectId);
        }
        return;
      }
      if (rule !== "ask-user-question") return;
      this.enqueue(projectId, { trigger: "question", marvinSessionId, turnId, toolUseId });
      this.schedule(projectId);
    } else if (e.event === "confirm.resolved") {
      const d = e.data;
      this.queues.get(d.projectId)?.delete(d.toolUseId);
      // Milestone 5 — an item about this confirm resolves on its own, wherever it was answered.
      guarded(() => resolveInboxForConfirm(d.projectId, { toolUseId: d.toolUseId, answeredBy: d.answeredBy }));
      if (getSupervisorState(d.projectId).mode !== "off") guarded(() => pairOnResolved(d.projectId, d));
    } else if (e.event === "turn.registered") {
      const d = e.data;
      this.clearIdle(d.projectId, d.marvinSessionId);
      this.queues.get(d.projectId)?.delete(`idle:${d.marvinSessionId}`);
      // A user or supervisor turn opens new scope (milestone 4's `scopeMetAt` rule): the close
      // proposal for the old scope is moot, and so is a review of its claim.
      if (d.kind === "human" || d.author === "supervisor") {
        this.queues.get(d.projectId)?.delete(`scope:${d.marvinSessionId}`);
        guarded(() => supersedeInbox(d.projectId, (i) => i.sessionId === d.marvinSessionId && i.act?.type === "close" && i.act.worktree === "keep"));
      }
    } else if (e.event === "turn.ended") {
      const d = e.data;
      if (!this.eligibleTab(d.projectId, d.marvinSessionId) || d.cancelled) return;
      // Armed for every watched tab: a finished one is offered for closing even at `observe`.
      this.armIdle(d.projectId, d.marvinSessionId, d.turnId);
      if (!this.actionableTab(d.projectId, d.marvinSessionId)) return;
      // Only a turn a person or the supervisor started (see the header).
      if (d.kind !== "human" && d.author !== "supervisor") return;
      void this.deps.tabFacts(d.projectId, d.marvinSessionId).then((f) => {
        if (!f || f.stopped || f.live) return;
        if (f.scopeMet) {
          // ADR-0127 §2 trigger 4 — read the scope-met claim, once per close.
          const k = this.idleKey(d.projectId, d.marvinSessionId);
          if (!f.scopeMetAt || this.scopeWoken.get(k) === f.scopeMetAt) return;
          this.scopeWoken.set(k, f.scopeMetAt);
          this.enqueue(d.projectId, { trigger: "scope-met", marvinSessionId: d.marvinSessionId, turnId: d.turnId, toolUseId: "" });
          this.schedule(d.projectId);
          return;
        }
        this.enqueue(d.projectId, { trigger: "turn-ended", marvinSessionId: d.marvinSessionId, turnId: d.turnId, toolUseId: "" });
        this.schedule(d.projectId);
      }, () => {});
    }
  }

  private idleKey = (projectId: string, id: string) => `${projectId}:${id}`;

  private clearIdle(projectId: string, id: string): void {
    const k = this.idleKey(projectId, id);
    const t = this.idleTimers.get(k);
    if (t) clearTimeout(t);
    this.idleTimers.delete(k);
  }

  private armIdle(projectId: string, id: string, turnId: string): void {
    this.clearIdle(projectId, id);
    const k = this.idleKey(projectId, id);
    const t = setTimeout(() => {
      this.idleTimers.delete(k);
      void this.onIdle(projectId, id, turnId);
    }, getSupervisorState(projectId).caps.idleMs);
    t.unref?.();
    this.idleTimers.set(k, t);
  }

  private async onIdle(projectId: string, id: string, turnId: string): Promise<void> {
    if (!this.eligibleTab(projectId, id)) return;
    const f = await this.deps.tabFacts(projectId, id).catch(() => null);
    if (!f || f.live || f.pending > 0 || f.stopped || f.waitingOnOwn) return;
    if (f.scopeMet) {
      // Milestone 5 — a finished tab idle past the threshold: one close-with-keep item per scope-met close.
      if (f.scopeMetAt) guarded(() => (this.deps.proposeClose ?? proposeCloseKeep)(projectId, id, f.scopeMetAt as string));
      return;
    }
    if (!this.actionableTab(projectId, id)) return;
    if (!f.planSignature || f.planOpen <= 0) return;
    const k = this.idleKey(projectId, id);
    if (this.idleWoken.get(k) === f.planSignature) return; // once per plan signature
    this.idleWoken.set(k, f.planSignature);
    this.enqueue(projectId, { trigger: "idle", marvinSessionId: id, turnId, toolUseId: "", planSignature: f.planSignature });
    this.schedule(projectId);
  }

  private clearTimer(projectId: string): void {
    const t = this.timers.get(projectId);
    if (t) clearTimeout(t);
    this.timers.delete(projectId);
  }

  private schedule(projectId: string): void {
    if (!this.queues.get(projectId)?.size) return;
    this.clearTimer(projectId);
    const st = getSupervisorState(projectId);
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        void this.flush(projectId);
      }, st.caps.debounceMs),
    );
  }

  private async flush(projectId: string): Promise<void> {
    if (this.running.has(projectId)) return; // the running wake re-schedules on exit
    const st = getSupervisorState(projectId);
    if (st.mode === "off" || st.paused) return;
    const queue = this.queues.get(projectId);
    if (!queue?.size) return;
    if (overBudget(st)) {
      // ADR-0127 §6 — at the cap the loop pauses and escalates; the user raises the cap or resumes.
      pauseSupervisorForFault(projectId, `over the daily budget ($${st.spend.usd.toFixed(2)} of $${st.caps.dailyBudgetUsd})`, "budget");
      return;
    }
    const candidates = [...queue.values()];
    queue.clear();
    this.queuedAt.delete(projectId);
    const refs: PendingRef[] = [];
    for (const r of candidates) {
      const trigger = r.trigger ?? "question";
      if (trigger === "message") {
        refs.push(r); // the user's own message; the supervisor is on (checked above)
        continue;
      }
      if (!this.eligibleTab(projectId, r.marvinSessionId)) continue;
      if (trigger === "question" || trigger === "confirm") {
        if (getPendingConfirm(r.turnId, r.toolUseId) !== null) refs.push(r);
        continue;
      }
      // A turn-ended, idle or scope-met ref is checked again: the tab may have moved on.
      const f = await this.deps.tabFacts(projectId, r.marvinSessionId).catch(() => null);
      if (!f || f.live || f.stopped) continue;
      if (trigger === "scope-met" ? f.scopeMet : !f.scopeMet) refs.push(r);
    }
    if (!refs.length) return;
    const workDir = this.deps.workDirOf(projectId);
    if (!workDir) return;

    const abortController = new AbortController();
    this.running.set(projectId, abortController);
    const wakeId = randomUUID();
    this.current.set(projectId, { wakeId, startedAt: new Date().toISOString(), itemCount: refs.length });
    let outcome: SupervisorLastWake["outcome"] = "ok";
    let error: SupervisorLastWake["error"];
    try {
      const items = await this.deps.buildItems(projectId, workDir, refs);
      if (abortController.signal.aborted) {
        outcome = "aborted";
        return; // killed while the packet was being built
      }
      const verbCtx: VerbContext = {
        projectId,
        workDir,
        wakeId,
        wake: { acts: 0 },
        limiter: this.limiterFor(projectId),
        deps: this.deps.verbDeps(projectId, workDir),
      };
      const result = await this.deps.runWake({ projectId, workDir, items, verbCtx, abortController });
      if (abortController.signal.aborted) outcome = "aborted";
      else if (verbCtx.wake.acts >= st.caps.maxActionsPerWake) outcome = "breaker";
      else if (!result.ok) {
        outcome = "failed";
        error = { message: (result.error ?? "the wake failed").slice(0, 500), detail: "" };
      }
    } catch (err) {
      outcome = abortController.signal.aborted ? "aborted" : "failed";
      if (outcome === "failed") error = { message: (err as Error).message.slice(0, 500), detail: String((err as Error).stack ?? "").slice(0, 2_000) };
      appendLedgerEntry(projectId, { kind: "wake", verb: "end", tab: null, wakeId, mode: st.mode, reason: `failed: ${(err as Error).message}` });
    } finally {
      this.running.delete(projectId);
      this.current.delete(projectId);
      guarded(() => updateSupervisorRuntime(projectId, { lastWake: { wakeId, at: new Date().toISOString(), outcome, ...(error ? { error } : {}) } }));
      if (!abortController.signal.aborted) this.schedule(projectId);
    }
  }

  private limiterFor(projectId: string): ActionLimiter {
    let l = this.limiters.get(projectId);
    if (!l) this.limiters.set(projectId, (l = new ActionLimiter(() => getSupervisorState(projectId).caps)));
    return l;
  }

  kill(projectId: string): void {
    this.clearTimer(projectId);
    this.running.get(projectId)?.abort();
    this.queues.get(projectId)?.clear();
  }
}

// ── Real sources ─────────────────────────────────────────────────────────────

const TRANSCRIPT_TAIL_CHARS = 8_000;

function renderTail(projectId: string, marvinSessionId: string): string {
  const tail = loadSessionTail(projectId, marvinSessionId, 80);
  if (!tail) return "";
  const out: string[] = [];
  for (const t of tail.record.turns) {
    // ADR-0127 §5 — the supervisor's own earlier messages are not the user's words.
    if (t.type === "turn.user") out.push(t.author === "supervisor" ? `supervisor (you, earlier — not the user): ${t.message}` : `user: ${t.message}`);
    else if (t.type === "cli.event") {
      const ev = t.event as { type?: string; message?: { content?: unknown } };
      if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
      for (const b of ev.message.content as Array<{ type?: string; text?: unknown; name?: unknown }>) {
        if (b.type === "text" && typeof b.text === "string") out.push(`assistant: ${b.text}`);
        else if (b.type === "tool_use" && typeof b.name === "string") out.push(`tool: ${b.name}`);
      }
    }
  }
  const text = out.join("\n");
  return text.length > TRANSCRIPT_TAIL_CHARS ? `…${text.slice(-TRANSCRIPT_TAIL_CHARS)}` : text;
}

/** The tab's first user message — the user's own words — from the head of the transcript. */
function readBrief(projectId: string, marvinSessionId: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(marvinPaths.sessionFile(projectId, marvinSessionId), "r");
    const buf = Buffer.alloc(512 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      if (!line.includes('"turn.user"')) continue;
      try {
        const t = JSON.parse(line) as { type?: string; message?: unknown; author?: unknown };
        if (t.type === "turn.user" && t.author !== "supervisor" && typeof t.message === "string") return t.message;
      } catch {
        /* a torn line at the buffer edge */
      }
    }
  } catch {
    /* no transcript yet */
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

function readPlanText(projectId: string, marvinSessionId: string): string {
  const r = readPlanState(projectId, marvinSessionId);
  if (!r.ok || !r.state) return "";
  const text = JSON.stringify(r.state, null, 1);
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
}

export function defaultVerbDeps(projectId: string, workDir: string): VerbDeps {
  return {
    listRows: () => buildSessionWatch({ projectId, workDir, sessionIds: Object.keys(getSupervisorState(projectId).delegation) }),
    getPending: getPendingConfirm,
    readTranscriptTail: (id) => renderTail(projectId, id),
    readBrief: (id) => readBrief(projectId, id),
    tabStartedAt: (id) => {
      const createdAt = readSessionMeta(projectId, id)?.createdAt;
      const t = createdAt ? Date.parse(createdAt) : Number.NaN;
      return Number.isFinite(t) ? t : null;
    },
    readPlanText: (id) => readPlanText(projectId, id),
    modelLookup: activeModelLookup,
    sendRefusal: (id) => tabSendRefusal(projectId, id),
    scopeMet: (id) => !!readSessionMeta(projectId, id)?.scopeMetAt,
    scopeMetAt: (id) => readSessionMeta(projectId, id)?.scopeMetAt ?? null,
    failedTurnsInARow: (id) => readSessionMeta(projectId, id)?.failedTurnsInARow ?? 0,
    modelLabel: async (id) => {
      try {
        return (await listModelsCached()).models.find((m) => m.id === id)?.displayName ?? id;
      } catch {
        return id;
      }
    },
    worktrees: defaultWorktrees(projectId, workDir),
    userRequest: (id) => {
      const m = getUserMessage(projectId, id);
      return m ? { id: m.id, at: m.at, text: m.text } : null;
    },
    newTabBase: () => newTabBase(projectId, workDir),
    postReply: (text) => {
      addSupervisorReply(projectId, text);
    },
    perform: defaultPerform(projectId),
  };
}

const isSessionBusy = (id: string) => {
  const t = getLiveTurn(id);
  return !!t && !t.ended;
};

/** Milestone 5 — the project's worktrees, read live; the sweep reclaims only what `worktree_sweep` does. */
function defaultWorktrees(_projectId: string, workDir: string): NonNullable<VerbDeps["worktrees"]> {
  return {
    list: async () =>
      (await reconcileWorktreesAsync(workDir)).map((w) => ({ slug: w.slug, branch: w.branch, state: w.state, sessionId: w.sessionId, commits: w.commits, dirty: w.dirty })),
    preview: async (slugs) => {
      const p = await previewIntegration(workDir, slugs ? { slugs } : {});
      if (!p.previewAvailable || !p.rows.length) return null;
      const conflict = p.rows.some((r) => r.verdict === "conflict");
      const unknown = p.rows.some((r) => r.verdict === "unknown");
      const behind = Math.max(0, ...p.rows.map((r) => r.behind));
      const verdict: MergePreview["verdict"] = conflict ? "conflict" : unknown ? "unknown" : behind > 0 ? "behind" : "clean";
      return {
        kind: "merge-tree",
        verdict,
        ...(behind > 0 ? { behind } : {}),
        added: p.rows.reduce((n, r) => n + r.added, 0),
        removed: p.rows.reduce((n, r) => n + r.removed, 0),
        conflictFiles: [...new Set(p.rows.flatMap((r) => r.conflicts))],
      };
    },
    sweep: async () => (await sweepWorktreesAsync(workDir, Date.now(), { isSessionBusy })).map((o) => ({ slug: o.slug, branch: o.branch, deletedBranch: o.deletedBranch, reason: o.reason })),
  };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout: 10_000 }, (err, stdout) => done(err ? "" : (stdout ?? "").trim()));
  });
}

/**
 * What a new tab would start from: the posture of the user's most recently
 * updated open tab (the brief's "requesting tab" — the card marks what is
 * wider than it), and the main checkout's HEAD, where the worktree is cut.
 */
async function newTabBase(projectId: string, workDir: string): Promise<{ posture: SessionPosture; baseRef: string | null; baseSha: string | null } | null> {
  const recent = listSessionMetas(projectId)
    .filter((m) => !m.closedAt && !isSupervisorSessionId(m.marvinSessionId) && m.posture)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  if (!recent) return null;
  const baseRef = (await git(workDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  const baseSha = (await git(workDir, ["rev-parse", "HEAD"])) || null;
  return { posture: recent.posture, baseRef, baseSha };
}

/**
 * Milestone 5 — the idle finished tab's close item. Closing with `keep` is
 * reversible (ADR-0111: the branch and its commits stay), so it is one
 * consent chip. Keyed on the scope-met close: a second pass adds nothing,
 * and a dismissed item is not offered again for the same close.
 */
export function proposeCloseKeep(projectId: string, marvinSessionId: string, scopeMetAt: string): void {
  const st = getSupervisorState(projectId);
  if (st.mode === "off") return;
  const dedupeKey = `close:${marvinSessionId}:${scopeMetAt}`;
  const ledgerId = newLedgerId();
  const title = readSessionMeta(projectId, marvinSessionId)?.title ?? null;
  const item = addInboxItem(projectId, {
    sessionId: marvinSessionId,
    tabTitle: title,
    kind: "scope",
    escalatedBecause: { code: "human-only", label: "Closing a tab is the user's act", rule: "§4.3 discard" },
    rawAct: buildRawAct("close_session", { marvinSessionId, worktree: "keep" }),
    recommendation: { actionId: "perform", text: "The tab met its scope and has been idle since. Closing keeps its branch for integration." },
    grounds: [],
    act: { type: "close", sessionId: marvinSessionId, worktree: "keep" },
    modeAtCreation: st.mode === "autonomous" ? "autonomous" : "shadow",
    wakeId: null,
    ledgerId,
    dedupeKey,
  });
  if (item.ledgerId !== ledgerId) return; // already proposed for this close
  appendLedgerEntry(projectId, {
    id: ledgerId,
    kind: "wake",
    verb: "propose-close",
    tab: marvinSessionId,
    wakeId: null,
    mode: st.mode,
    decision: "escalate",
    reason: "the tab met its scope and has been idle past the threshold — proposed closing it with its branch kept",
    reasonCode: "scope-met-idle",
    inboxItemId: item.id,
    argSummary: "close keep",
  });
}

/** The milestone 2 and 3 services an autonomous verb performs through. */
function defaultPerform(projectId: string): VerbPerform {
  return {
    answer: (a) => {
      const r = answerQuestion({ ...a, answeredBy: "supervisor" });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    send: async (m) => {
      const r = await sendAsSupervisor(m);
      return r.ok ? r : { ok: false, code: r.code, reason: r.reason };
    },
    cancel: (id) => cancelLiveTurn(id, "supervisor"),
    confirm: (a) => {
      const r = resolveConfirm({ ...a, answeredBy: "supervisor" });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    setPosture: async (a) => {
      const r = applyPostureChange({ projectId, marvinSessionId: a.marvinSessionId, patch: a.patch, actor: "supervisor", lookup: await activeModelLookup(), ledger: false });
      return r.ok ? { ok: true } : { ok: false, code: r.status === 409 ? "widening" : "perform-failed", error: r.error };
    },
  };
}

async function defaultTabFacts(projectId: string, marvinSessionId: string): Promise<TabFacts | null> {
  const meta = readSessionMeta(projectId, marvinSessionId);
  if (!meta || meta.closedAt) return null;
  const live = listLiveTurns(projectId).find((t) => t.marvinSessionId === marvinSessionId && !t.ended);
  const plan = planProgress(projectId, marvinSessionId);
  const refusal = tabSendRefusal(projectId, marvinSessionId);
  return {
    live: !!live,
    pending: live ? listPendingConfirms(live.turnId).length : 0,
    planSignature: plan ? `${plan.done}/${plan.total}@${plan.lastTodoAt ?? "-"}` : null,
    planOpen: plan?.open ?? 0,
    scopeMet: !!meta.scopeMetAt,
    stopped: meta.lastTurn?.outcome === "stopped",
    waitingOnOwn: refusal?.code === "waiting-on-own",
    scopeMetAt: meta.scopeMetAt ?? null,
  };
}

function defaultPendingQuestions(projectId: string): PendingRef[] {
  const out: PendingRef[] = [];
  for (const t of listLiveTurns(projectId)) {
    if (t.ended) continue;
    for (const p of listPendingConfirms(t.turnId)) {
      if (getPendingConfirm(t.turnId, p.toolUseId)?.raisedBy === "ask-user-question") {
        out.push({ trigger: "question", marvinSessionId: t.marvinSessionId, turnId: t.turnId, toolUseId: p.toolUseId });
      }
    }
  }
  return out;
}

async function defaultBuildItems(projectId: string, workDir: string, refs: PendingRef[]): Promise<WakeItem[]> {
  const st = getSupervisorState(projectId);
  const rows = await buildSessionWatch({ projectId, workDir, sessionIds: [...new Set(refs.map((r) => r.marvinSessionId))] });
  return refs.map((r) => {
    const trigger = r.trigger ?? "question";
    if (trigger === "message") {
      const m = getUserMessage(projectId, r.toolUseId);
      return {
        trigger,
        marvinSessionId: "",
        title: null,
        delegation: "",
        turnId: "",
        toolUseId: r.toolUseId,
        question: null,
        message: m ? { id: m.id, text: m.text } : { id: r.toolUseId, text: "(the message could not be read)" },
        brief: null,
        plan: null,
        transcriptTail: "",
        ledgerTail: [],
      };
    }
    const row = rows.find((x) => x.marvinSessionId === r.marvinSessionId);
    const pending = trigger === "question" || trigger === "confirm" ? getPendingConfirm(r.turnId, r.toolUseId) : null;
    return {
      ...(trigger === "confirm" && pending ? { confirm: { toolName: pending.toolName, input: pending.originalInput } } : {}),
      trigger,
      marvinSessionId: r.marvinSessionId,
      title: row?.title ?? null,
      delegation: st.delegation[r.marvinSessionId] ?? "off",
      turnId: r.turnId,
      toolUseId: r.toolUseId,
      question: trigger === "question" ? (pending?.originalInput ?? null) : null,
      brief: readBrief(projectId, r.marvinSessionId),
      plan: row?.plan ? { total: row.plan.total, seeded: row.plan.seeded } : null,
      transcriptTail: renderTail(projectId, r.marvinSessionId),
      ledgerTail: readLedger(projectId, { tab: r.marvinSessionId, limit: 10 }),
    };
  });
}

export function defaultLoopDeps(): LoopDeps {
  return {
    subscribe: subscribeProjectEvents,
    workDirOf: (projectId) => getProject(projectId)?.workDir ?? null,
    verbDeps: defaultVerbDeps,
    buildItems: defaultBuildItems,
    runWake: (a) => runSupervisorWake(a),
    tabFacts: defaultTabFacts,
    pendingQuestions: defaultPendingQuestions,
  };
}

const G = globalThis as typeof globalThis & { __marvinSupervisorLoop?: SupervisorLoop };

/**
 * The process's loop, started on first call. Route code calls this (chat,
 * session watch, the supervisor routes) so it subscribes in the routes'
 * module graph. Wakes are event-driven, so an enabled supervisor needs no warm-up.
 */
export function ensureSupervisorLoop(): SupervisorLoop {
  if (!G.__marvinSupervisorLoop) {
    G.__marvinSupervisorLoop = new SupervisorLoop(defaultLoopDeps());
    G.__marvinSupervisorLoop.start();
  }
  return G.__marvinSupervisorLoop;
}
