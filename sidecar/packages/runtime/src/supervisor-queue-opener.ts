/**
 * The approved queue's opener (ADR-0133) — the RUNTIME opens tabs, never the
 * model. No supervisor verb opens a queued tab; the supervisor may propose
 * entries, lower the cap in an alarm and hold an entry, and that is all.
 *
 * A pass opens the next entry only when, in this order:
 *  - this process holds the project's opener lock (one opener per project);
 *  - the entry is approved (`readQueue` drops what the user did not approve),
 *    not held, not expired, and every `after` entry's branch is `merged` in the
 *    DERIVED worktree state (ADR-0103), not a recorded one;
 *  - `scopeRef`, when given, still holds in the project's own plan (plan [5.5]);
 *  - the supervisor is on and not paused;
 *  - open tabs in the project (every tab that is not the supervisor's own,
 *    whoever opened it) are under the user's cap;
 *  - the disk floor of ADR-0122 holds;
 *  - the user's guard command exits 0 (plan [5.4]).
 * It then opens the entry through `openSupervisorTab` — ADR-0122's atomic path:
 * a fresh worktree or a refusal — at the entry's approved posture. One entry,
 * one tab; the queue never closes a tab to make room. Everything it does or
 * refuses is a supervisor-ledger line.
 *
 * Woken by the project event stream (a tab closing, an approval, a cap change,
 * a turn ending) — never a timer.
 */

import { randomUUID } from "node:crypto";

import { listSessionMetas, readSessionMeta } from "./session-meta";
import { digestArgs, appendLedgerEntry, type LedgerEntryInput } from "./supervisor-ledger";
import { openSupervisorTab } from "./supervisor-inbox-perform";
import { type QueueBlock, type QueueEntry, type QueueFile, effectiveCap, readQueue, updateQueue } from "./supervisor-queue";
import { runGuardCommand } from "./supervisor-queue-guard";
import { acquireQueueLock, isPidAlive } from "./supervisor-queue-lock";
import { currentSupervisorToken, getSupervisorState, isSupervisorSessionId, listEnabledSupervisors } from "./supervisor-state";
import { getLiveTurn, type ProjectEvent, subscribeProjectEvents } from "./turn-registry";
import { getProject } from "./projects";
import { readWorktreeSetupConfig } from "./worktree-setup";
import { freeDiskBytes, reconcileWorktreesAsync, worktreeMinFreeBytes } from "./worktrees";

/** A tab untouched for this long and never closed is not "open" for the cap — the Sessions pane's own horizon. */
const OPEN_TAB_WINDOW_MS = 7 * 24 * 3600 * 1000;

export type GuardResult = { ok: true } | { ok: false; exitCode: number | null; timedOut: boolean; detail: string };
export type ScopeVerdict = { ok: true } | { ok: false; reason: string; detail: string };
export type OpenResult = { ok: true; marvinSessionId: string; branch: string | null } | { ok: false; code: string; error: string; tabExists: boolean };

export interface OpenerDeps {
  pid: number;
  isAlive(pid: number): boolean;
  now(): number;
  workDirOf(projectId: string): string | null;
  /** Why the supervisor cannot open tabs now (off, paused), or null. */
  supervisorRefusal(projectId: string): string | null;
  /** Open tabs in the project that are not the supervisor's own. */
  openTabCount(projectId: string): number;
  /** Branches whose DERIVED state is `merged` (ADR-0103). */
  mergedBranches(projectId: string, workDir: string): Promise<Set<string>>;
  /** Why the ADR-0122 disk floor does not hold, or null. */
  diskRefusal(workDir: string): string | null;
  /** The user's guard command (plan [5.4]); absent = no guard. */
  runGuard?(projectId: string, workDir: string, command: string): Promise<GuardResult>;
  /** `scopeRef` against the project's plan (plan [5.5]); absent = unchecked. */
  checkScope?(projectId: string, workDir: string, entry: QueueEntry): ScopeVerdict;
  /** A scope miss is raised to the user (plan [5.5]). */
  escalate?(projectId: string, entry: QueueEntry, detail: string): void;
  /** ADR-0122's atomic path. */
  open(projectId: string, workDir: string, entry: QueueEntry, ledgerId: string): Promise<OpenResult>;
}

