/**
 * Session watch (ADR-0107) — one row per session of a project, with what a
 * person supervising several tabs needs at a glance: is it working, idle,
 * waiting on them, failed, or cut off; where it runs; what it has changed;
 * how far its plan is; what it has cost.
 *
 * This is the COLD-START snapshot behind `GET /api/sessions/watch`. Live
 * updates ride the project event bus (`turn-registry.ts`) through
 * `/api/chat/announce`; the client merges both. Everything here reads state
 * that already exists — the live-turn registry, the confirm registry, the
 * session meta, the plan state, the cost ledger — plus git facts per session
 * (diff badge, worktree state), served stale-while-revalidate so a request
 * never waits on git once a value exists.
 *
 * ADR-0072 applies: nothing here parses a transcript on the hot path.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

import { listPendingConfirms, type PendingConfirmSummary } from "./confirm-registry";
import { sessionCostTotals } from "./cost-tracker";
import { type SessionGraphUsage, sessionGraphUsage } from "./graph-usage";
import { readPlanState } from "./plan-state";
import { listSessionSummaries } from "./session";
import { getActivity, type SessionActivity } from "./session-activity";
import {
  listSessionMetas,
  readSessionMeta,
  resolveSessionCwd,
  type SessionLastTurn,
  type SessionMeta,
  type SessionPosture,
  type SessionTree,
} from "./session-meta";
import { listLiveTurns } from "./turn-registry";
import { type ReconciledWorktree, reconcileSessionWorktreeAsync, reconcileWorktreesAsync } from "./worktrees";

export type SessionWatchState = "working" | "idle" | "awaiting-you" | "failed" | "interrupted";

export interface SessionWatchDiff {
  added: number;
  removed: number;
  files: number;
  untracked: number;
  /** What the numbers are measured against. */
  vs: "base" | "HEAD";
  computedAt: string;
}

/**
 * ADR-0111 — the sidecar's derived state of a tab's worktree, so the close
 * decision and the integration section work from facts, not the client's
 * guess. `behind` is how many commits the current branch of the main checkout
 * has that this branch does not.
 */
export interface SessionWatchWorktree {
  slug: string;
  branch: string;
  state: ReconciledWorktree["state"];
  commits: number;
  dirty: boolean;
  base: string;
  behind: number;
  /** Set when the tab is closed (the record left the `session` state). */
  closed: boolean;
  mergedInto?: string | undefined;
  /** The MAIN checkout's current branch — what a merge would land on. Not the tab's own branch. */
  target: string | null;
}

export interface SessionWatchRow {
  marvinSessionId: string;
  projectId: string;
  state: SessionWatchState;
  /** ADR-0111 — null for a shared tab or before the first message. */
  worktree: SessionWatchWorktree | null;
  turn: { turnId: string; kind: "human" | "machine"; startedAt: string; mutated: boolean } | null;
  /** What the live turn is doing now (thinking / writing / tool + name); null when idle. */
  activity: SessionActivity | null;
  pending: PendingConfirmSummary[];
  /** `currentBranch` is what git reports for the checkout now; a worktree's own `branch` is the one it was cut on. */
  tree: SessionTree & { cwd: string; currentBranch: string | null; present: boolean };
  diff: SessionWatchDiff | null;
  /** ADR-0124 — `open` excludes superseded steps; `lastTodoAt` is the ADR-0116
   *  watermark (the last TodoWrite the sidecar joined), `seeded` marks a plan
   *  MARVIN seeded from the brief. */
  plan: SessionPlanProgress | null;
  /** ADR-0124 — graph calls vs source reads (Read/Grep/Glob and Bash), whole session. */
  graphUsage: SessionGraphUsage | null;
  lastTurn: SessionLastTurn | null;
  cost: { turns: number; costUsd: number };
  title: string | null;
  updatedAt: string;
  /** ADR-0108 — the posture this session's turns last ran with, so a client
   *  restoring a tab shows the mode / models / gate it had, not app defaults. */
  posture: SessionPosture | null;
}

