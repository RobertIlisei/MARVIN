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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { ensureDir, marvinPaths } from "./paths";
import { getLiveTurn } from "./turn-registry";

export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 86_400; // 24 h
export const MAX_PENDING_PER_SESSION = 5;
/** Max self-reschedule chain length before a wakeup is dropped as runaway. */
export const MAX_CHAIN_DEPTH = 8;
/**
 * When a wakeup fires but the session already has a live turn, it YIELDS:
 * re-arms itself this far in the future rather than evicting the live turn.
 * Short enough to feel responsive once the turn ends; long enough not to spin.
 */
export const FIRE_DEFER_BACKOFF_MS = 20_000;
/**
 * Give up deferring after this many yields (~20 min at the backoff above) and
 * drop the wakeup. A session live continuously for that long is pathological
 * (a wedged turn — clearable via Stop, ADR-0034); dropping the background
 * wakeup is the lesser evil versus barging in and killing the live turn.
 */
export const MAX_FIRE_DEFERRALS = 60;
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
  /** Opt-in Playwright MCP for the fired turn (ADR-0045); inherits the
   *  scheduling turn's toggle. Optional so pre-0045 records keep parsing. */
  playwrightEnabled?: boolean;
  thinkingMode: string;
  /** Advisor-specific effort (ADR-0033); absent = follow the executor.
   *  Optional so pre-0033 persisted records keep parsing. */
  advisorThinkingMode?: string;
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
  /**
   * How many times this wakeup has been deferred because the session had a
   * live turn at fire time (see {@link MAX_FIRE_DEFERRALS}). Absent / 0 on a
   * freshly scheduled wakeup. NOT a capability — purely a yield counter so a
   * background wakeup never evicts an interactive turn.
   */
  deferrals?: number;
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
  /** Opt-in Playwright MCP for the fired turn (ADR-0045); inherits the
   *  scheduling turn's toggle. Optional so pre-0045 records keep parsing. */
  playwrightEnabled?: boolean;
  thinkingMode: string;
  advisorThinkingMode?: string | undefined;
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

// ── Module state (single-process, GLOBAL singleton) ────────────────────
// CRITICAL: this state MUST be shared across every copy of this module in
// the bundle. In the Next.js *standalone* build (the brew-distributed .app
// sidecar), `instrumentation.ts` is a separate entry point from the API
// routes, and the bundler can give each entry its OWN copy of this module.
// If `fireHandler` / `timers` were plain module-locals, the handler set by
// instrumentation would land on one copy while the timer that fires lives
// on another — so `fire()` would run, drop the persisted record, and find
// `fireHandler === null`: the wakeup evaporates with no turn. That was the
// real "scheduler never fires" bug. Pinning the state to `globalThis`
// collapses all copies onto one object so the handler, timers, and arm
// latch are genuinely shared. (`turn-registry` survives without this only
// because it's imported solely from route chunks, never instrumentation.)
interface WakeupState {
  timers: Map<string, ReturnType<typeof setTimeout>>;
  fireHandler: FireHandler | null;
  armed: boolean;
}
const STATE_KEY = "__marvinWakeupSchedulerState__";
const g = globalThis as unknown as Record<string, WakeupState | undefined>;
const state: WakeupState =
  g[STATE_KEY] ??
  (g[STATE_KEY] = { timers: new Map(), fireHandler: null, armed: false });

/**
 * Inject the turn-dispatch handler onto the shared singleton. Wired from
 * BOTH the server-boot hook (`instrumentation.ts`) AND the request path
 * (`turn-orchestrator`) — idempotent, last-writer-wins, both set the same
 * function. The request-path wiring is the load-bearing one: it runs in the
 * same chunk that schedules and fires timers, so it cannot miss even if
 * instrumentation never executes in standalone.
 */