export function defaultOpenerDeps(): OpenerDeps {
  return {
    pid: process.pid,
    isAlive: isPidAlive,
    now: () => Date.now(),
    workDirOf: (projectId) => getProject(projectId)?.workDir ?? null,
    supervisorRefusal: (projectId) => {
      const s = getSupervisorState(projectId);
      if (s.mode === "off") return "the supervisor is off";
      if (s.paused) return "the supervisor is paused";
      return null;
    },
    openTabCount: (projectId) => {
      const now = Date.now();
      return listSessionMetas(projectId).filter((m) => {
        if (m.closedAt || isSupervisorSessionId(m.marvinSessionId)) return false;
        const live = getLiveTurn(m.marvinSessionId);
        return (!!live && !live.ended) || now - Date.parse(m.updatedAt) < OPEN_TAB_WINDOW_MS;
      }).length;
    },
    mergedBranches: async (_projectId, workDir) => new Set((await reconcileWorktreesAsync(workDir)).filter((w) => w.state === "merged").map((w) => w.branch)),
    diskRefusal: (workDir) => {
      const floor = worktreeMinFreeBytes(readWorktreeSetupConfig(workDir).minFreeGb);
      if (floor <= 0) return null;
      try {
        const free = freeDiskBytes(workDir);
        return free < floor ? `free disk space is below the worktree floor (${Math.round(free / 1024 ** 3)} GB < ${Math.round(floor / 1024 ** 3)} GB)` : null;
      } catch {
        return null; // an unreadable volume is git's to report, with a real error
      }
    },
    // ADR-0133 decision 1 — the command comes from the queue (the user approved it on a card), never from a file in the project.
    runGuard: (_projectId, workDir, command) => runGuardCommand(workDir, command),
    open: async (projectId, workDir, entry, ledgerId) => {
      const r = await openSupervisorTab(
        projectId,
        workDir,
        {
          firstMessage: entry.brief,
          title: entry.title,
          // The posture the user approved on the card — never wider.
          posture: entry.posture,
          grounds: [],
          ledgerId,
          editedByUser: false,
          delegation: "answer-questions",
          follow: null,
        },
        currentSupervisorToken(),
      );
      if (r.ok) {
        const tree = readSessionMeta(projectId, r.marvinSessionId)?.tree;
        return { ok: true, marvinSessionId: r.marvinSessionId, branch: tree?.mode === "worktree" ? tree.branch : null };
      }
      // Before the worktree existed nothing was created, so a retry is safe; after, the tab is there and must not be opened twice.
      return { ok: false, code: r.code ?? "refused", error: r.error, tabExists: !(r.code === "worktree-failed" || r.code === "meta-failed" || r.code === "budget") };
    },
  };
}

const ledger = (projectId: string, line: Pick<LedgerEntryInput, "verb" | "decision" | "reason"> & Partial<LedgerEntryInput>): void => {
  try {
    appendLedgerEntry(projectId, { kind: "control", tab: null, wakeId: null, ...line });
  } catch {
    /* a ledger write must not stop the queue; the entry's own block still says why */
  }
};

/** What the opener's pass decided about one project, for tests and the route. */
export interface PassResult {
  opened: string[];
  lock: "ours" | "held";
}