/** The one derivation the UI trusts. Pure, so it is pinned by tests. */
export function deriveSessionState(input: {
  live: boolean;
  pending: number;
  lastOutcome?: SessionLastTurn["outcome"] | undefined;
  /** When the last turn started; an `interrupted` older than the window reads as idle. */
  lastStartedAt?: string | undefined;
  now?: number | undefined;
}): SessionWatchState {
  if (input.live && input.pending > 0) return "awaiting-you";
  if (input.live) return "working";
  if (input.lastOutcome === "interrupted") {
    // ADR-0107 addendum 2 — a months-old cut-off is history, not a call to
    // action; the resume offer only makes sense for a recent one.
    const startedMs = input.lastStartedAt ? Date.parse(input.lastStartedAt) : Number.NaN;
    if (Number.isFinite(startedMs) && (input.now ?? Date.now()) - startedMs > RECENT_WINDOW_MS) return "idle";
    return "interrupted";
  }
  if (input.lastOutcome === "error") return "failed";
  return "idle";
}

// ── git facts, never on the request's critical path ──────────────────────
//
// Every git read here used to be `execFileSync` on the request thread, and one
// snapshot fanned out into a full worktree reconcile (~150–200 spawns on a
// project with 24 worktrees) plus four calls per row. A CPU profile on
// 2026-09-30 put 4.9 s of every 25 s inside this route, freezing the whole
// sidecar — backlog, git status and health all queued behind it.
//
// Now each fact is async and stale-while-revalidate: a cached value is served
// at once, however old; a stale one triggers ONE background refresh (callers
// share the in-flight promise). Only the very first request for a key waits.
// Git state lags by at most a refresh; the live parts of a row (state,
// activity, confirms) are in-memory and always current.

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

interface Fact<T> {
  at: number;
  value?: T;
  hasValue: boolean;
  inflight?: Promise<T> | undefined;
}

function cached<T>(memo: Map<string, Fact<T>>, key: string, ttlMs: number, now: number, compute: () => Promise<T>): Promise<T> {
  const entry = memo.get(key) ?? { at: 0, hasValue: false };
  memo.set(key, entry);
  const refresh = (): Promise<T> => {
    entry.inflight ??= compute()
      .then((value) => {
        entry.value = value;
        entry.hasValue = true;
        entry.at = now;
        return value;
      })
      .finally(() => {
        entry.inflight = undefined;
      });
    return entry.inflight;
  };
  if (!entry.hasValue) return refresh();
  if (now - entry.at >= ttlMs) void refresh().catch(() => {});
  return Promise.resolve(entry.value as T);
}

const GIT_FACT_MS = 5_000;
const branchMemo = new Map<string, Fact<string | null>>();
const behindMemo = new Map<string, Fact<number>>();

function currentBranch(cwd: string, now: number): Promise<string | null> {
  return cached(branchMemo, cwd, GIT_FACT_MS, now, async () => (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])) || null);
}

const DIFF_MEMO_MS = GIT_FACT_MS;
const diffMemo = new Map<string, Fact<SessionWatchDiff | null>>();

// ADR-0111 — one reconcile per project per refresh, not one per row. It is the
// most expensive fact here, so it refreshes least often.
const RECONCILE_MEMO_MS = 10_000;
const reconcileMemo = new Map<string, Fact<ReconciledWorktree[]>>();

function reconciledSessionTrees(workDir: string, now: number): Promise<ReconciledWorktree[]> {
  return cached(reconcileMemo, workDir, RECONCILE_MEMO_MS, now, async () => {
    try {
      return (await reconcileWorktreesAsync(workDir, now)).filter((w) => w.kind === "session");
    } catch {
      return [];
    }
  });
}

/** Commits on the main checkout's current branch that `branch` lacks. */
function behindMain(workDir: string, branch: string, now: number): Promise<number> {
  return cached(behindMemo, `${workDir}\0${branch}`, GIT_FACT_MS, now, async () =>
    Number(await git(workDir, ["rev-list", "--count", `${branch}..HEAD`])) || 0,
  );
}

