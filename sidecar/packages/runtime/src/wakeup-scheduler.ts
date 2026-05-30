/**
 * Self-scheduled wakeups (ADR-0031).
 *
 * MARVIN used to *narrate* asynchronous follow-through ("Monitor armed —
 * I'll continue when it reports") that it could not perform: a turn is a
 * detached async loop started only by `POST /api/chat`, and nothing
 * re-enters it once it ends. This module gives that promise a real
 * mechanism — a bounded server-side timer that starts a fresh turn after
 * a delay, resuming the same SDK session.
 *
 * This is the **core**: pure data + timers + persistence. It deliberately
 * does NOT know how to run a turn. The app layer injects an `onFire`
 * handler (`setWakeupFireHandler`) at server boot and the handler is what
 * actually dispatches the turn — keeping the dependency direction clean
 * (app → runtime, never the reverse).
 *
 * Bounds (the rails that stop this becoming a runaway autonomous loop):
 *   - delay clamped to [60 s, 24 h];
 *   - at most {@link MAX_PENDING_PER_SESSION} pending per marvinSessionId;
 *   - a wakeup-started turn may chain to depth {@link MAX_CHAIN_DEPTH};
 *   - past-due-on-boot fires once (not N times); >24 h stale is dropped.
 *
 * Single-process, in-memory timers — consistent with `turn-registry`'s
 * existing "MARVIN is a single-process web app" assumption.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import { ensureDir, marvinPaths } from "./paths";

export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 86_400; // 24 h
export const MAX_PENDING_PER_SESSION = 5;
/** Max self-reschedule chain length before a wakeup is dropped as runaway. */
export const MAX_CHAIN_DEPTH = 8;
/** A wakeup more than this far past its fire time at boot is stale, dropped. */
const STALE_AFTER_MS = MAX_DELAY_SECONDS * 1000;

/**
 * Everything needed to dispatch the future turn. Mirrors the turn config
 * the scheduling turn ran under so the wakeup turn inherits the same
 * model / permission posture (ADR-0031 — no capability elevation).
 */
export interface WakeupRecord {
  id: string;
  marvinSessionId: string;
  projectId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral";
  permissionStrategy: "auto" | "gated";
  thinkingMode: string;
  /** The message injected as the wakeup turn's prompt (already prefixed). */
  prompt: string;
  /** Human reason shown back to MARVIN/the user. */
  reason: string;
  /** ISO timestamp the wakeup was created. */
  createdAt: string;
  /** Epoch ms when the wakeup should fire. */
  fireAt: number;
  /** Position in a self-reschedule chain (0 = scheduled by a human turn). */
  depth: number;
}

interface WakeupFile {
  wakeups: WakeupRecord[];
}

export interface ScheduleWakeupInput {
  marvinSessionId: string;
  projectId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral";
  permissionStrategy: "auto" | "gated";
  thinkingMode: string;
  delaySeconds: number;
  reason: string;
  prompt: string;
  /** Depth of the turn doing the scheduling (a wakeup turn passes its own). */
  schedulingDepth: number;
}

export type ScheduleResult =
  | { ok: true; record: WakeupRecord }
  | { ok: false; error: string };

type FireHandler = (record: WakeupRecord) => void | Promise<void>;

// ── Module state (single-process) ──────────────────────────────────────
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let fireHandler: FireHandler | null = null;
let armed = false;

/**
 * Inject the turn-dispatch handler. Called once from the app server-boot
 * hook (`instrumentation.ts`). Until set, a fired wakeup is a no-op aside
 * from removing itself — so a wakeup that fires before the handler is wired
 * (vanishingly unlikely; boot order arms after injection) is simply lost,
 * never duplicated.
 */
export function setWakeupFireHandler(handler: FireHandler): void {
  fireHandler = handler;
}

// ── Persistence ────────────────────────────────────────────────────────
function readFile(projectId: string): WakeupFile {
  const path = marvinPaths.wakeupsFile(projectId);
  if (!existsSync(path)) return { wakeups: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as WakeupFile;
    if (!parsed || !Array.isArray(parsed.wakeups)) return { wakeups: [] };
    return parsed;
  } catch {
    return { wakeups: [] };
  }
}