export function setWakeupFireHandler(handler: FireHandler): void {
  state.fireHandler = handler;
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
    ...(input.playwrightEnabled !== undefined ? { playwrightEnabled: input.playwrightEnabled } : {}),
    thinkingMode: input.thinkingMode,
    ...(input.advisorThinkingMode
      ? { advisorThinkingMode: input.advisorThinkingMode }
      : {}),
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
  const existing = state.timers.get(id);
  if (existing) {
    clearTimeout(existing);
    state.timers.delete(id);
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
  if (state.armed) return { armed: 0, firedImmediately: 0, dropped: 0 };
  state.armed = true;
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
  const existing = state.timers.get(record.id);
  if (existing) clearTimeout(existing);
  const delayMs = Math.max(0, record.fireAt - Date.now());
  const t = setTimeout(() => void fire(record), delayMs);
  // Don't hold the event loop open on the timer's account — the Next
  // server process stays alive via its HTTP listener regardless.
  t.unref?.();
  state.timers.set(record.id, t);
}

/**
 * If the session already has a live (non-ended) turn, YIELD: re-arm this
 * wakeup for a short retry instead of dispatching it. A fired wakeup must
 * never evict an interactive turn — that surfaced to the user as the
 * "replaced by a newer turn on the same session" stream error and aborted
 * their in-flight work (the `/api/chat` 409 guard never covered this path).
 * Returns `true` when the wakeup was deferred (or dropped at the cap), meaning
 * the caller must NOT dispatch it.
 */
function deferIfSessionBusy(record: WakeupRecord): boolean {
  const live = getLiveTurn(record.marvinSessionId);
  if (!live || live.ended) return false;
  const deferrals = (record.deferrals ?? 0) + 1;
  if (deferrals > MAX_FIRE_DEFERRALS) {
    unpersist(record.projectId, record.id);
    // eslint-disable-next-line no-console
    console.warn(
      `[wakeup-scheduler] dropping wakeup ${record.id} (${record.reason}) — session ${record.marvinSessionId} stayed busy through ${MAX_FIRE_DEFERRALS} deferrals.`,
    );
    return true;
  }
  const deferred: WakeupRecord = {
    ...record,
    deferrals,
    fireAt: Date.now() + FIRE_DEFER_BACKOFF_MS,
  };
  persist(deferred);
  arm(deferred);
  return true;
}

async function fire(record: WakeupRecord): Promise<void> {
  state.timers.delete(record.id);
  // Yield to a live turn rather than evicting it (re-arms + re-persists).
  if (deferIfSessionBusy(record)) return;
  // Remove from disk BEFORE dispatching so a handler crash can't cause the
  // same wakeup to fire twice on the next boot.
  unpersist(record.projectId, record.id);
  if (!state.fireHandler) {
    // Should never happen now that the handler is wired from the request
    // path (turn-orchestrator) onto this same global singleton. Log loudly
    // if it ever does — a silent return here is the original lost-wakeup bug.
    // eslint-disable-next-line no-console
    console.error(
      `[wakeup-scheduler] fired wakeup ${record.id} (${record.reason}) but no fireHandler is wired — turn NOT started. This is a wiring bug.`,
    );
    return;
  }
  try {
    await state.fireHandler(record);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[wakeup-scheduler] fireHandler threw for ${record.id}:`, err);
  }
}

/**
 * Dispatch a turn from a record IMMEDIATELY, bypassing the timer +
 * persistence. Event-driven wakeups (background-job completion, ADR-0038)
 * reuse the same shared fire handler / turn-dispatch path as time-based
 * wakeups — they just trigger on a process exit instead of a clock.
 */
export async function fireNow(record: WakeupRecord): Promise<void> {
  // Same yield-to-live-turn guard as the timed `fire` path: an event-driven
  // wakeup must not evict an interactive turn either. When busy it re-arms on
  // a short timer (becomes a deferred wakeup) rather than dispatching now.
  if (deferIfSessionBusy(record)) return;
  if (!state.fireHandler) {
    // eslint-disable-next-line no-console
    console.error(
      `[wakeup-scheduler] fireNow(${record.id}) but no fireHandler is wired — turn NOT started. Wiring bug.`,
    );
    return;
  }
  try {
    await state.fireHandler(record);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[wakeup-scheduler] fireNow handler threw for ${record.id}:`, err);
  }
}

/** Test-only: clear in-memory timers + the armed latch. */
export function __resetSchedulerForTests(): void {
  for (const t of state.timers.values()) clearTimeout(t);
  state.timers.clear();
  state.fireHandler = null;
  state.armed = false;
}