/**
 * `fresh` bypasses every memo and derives this one tree from git now. The
 * tab-close decision needs it: it can discard a tree it believes empty, and a
 * cached "empty" may predate the agent's last commit.
 */
export async function sessionWorktreeInfo(
  workDir: string,
  sessionId: string,
  now = Date.now(),
  fresh = false,
): Promise<SessionWatchWorktree | null> {
  const w = fresh
    ? await reconcileSessionWorktreeAsync(workDir, sessionId, now)
    : (await reconciledSessionTrees(workDir, now)).find((r) => r.sessionId === sessionId);
  if (!w) return null;
  return {
    slug: w.slug,
    branch: w.branch,
    state: w.state,
    commits: w.commits,
    dirty: w.dirty,
    base: w.base,
    behind: fresh ? Number(await git(workDir, ["rev-list", "--count", `${w.branch}..HEAD`])) || 0 : await behindMain(workDir, w.branch, now),
    closed: !!w.finishedAt,
    target: fresh ? (await git(workDir, ["symbolic-ref", "--short", "-q", "HEAD"])) || null : await currentBranch(workDir, now),
    ...(w.mergedInto ? { mergedInto: w.mergedInto } : {}),
  };
}

export function __resetSessionReconcileMemoForTests(): void {
  reconcileMemo.clear();
  behindMemo.clear();
  branchMemo.clear();
}

/**
 * `+N −M` for the row. A worktree session is measured against the commit it
 * was cut from — committed AND uncommitted work on the branch — so the badge
 * says "what this tab has produced". A shared session is measured against
 * HEAD, which is the only baseline a shared checkout has.
 */
export function sessionDiff(cwd: string, base: string | null, now = Date.now()): Promise<SessionWatchDiff | null> {
  return cached(diffMemo, `${cwd}\0${base ?? "HEAD"}`, DIFF_MEMO_MS, now, async () => {
    if (!existsSync(cwd)) return null;
    const numstat = await git(cwd, ["diff", "--numstat", base ?? "HEAD"]);
    if (numstat === null) return null;
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [a, r] = line.split("\t");
      files += 1;
      // Binary files show as `-`; count the file, not the lines.
      added += Number.parseInt(a ?? "", 10) || 0;
      removed += Number.parseInt(r ?? "", 10) || 0;
    }
    const untrackedOut = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])) ?? "";
    const untracked = untrackedOut ? untrackedOut.split("\n").filter(Boolean).length : 0;
    return { added, removed, files, untracked, vs: base ? "base" : "HEAD", computedAt: new Date().toISOString() };
  });
}

/** Test seam. */
export function __resetSessionDiffMemoForTests(): void {
  diffMemo.clear();
}

// ── plan progress from the persisted spine ───────────────────────────────

export interface SessionPlanProgress {
  done: number;
  total: number;
  open: number;
  lastTodoAt: string | null;
  seeded: boolean;
}

export function planProgress(projectId: string, sessionId: string): SessionPlanProgress | null {
  const res = readPlanState(projectId, sessionId);
  if (!res.ok || !res.state || typeof res.state !== "object") return null;
  const st = res.state as { plans?: unknown; activePlanId?: unknown };
  if (!Array.isArray(st.plans)) return null;
  const activeId = typeof st.activePlanId === "string" ? st.activePlanId : null;
  const plans = st.plans as Array<{ id?: unknown; steps?: unknown; seeded?: unknown }>;
  const plan = plans.find((p) => p && p.id === activeId) ?? plans[0];
  if (!plan || !Array.isArray(plan.steps)) return null;
  const steps = plan.steps as Array<{ status?: unknown }>;
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s && s.status === "completed").length;
  const superseded = steps.filter((s) => s && s.status === "superseded").length;
  const lastTodoAt = typeof (st as { lastTodoAt?: unknown }).lastTodoAt === "string" ? (st as { lastTodoAt: string }).lastTodoAt : null;
  return { done, total: steps.length, open: steps.length - done - superseded, lastTodoAt, seeded: !!plan.seeded };
}