function writeFile(projectId: string, data: WakeupFile): void {
  const path = marvinPaths.wakeupsFile(projectId);
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function persist(record: WakeupRecord): void {
  const file = readFile(record.projectId);
  file.wakeups = file.wakeups.filter((w) => w.id !== record.id);
  file.wakeups.push(record);
  writeFile(record.projectId, file);
}

function unpersist(projectId: string, id: string): void {
  const file = readFile(projectId);
  const next = file.wakeups.filter((w) => w.id !== id);
  if (next.length !== file.wakeups.length) writeFile(projectId, { wakeups: next });
}

// ── Public API ─────────────────────────────────────────────────────────

/** Pending (not-yet-fired) wakeups, optionally scoped to one session. */
export function listWakeups(filter?: {
  marvinSessionId?: string;
  projectId?: string;
}): WakeupRecord[] {
  const projectIds = filter?.projectId
    ? [filter.projectId]
    : listProjectIds();
  const out: WakeupRecord[] = [];
  for (const pid of projectIds) {
    for (const w of readFile(pid).wakeups) {
      if (filter?.marvinSessionId && w.marvinSessionId !== filter.marvinSessionId) {
        continue;
      }
      out.push(w);
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

export function scheduleWakeup(input: ScheduleWakeupInput): ScheduleResult {
  const delay = Math.round(input.delaySeconds);
  if (!Number.isFinite(delay) || delay < MIN_DELAY_SECONDS) {
    return {
      ok: false,
      error: `delaySeconds must be ≥ ${MIN_DELAY_SECONDS} (1 minute).`,
    };
  }
  if (delay > MAX_DELAY_SECONDS) {
    return {
      ok: false,
      error: `delaySeconds must be ≤ ${MAX_DELAY_SECONDS} (24 hours).`,
    };
  }
  const nextDepth = input.schedulingDepth + 1;
  if (nextDepth > MAX_CHAIN_DEPTH) {
    return {
      ok: false,
      error: `wakeup chain depth ${nextDepth} exceeds the cap of ${MAX_CHAIN_DEPTH} — refusing to schedule another self-wakeup.`,
    };
  }
  const pending = listWakeups({ marvinSessionId: input.marvinSessionId });
  if (pending.length >= MAX_PENDING_PER_SESSION) {
    return {
      ok: false,
      error: `this session already has ${pending.length} pending wakeups (cap ${MAX_PENDING_PER_SESSION}); cancel one first.`,
    };
  }
  const record: WakeupRecord = {
    id: randomUUID(),
    marvinSessionId: input.marvinSessionId,
    projectId: input.projectId,
    cwd: input.cwd,
    model: input.model,
    advisorModel: input.advisorModel,
    personality: input.personality,
    permissionStrategy: input.permissionStrategy,
    thinkingMode: input.thinkingMode,
    prompt: input.prompt,
    reason: input.reason,
    createdAt: new Date().toISOString(),
    fireAt: Date.now() + delay * 1000,
    depth: nextDepth,
  };
  persist(record);
  arm(record);
  return { ok: true, record };
}

export function cancelWakeup(id: string, projectId?: string): boolean {
  const existing = timers.get(id);
  if (existing) {
    clearTimeout(existing);
    timers.delete(id);
  }
  // Find the owning project file if not supplied.
  const pids = projectId ? [projectId] : listProjectIds();
  let removed = false;
  for (const pid of pids) {
    const before = readFile(pid).wakeups.length;
    unpersist(pid, id);
    if (readFile(pid).wakeups.length !== before) removed = true;
  }
  return removed || existing !== undefined;
}

/**
 * Re-arm every persisted wakeup once, on server boot. Idempotent — a second
 * call is a no-op. Past-due wakeups fire once immediately; wakeups more than
 * 24 h past due are dropped as stale.
 */
export function armAll(): { armed: number; firedImmediately: number; dropped: number } {
  if (armed) return { armed: 0, firedImmediately: 0, dropped: 0 };
  armed = true;
  const now = Date.now();
  let armedCount = 0;
  let firedImmediately = 0;
  let dropped = 0;
  for (const pid of listProjectIds()) {
    const file = readFile(pid);
    const survivors: WakeupRecord[] = [];
    for (const w of file.wakeups) {
      const overdueBy = now - w.fireAt;
      if (overdueBy > STALE_AFTER_MS) {
        dropped += 1;
        continue; // stale — drop, do not re-persist
      }
      survivors.push(w);
      if (overdueBy >= 0) firedImmediately += 1;
      else armedCount += 1;
      arm(w);
    }
    if (survivors.length !== file.wakeups.length) {
      writeFile(pid, { wakeups: survivors });
    }
  }
  return { armed: armedCount, firedImmediately, dropped };
}

// ── Internals ──────────────────────────────────────────────────────────
function listProjectIds(): string[] {
  const dir = marvinPaths.wakeupsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch {
    return [];
  }
}

function arm(record: WakeupRecord): void {
  const existing = timers.get(record.id);
  if (existing) clearTimeout(existing);
  const delayMs = Math.max(0, record.fireAt - Date.now());
  const t = setTimeout(() => void fire(record), delayMs);
  // Don't hold the event loop open on the timer's account — the Next
  // server process stays alive via its HTTP listener regardless.
  t.unref?.();
  timers.set(record.id, t);
}

async function fire(record: WakeupRecord): Promise<void> {
  timers.delete(record.id);
  // Remove from disk BEFORE dispatching so a handler crash can't cause the
  // same wakeup to fire twice on the next boot.
  unpersist(record.projectId, record.id);
  if (!fireHandler) return;
  try {
    await fireHandler(record);
  } catch {
    /* handler is responsible for its own error surfacing (turn.error) */
  }
}

/** Test-only: clear in-memory timers + the armed latch. */
export function __resetSchedulerForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  fireHandler = null;
  armed = false;
}
