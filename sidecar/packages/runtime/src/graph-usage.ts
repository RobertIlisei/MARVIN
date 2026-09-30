/**
 * Per-session graph-vs-file usage (ADR-0124 C).
 *
 * The AppStatusBar ratio covered the selected session only and never counted
 * shell reads, so nobody watching four tabs could see which one had stopped
 * asking the graph — measured 2026-09-30, the heaviest tab ran ~3 shell reads
 * per graph call and was summarised mid-task. This keeps three counters per
 * session — graph calls, Read/Grep/Glob source reads, Bash source reads — so
 * `GET /api/sessions/watch` can show every row's ratio.
 *
 * Durable totals live next to the transcript
 * (`<sessionsDir>/<sessionId>.graph-usage.json`), folded in once per turn; the
 * running turn's counts are read live off its design context, so a row moves
 * while the tab works. ADR-0072 holds: nothing here parses a transcript.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { marvinPaths } from "./paths";

export interface GraphUsageCounts {
  graphCalls: number;
  fileReads: number;
  bashReads: number;
}

export interface SessionGraphUsage extends GraphUsageCounts {
  /** (fileReads + bashReads) per graph call, one decimal; null before any graph call. */
  ratio: number | null;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function usagePath(projectId: string, sessionId: string): string | null {
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(sessionId) || projectId.includes("..") || sessionId.includes("..")) return null;
  return join(marvinPaths.sessionsDir(projectId), `${sessionId}.graph-usage.json`);
}

const ZERO: GraphUsageCounts = { graphCalls: 0, fileReads: 0, bashReads: 0 };

function readStored(projectId: string, sessionId: string): GraphUsageCounts {
  const p = usagePath(projectId, sessionId);
  if (!p || !existsSync(p)) return { ...ZERO };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<GraphUsageCounts>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { graphCalls: n(raw.graphCalls), fileReads: n(raw.fileReads), bashReads: n(raw.bashReads) };
  } catch {
    return { ...ZERO };
  }
}

// Same globalThis reason as the job and wakeup registries: the route chunk and
// instrumentation can load separate module copies.
const KEY = "__marvinLiveGraphUsage__";
const g = globalThis as unknown as Record<string, Map<string, () => GraphUsageCounts> | undefined>;
const live: Map<string, () => GraphUsageCounts> = g[KEY] ?? (g[KEY] = new Map());

/** A running turn's counters, read live by the watch feed until the turn folds them in. */
export function registerLiveGraphUsage(projectId: string, sessionId: string, read: () => GraphUsageCounts): void {
  live.set(`${projectId}/${sessionId}`, read);
}

/** Add a finished turn's counts to the session total and stop reading them live. */
export function foldTurnGraphUsage(projectId: string, sessionId: string, turn: GraphUsageCounts): void {
  live.delete(`${projectId}/${sessionId}`);
  if (turn.graphCalls + turn.fileReads + turn.bashReads === 0) return;
  const p = usagePath(projectId, sessionId);
  if (!p) return;
  const before = readStored(projectId, sessionId);
  const next = {
    graphCalls: before.graphCalls + turn.graphCalls,
    fileReads: before.fileReads + turn.fileReads,
    bashReads: before.bashReads + turn.bashReads,
    updatedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    renameSync(tmp, p);
  } catch {
    /* a counter is never a reason to fail a turn */
  }
}

export function usageRatio(c: GraphUsageCounts): number | null {
  if (c.graphCalls === 0) return null;
  return Math.round(((c.fileReads + c.bashReads) / c.graphCalls) * 10) / 10;
}

/** Stored totals plus the running turn's. Null when the session never touched either. */
export function sessionGraphUsage(projectId: string, sessionId: string): SessionGraphUsage | null {
  const stored = readStored(projectId, sessionId);
  const running = live.get(`${projectId}/${sessionId}`)?.() ?? ZERO;
  const c = {
    graphCalls: stored.graphCalls + running.graphCalls,
    fileReads: stored.fileReads + running.fileReads,
    bashReads: stored.bashReads + running.bashReads,
  };
  if (c.graphCalls + c.fileReads + c.bashReads === 0) return null;
  return { ...c, ratio: usageRatio(c) };
}

export function __resetLiveGraphUsageForTests(): void {
  live.clear();
}
