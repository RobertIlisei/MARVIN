/**
 * The supervisor's wake loop (ADR-0127 §2) — deterministic code decides WHEN
 * the supervisor runs; the model decides only what to say.
 *
 * Milestone 1 wakes on one trigger: a pending question (`AskUserQuestion`,
 * by the registry's raising rule) in a tab delegated to the supervisor. The
 * turn-ended, idle-with-open-plan and scope-met triggers arrive with the
 * milestones that act on them (plan, milestones 4 and 5).
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

import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

import { getPendingConfirm } from "./confirm-registry";
import { marvinPaths } from "./paths";
import { readPlanState } from "./plan-state";
import { activeModelLookup } from "./posture";
import { getProject } from "./projects";
import { loadSessionTail } from "./session";
import { readSessionMeta } from "./session-meta";
import { buildSessionWatch } from "./session-watch";
import { runSupervisorWake, type WakeResult } from "./supervisor-dispatch";
import { tabSendRefusal } from "./supervisor-send";
import { appendLedgerEntry, readLedger } from "./supervisor-ledger";
import type { VerbContext, VerbDeps } from "./supervisor-mcp";
import { ActionLimiter } from "./supervisor-policy";
import type { WakeItem } from "./supervisor-prompt";
import {
  delegationRank,
  getSupervisorState,
  isSupervisorSessionId,
  onSupervisorControl,
  overBudget,
  pauseSupervisorForFault,
} from "./supervisor-state";
import { type ProjectEvent, subscribeProjectEvents } from "./turn-registry";

export interface PendingRef {
  marvinSessionId: string;
  turnId: string;
  toolUseId: string;
}

export interface LoopDeps {
  subscribe(listener: (e: ProjectEvent) => void): () => void;
  workDirOf(projectId: string): string | null;
  verbDeps(projectId: string, workDir: string): VerbDeps;
  buildItems(projectId: string, workDir: string, refs: PendingRef[]): Promise<WakeItem[]>;
  runWake(args: { projectId: string; workDir: string; items: WakeItem[]; verbCtx: VerbContext; abortController: AbortController }): Promise<WakeResult>;
}

export class SupervisorLoop {
  private readonly queues = new Map<string, Map<string, PendingRef>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, AbortController>();
  private readonly limiters = new Map<string, ActionLimiter>();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly deps: LoopDeps) {}

  start(): void {
    if (this.unsubscribers.length) return;
    this.unsubscribers.push(this.deps.subscribe((e) => this.onEvent(e)));
    this.unsubscribers.push(
      onSupervisorControl(({ projectId, action }) => {
        if (action === "kill" || action === "stop") this.kill(projectId);
        else if (action === "pause") this.clearTimer(projectId);
        else if (action === "resume" || action === "start" || action === "delegate") this.schedule(projectId);
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    for (const p of [...this.timers.keys()]) this.clearTimer(p);
    for (const c of this.running.values()) c.abort();
  }

  private eligibleTab(projectId: string, marvinSessionId: string): boolean {
    const st = getSupervisorState(projectId);
    return (
      st.mode !== "off" &&
      !isSupervisorSessionId(marvinSessionId) &&
      delegationRank(st.delegation[marvinSessionId]) >= delegationRank("observe")
    );
  }

  private onEvent(e: ProjectEvent): void {
    if (e.event === "confirm.pending") {
      const { projectId, marvinSessionId, turnId, toolUseId } = e.data;
      if (!this.eligibleTab(projectId, marvinSessionId)) return;
      // The registry's raising rule, not the tool name, says it is a question.
      if (getPendingConfirm(turnId, toolUseId)?.raisedBy !== "ask-user-question") return;
      let q = this.queues.get(projectId);
      if (!q) this.queues.set(projectId, (q = new Map()));
      q.set(toolUseId, { marvinSessionId, turnId, toolUseId });
      this.schedule(projectId);
    } else if (e.event === "confirm.resolved") {
      this.queues.get(e.data.projectId)?.delete(e.data.toolUseId);
    }
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
    const refs = [...queue.values()].filter((r) => getPendingConfirm(r.turnId, r.toolUseId) !== null && this.eligibleTab(projectId, r.marvinSessionId));
    queue.clear();
    if (!refs.length) return;
    const workDir = this.deps.workDirOf(projectId);
    if (!workDir) return;

    const abortController = new AbortController();
    this.running.set(projectId, abortController);
    try {
      const items = await this.deps.buildItems(projectId, workDir, refs);
      if (abortController.signal.aborted) return; // killed while the packet was being built
      const verbCtx: VerbContext = {
        projectId,
        workDir,
        wakeId: randomUUID(),
        wake: { acts: 0 },
        limiter: this.limiterFor(projectId),
        deps: this.deps.verbDeps(projectId, workDir),
      };
      await this.deps.runWake({ projectId, workDir, items, verbCtx, abortController });
    } catch (err) {
      appendLedgerEntry(projectId, { kind: "wake", verb: "end", tab: null, wakeId: null, mode: st.mode, reason: `failed: ${(err as Error).message}` });
    } finally {
      this.running.delete(projectId);
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
  };
}

async function defaultBuildItems(projectId: string, workDir: string, refs: PendingRef[]): Promise<WakeItem[]> {
  const st = getSupervisorState(projectId);
  const rows = await buildSessionWatch({ projectId, workDir, sessionIds: [...new Set(refs.map((r) => r.marvinSessionId))] });
  return refs.map((r) => {
    const row = rows.find((x) => x.marvinSessionId === r.marvinSessionId);
    return {
      marvinSessionId: r.marvinSessionId,
      title: row?.title ?? null,
      delegation: st.delegation[r.marvinSessionId] ?? "off",
      turnId: r.turnId,
      toolUseId: r.toolUseId,
      question: getPendingConfirm(r.turnId, r.toolUseId)?.originalInput ?? null,
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