export class QueueOpener {
  private readonly running = new Set<string>();
  private readonly again = new Set<string>();
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: OpenerDeps) {}

  /** Subscribe to the project event stream; one pass per project at start for the supervisors already on. */
  start(subscribe: (l: (e: ProjectEvent) => void) => () => void = subscribeProjectEvents): void {
    if (this.unsub) return;
    this.unsub = subscribe((e) => {
      const d = e.data as { projectId?: string; change?: string };
      if (!d.projectId) return;
      // The opener's own bookkeeping (`blocked`, `opened`) is not a reason to look again.
      if (e.event === "supervisor.queue" && !["approved", "released", "cap", "cap-restored", "cap-lowered", "guard"].includes(d.change ?? "")) return;
      if (e.event === "supervisor.queue" || e.event === "session.closed" || e.event === "turn.ended" || e.event === "supervisor.state") void this.kick(d.projectId);
    });
    for (const s of listEnabledSupervisors()) void this.kick(s.projectId);
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /**
   * Look at the project's queue now. Passes never overlap in a process: a kick
   * during a pass asks for one more when it ends, so a burst of triggers is
   * one pass at a time and the cap is re-counted after every opening.
   */
  async kick(projectId: string): Promise<PassResult | null> {
    if (this.running.has(projectId)) {
      this.again.add(projectId);
      return null;
    }
    this.running.add(projectId);
    let last: PassResult | null = null;
    try {
      do {
        this.again.delete(projectId);
        last = await this.pass(projectId);
      } while (this.again.has(projectId));
    } catch (err) {
      ledger(projectId, { verb: "queue.error", decision: "refuse", reason: `the opener failed: ${(err as Error).message.slice(0, 200)}`, reasonCode: "opener-error" });
    } finally {
      this.running.delete(projectId);
    }
    return last;
  }

  private setBlocked(projectId: string, ids: readonly string[], block: Omit<QueueBlock, "at"> | null): void {
    const q = readQueue(projectId);
    const changed = ids.filter((id) => {
      const e = q.entries.find((x) => x.id === id);
      return e && (e.blocked?.code !== block?.code || e.blocked?.reason !== block?.reason) && !(block === null && !e.blocked);
    });
    if (!changed.length) return;
    updateQueue(projectId, "blocked", (f) => {
      for (const id of changed) {
        const e = f.entries.find((x) => x.id === id);
        if (e) e.blocked = block ? { ...block, at: new Date(this.deps.now()).toISOString() } : null;
      }
    });
  }

  private async pass(projectId: string): Promise<PassResult> {
    const opened: string[] = [];
    const workDir = this.deps.workDirOf(projectId);
    if (!workDir) return { opened, lock: "ours" };
    // Nothing queued: no lock to take, no work to do.
    if (!readQueue(projectId).entries.some((e) => e.status === "queued" || e.status === "opening")) return { opened, lock: "ours" };
    if (acquireQueueLock(projectId, { pid: this.deps.pid, isAlive: this.deps.isAlive }) === "held") {
      ledger(projectId, { verb: "queue.refused", decision: "refuse", reason: "another process holds this project's opener lock — this one opens nothing", reasonCode: "lock-held" });
      return { opened, lock: "held" };
    }
    this.interrupted(projectId);

    for (let guardTurns = 0; guardTurns < 50; guardTurns++) {
      const q = readQueue(projectId);
      const merged = await this.deps.mergedBranches(projectId, workDir);
      const eligible: QueueEntry[] = [];
      for (const e of q.entries) {
        if (e.status !== "queued") continue;
        const block = this.entryBlock(projectId, workDir, q, e, merged);
        if (block) this.setBlocked(projectId, [e.id], block);
        else eligible.push(e);
      }
      const next = eligible[0];
      if (!next) break;
      const hold = this.globalBlock(projectId, workDir, q);
      if (hold) {
        this.setBlocked(projectId, eligible.map((e) => e.id), hold);
        break;
      }
      const guard = await this.guard(projectId, workDir, q);
      if (guard) {
        this.setBlocked(projectId, eligible.map((e) => e.id), guard);
        break;
      }
      this.setBlocked(projectId, [next.id], null);
      const done = await this.openOne(projectId, workDir, next);
      if (!done) break;
      opened.push(next.id);
    }
    return { opened, lock: "ours" };
  }

  /** Why this entry cannot open whatever the cap says (its own conditions), or null. */
  private entryBlock(projectId: string, workDir: string, q: QueueFile, e: QueueEntry, merged: Set<string>): Omit<QueueBlock, "at"> | null {
    if (e.hold) return { code: "held", reason: `held by the supervisor: ${e.hold.reason}` };
    for (const a of e.after ?? []) {
      const pred = q.entries.find((x) => x.id === a);
      if (!pred || pred.status === "removed" || pred.status === "expired" || pred.status === "failed") return { code: "after", reason: `waiting for "${a}", which is ${pred ? pred.status : "not in the queue"} and will not merge` };
      if (pred.status !== "opened" || !pred.openedBranch) return { code: "after", reason: `waiting for "${a}" to open and merge` };
      // The derived state, read from git now — a branch the user merged in a terminal releases its successors.
      if (!merged.has(pred.openedBranch)) return { code: "after", reason: `waiting for "${a}" (${pred.openedBranch}) to be merged` };
    }
    if (e.scopeRef && this.deps.checkScope) {
      const v = this.deps.checkScope(projectId, workDir, e);
      if (!v.ok) {
        // Raised once per distinct miss, not on every pass.
        if (e.blocked?.code !== "scope" || e.blocked.reason !== v.reason) {
          this.deps.escalate?.(projectId, e, v.detail);
          ledger(projectId, { verb: "queue.scope", decision: "escalate", reason: `held "${e.id}": ${v.detail}`, reasonCode: "scope", argsDigest: digestArgs({ id: e.id }) });
        }
        return { code: "scope", reason: v.reason };
      }
    }
    return null;
  }

  /** Conditions on the project, not the entry. */
  private globalBlock(projectId: string, workDir: string, q: QueueFile): Omit<QueueBlock, "at"> | null {
    const sup = this.deps.supervisorRefusal(projectId);
    if (sup) return { code: "supervisor", reason: `${sup} — the queue waits` };
    const cap = effectiveCap(q);
    const count = this.deps.openTabCount(projectId);
    if (count >= cap) return { code: "cap", reason: `${count} tab${count === 1 ? "" : "s"} open, cap ${cap}${q.capLowered ? ` (lowered from ${q.cap}: ${q.capLowered.reason})` : ""}` };
    const disk = this.deps.diskRefusal(workDir);
    if (disk) return { code: "disk", reason: disk };
    return null;
  }

  /** The user's guard command (plan [5.4]). */
  private async guard(projectId: string, workDir: string, q: QueueFile): Promise<Omit<QueueBlock, "at"> | null> {
    if (!q.guard || !this.deps.runGuard) return null;
    const r = await this.deps.runGuard(projectId, workDir, q.guard.command);
    updateQueue(projectId, "blocked", (f) => {
      f.guardLast = { at: new Date(this.deps.now()).toISOString(), ok: r.ok, exitCode: r.ok ? 0 : r.exitCode, timedOut: !r.ok && r.timedOut };
    });
    if (r.ok) return null;
    const why = r.timedOut ? "timed out" : r.exitCode === null ? `did not run: ${r.detail}` : `exited ${r.exitCode}`;
    ledger(projectId, { verb: "queue.guard", decision: "refuse", reason: `the guard command ${why} — the queue is held`, reasonCode: "guard", argsDigest: digestArgs({ command: q.guard.command }) });
    return { code: "guard", reason: `the guard command ${why}` };
  }

  private async openOne(projectId: string, workDir: string, e: QueueEntry): Promise<boolean> {
    const lineId = randomUUID();
    // Written before the tab exists: a crash mid-open leaves "opening", which is never opened again on its own.
    updateQueue(projectId, "opening", (f) => {
      const t = f.entries.find((x) => x.id === e.id);
      if (t) t.status = "opening";
    });
    const r = await this.deps.open(projectId, workDir, e, lineId);
    if (r.ok) {
      updateQueue(projectId, "opened", (f) => {
        const t = f.entries.find((x) => x.id === e.id);
        if (!t) return;
        t.status = "opened";
        t.openedAt = new Date(this.deps.now()).toISOString();
        t.openedSessionId = r.marvinSessionId;
        if (r.branch) t.openedBranch = r.branch;
        t.blocked = null;
      });
      ledger(projectId, { id: lineId, tab: r.marvinSessionId, verb: "queue.opened", decision: "act", reason: `opened queued entry "${e.id}" (${e.title}) in a fresh worktree at the posture the user approved`, reasonCode: "approved-queue", argsDigest: digestArgs({ id: e.id }) });
      return true;
    }
    updateQueue(projectId, "blocked", (f) => {
      const t = f.entries.find((x) => x.id === e.id);
      if (!t) return;
      // A tab that exists is never opened again; a refusal before one existed may retry.
      t.status = r.tabExists ? "failed" : "queued";
      t.blocked = { code: r.code, reason: r.error.slice(0, 400), at: new Date(this.deps.now()).toISOString() };
    });
    ledger(projectId, { id: lineId, verb: "queue.refused", decision: "refuse", reason: `could not open "${e.id}": ${r.error}`, reasonCode: r.code, argsDigest: digestArgs({ id: e.id }) });
    return false;
  }

  /** An "opening" left by a process that died mid-open: the tab may exist, so it is never opened on the queue's say-so again. */
  private interrupted(projectId: string): void {
    const stuck = readQueue(projectId).entries.filter((e) => e.status === "opening");
    if (!stuck.length) return;
    updateQueue(projectId, "blocked", (f) => {
      for (const e of f.entries) {
        if (e.status !== "opening") continue;
        e.status = "failed";
        e.blocked = { code: "interrupted", reason: "an earlier opening did not finish — check the tab list, then release or remove this entry", at: new Date(this.deps.now()).toISOString() };
      }
    });
    for (const e of stuck) ledger(projectId, { verb: "queue.refused", decision: "refuse", reason: `"${e.id}" was mid-opening when the process ended — held for the user`, reasonCode: "interrupted" });
  }
}

const G = globalThis as typeof globalThis & { __marvinQueueOpener?: QueueOpener };

/** The process's opener, started on first call (from the supervisor loop's own start). */
export function ensureQueueOpener(): QueueOpener {
  if (!G.__marvinQueueOpener) {
    G.__marvinQueueOpener = new QueueOpener(defaultOpenerDeps());
    G.__marvinQueueOpener.start();
  }
  return G.__marvinQueueOpener;
}