// ── the snapshot ──────────────────────────────────────────────────────────

const RECENT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_ROWS = 50;

export interface BuildSessionWatchInput {
  projectId: string;
  /** The project root — the tree a pre-0107 session (no meta) runs in. */
  workDir: string;
  /** Sessions the client has open; always included. */
  sessionIds?: string[] | undefined;
  now?: number | undefined;
  /** Derive the requested sessions' worktrees from git now, bypassing the
   *  memo — for a decision that can discard work (the tab close). */
  fresh?: boolean | undefined;
}

export async function buildSessionWatch(input: BuildSessionWatchInput): Promise<SessionWatchRow[]> {
  const now = input.now ?? Date.now();
  const { projectId, workDir } = input;

  const live = new Map(listLiveTurns(projectId).map((t) => [t.marvinSessionId, t]));
  const metas = new Map(listSessionMetas(projectId).map((m) => [m.marvinSessionId, m]));
  const summaries = new Map(listSessionSummaries(projectId).map((s) => [s.sessionId, s]));
  const costs = sessionCostTotals(projectId);

  // Universe: what the client has open, plus anything live, plus recently
  // touched metas that are not closed — bounded.
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const id of input.sessionIds ?? []) push(id);
  for (const id of live.keys()) push(id);
  const recentMetas = [...metas.values()]
    .filter((m) => !m.closedAt && now - Date.parse(m.updatedAt) < RECENT_WINDOW_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const m of recentMetas) {
    if (ids.length >= MAX_ROWS) break;
    push(m.marvinSessionId);
  }
  // ADR-0111 — a closed tab whose branch still holds work must not fall out
  // of sight: it is what the Ready-to-integrate section lists.
  for (const w of await reconciledSessionTrees(workDir, now)) {
    if (ids.length >= MAX_ROWS) break;
    if (w.state === "ready" && w.sessionId) push(w.sessionId);
  }

  // Rows resolve concurrently: each one's git facts are independent.
  return Promise.all(ids.slice(0, MAX_ROWS).map(async (id) => {
    const meta: SessionMeta | null = metas.get(id) ?? readSessionMeta(projectId, id);
    const turn = live.get(id) ?? null;
    const pending = turn ? listPendingConfirms(turn.turnId) : [];
    const tree: SessionTree = meta?.tree ?? { mode: "shared" };
    const cwdInfo = meta ? resolveSessionCwd(meta) : { cwd: workDir, present: existsSync(workDir) };
    const base = tree.mode === "worktree" ? tree.base : null;
    const summary = summaries.get(id);
    const cost = costs.get(id) ?? { turns: 0, costUsd: 0 };
    return {
      marvinSessionId: id,
      projectId,
      state: deriveSessionState({
        live: !!turn,
        pending: pending.length,
        lastOutcome: meta?.lastTurn?.outcome,
        lastStartedAt: meta?.lastTurn?.startedAt,
        now,
      }),
      turn: turn
        ? { turnId: turn.turnId, kind: turn.kind, startedAt: new Date(turn.startedAt).toISOString(), mutated: turn.mutated }
        : null,
      activity: turn ? getActivity(id) : null,
      worktree: tree.mode === "worktree"
        ? await sessionWorktreeInfo(workDir, id, now, !!input.fresh && (input.sessionIds ?? []).includes(id))
        : null,
      pending,
      tree: {
        ...tree,
        cwd: cwdInfo.cwd,
        currentBranch: cwdInfo.present ? await currentBranch(cwdInfo.cwd, now) : null,
        present: cwdInfo.present,
      },
      diff: cwdInfo.present ? await sessionDiff(cwdInfo.cwd, base, now) : null,
      plan: planProgress(projectId, id),
      graphUsage: sessionGraphUsage(projectId, id),
      lastTurn: meta?.lastTurn ?? null,
      cost,
      title: meta?.title ?? summary?.firstUserMessage ?? null,
      updatedAt: meta?.updatedAt ?? summary?.updatedAt ?? new Date(now).toISOString(),
      posture: meta?.posture ?? null,
    };
  }));
}
