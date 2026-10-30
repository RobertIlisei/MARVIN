/**
 * The supervisor's authority store (ADR-0127 §3, §5).
 *
 * Mode, per-tab delegation, the user's charter and the caps are held IN
 * MEMORY and persisted to `<MARVIN_DATA_DIR>/supervisor/<projectId>/state.json`.
 * The file is read only at boot (`bootSupervisor`): a later edit on disk does
 * not change what the runtime enforces. Nothing here takes a `workDir`, so a
 * `.marvin/supervisor*` file inside a user's repository is structurally
 * unreadable — a cloned repo cannot grant its own supervisor authority.
 *
 * Every user-facing change goes through `applySupervisorAction`, which needs
 * the per-boot capability token (§5). The token is written 0600 for the app
 * and an external client the user points at it, and is never placed in a
 * turn's environment.
 *
 * Pinned on `globalThis`: Next.js loads `instrumentation.ts` (boot) and the
 * route chunks as separate module graphs, and both must see one store.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  appendLedgerEntry,
  ensureSupervisorDir,
  ensureSupervisorRoot,
  isSafeProjectId,
  supervisorRoot,
} from "./supervisor-ledger";

export { supervisorDir } from "./supervisor-ledger";

export type SupervisorMode = "off" | "shadow" | "autonomous";
export const DELEGATION_LEVELS = ["off", "observe", "answer-questions", "answer-confirms"] as const;
export type Delegation = (typeof DELEGATION_LEVELS)[number];

export function delegationRank(level: Delegation | undefined): number {
  return level ? DELEGATION_LEVELS.indexOf(level) : 0;
}

/** Initial values, to be measured in shadow (plan, milestone 1). */
export interface SupervisorCaps {
  dailyBudgetUsd: number;
  maxActionsPerWake: number;
  perTabActsPer10Min: number;
  globalActsPer10Min: number;
  maxTurnsPerWake: number;
  debounceMs: number;
}

export const DEFAULT_CAPS: SupervisorCaps = {
  dailyBudgetUsd: 10,
  maxActionsPerWake: 5,
  perTabActsPer10Min: 6,
  globalActsPer10Min: 20,
  maxTurnsPerWake: 12,
  debounceMs: 5_000,
};

export const MAX_CHARTER_CHARS = 4_000;

export interface SupervisorState {
  version: 1;
  projectId: string;
  mode: SupervisorMode;
  paused: boolean;
  delegation: Record<string, Delegation>;
  charter: string;
  caps: SupervisorCaps;
  /** The supervisor's own MARVIN session id — never a tab, never a target. */
  supervisorSessionId: string | null;
  /** The SDK session resumed across wakes; null starts a fresh one (rotation). */
  sdkSessionId: string | null;
  sdkSessionStartedAt: string | null;
  lastInputTokens: number;
  /** Today's spend: `usd` is the total the cap reads; `ownUsd` the supervisor's own turns, `tabsUsd` the tab turns it started (ADR-0127 §6). */
  spend: { day: string; usd: number; ownUsd: number; tabsUsd: number };
  /** Why it is paused, when it is (brief §10.1). Null while running. */
  pause: SupervisorPause | null;
  updatedAt: string;
}

export const PAUSE_REASONS = ["user", "kill", "budget", "breaker", "refusals", "repeated-failures"] as const;
export interface SupervisorPause {
  reason: (typeof PAUSE_REASONS)[number];
  at: string;
  detail?: string;
}

interface Store {
  states: Map<string, SupervisorState>;
  token: string | null;
  listeners: Set<(e: SupervisorControlEvent) => void>;
}

export type SupervisorControlEvent = { projectId: string; action: SupervisorAction["action"] };

const G = globalThis as typeof globalThis & { __marvinSupervisorStore?: Store };
function store(): Store {
  G.__marvinSupervisorStore ??= { states: new Map(), token: null, listeners: new Set() };
  return G.__marvinSupervisorStore;
}

const today = () => new Date().toISOString().slice(0, 10);

function defaultState(projectId: string): SupervisorState {
  return {
    version: 1,
    projectId,
    mode: "off",
    paused: false,
    delegation: {},
    charter: "",
    caps: { ...DEFAULT_CAPS },
    supervisorSessionId: null,
    sdkSessionId: null,
    sdkSessionStartedAt: null,
    lastInputTokens: 0,
    spend: { day: today(), usd: 0, ownUsd: 0, tabsUsd: 0 },
    pause: null,
    updatedAt: new Date().toISOString(),
  };
}

function clone(s: SupervisorState): SupervisorState {
  return { ...s, delegation: { ...s.delegation }, caps: { ...s.caps }, spend: { ...s.spend }, pause: s.pause ? { ...s.pause } : null };
}

/** The state the runtime enforces. An unknown project is off. */
export function getSupervisorState(projectId: string): SupervisorState {
  const s = store().states.get(projectId);
  return clone(s ?? defaultState(projectId));
}

/** Projects whose supervisor is on (shadow or autonomous). */
export function listEnabledSupervisors(): SupervisorState[] {
  return [...store().states.values()].filter((s) => s.mode !== "off").map(clone);
}

export function isSupervisorSessionId(marvinSessionId: string): boolean {
  if (!marvinSessionId) return false;
  for (const s of store().states.values()) if (s.supervisorSessionId === marvinSessionId) return true;
  return false;
}

function persist(s: SupervisorState): void {
  const dir = ensureSupervisorDir(s.projectId);
  const file = path.join(dir, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function commit(s: SupervisorState): SupervisorState {
  s.updatedAt = new Date().toISOString();
  store().states.set(s.projectId, s);
  persist(s);
  return clone(s);
}

/** Validate a persisted record. Anything unknown falls back to the safe value — never a wider one. */
function sanitize(raw: unknown, projectId: string): SupervisorState {
  const base = defaultState(projectId);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  // Boot never re-arms autonomy: milestone 1 has no path into it, so a file
  // claiming it was edited by hand.
  if (r.mode === "shadow") base.mode = "shadow";
  if (r.paused === true) base.paused = true;
  if (r.delegation && typeof r.delegation === "object") {
    for (const [id, level] of Object.entries(r.delegation as Record<string, unknown>)) {
      if (typeof level === "string" && (DELEGATION_LEVELS as readonly string[]).includes(level) && id) {
        base.delegation[id] = level as Delegation;
      }
    }
  }
  if (typeof r.charter === "string") base.charter = r.charter.slice(0, MAX_CHARTER_CHARS);
  if (typeof r.supervisorSessionId === "string" && /^[0-9a-f-]{36}$/.test(r.supervisorSessionId)) {
    base.supervisorSessionId = r.supervisorSessionId;
  }
  if (typeof r.sdkSessionId === "string" && r.sdkSessionId.length <= 200) base.sdkSessionId = r.sdkSessionId;
  if (typeof r.sdkSessionStartedAt === "string") base.sdkSessionStartedAt = r.sdkSessionStartedAt;
  const spend = r.spend as { day?: unknown; usd?: unknown; ownUsd?: unknown; tabsUsd?: unknown } | undefined;
  if (spend && typeof spend.day === "string" && typeof spend.usd === "number" && Number.isFinite(spend.usd)) {
    const part = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
    const usd = Math.max(0, spend.usd);
    // A file from before the split: everything spent so far was the supervisor's own.
    const tabsUsd = part(spend.tabsUsd);
    base.spend = { day: spend.day, usd, tabsUsd, ownUsd: spend.ownUsd === undefined ? usd - tabsUsd : part(spend.ownUsd) };
  }
  const pause = r.pause as { reason?: unknown; at?: unknown; detail?: unknown } | null | undefined;
  if (base.paused) {
    const reason = pause && typeof pause.reason === "string" && (PAUSE_REASONS as readonly string[]).includes(pause.reason) ? (pause.reason as SupervisorPause["reason"]) : "user";
    base.pause = {
      reason,
      at: pause && typeof pause.at === "string" ? pause.at : base.updatedAt,
      ...(pause && typeof pause.detail === "string" ? { detail: pause.detail.slice(0, 500) } : {}),
    };
  }
  if (base.supervisorSessionId) delete base.delegation[base.supervisorSessionId];
  return base;
}

// ── The capability token (§5) ───────────────────────────────────────────────

export function supervisorTokenPath(): string {
  return path.join(supervisorRoot(), "token");
}

function writeToken(): string {
  const token = randomBytes(32).toString("hex");
  ensureSupervisorRoot();
  const tmp = `${supervisorTokenPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  renameSync(tmp, supervisorTokenPath());
  store().token = token;
  return token;
}

/**
 * The current boot's token — minted only by `bootSupervisor`. Null before
 * boot, and verification then fails closed: a refused request never rewrites
 * the credential. (Two sidecars sharing one data dir each mint at boot; the
 * file holds the last one's, so an external client should talk to that one.)
 */
export function currentSupervisorToken(): string | null {
  return store().token;
}

export function verifySupervisorToken(presented: string | null | undefined): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const loaded = store().token;
  if (!loaded) return false;
  const expected = Buffer.from(loaded);
  const got = Buffer.from(presented.trim());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Header the app and an external client send the token in. */
export const SUPERVISOR_TOKEN_HEADER = "x-marvin-supervisor-token";

// ── Boot ─────────────────────────────────────────────────────────────────────

/** Load every persisted supervisor and mint a fresh token. The only disk read of state. */
export function bootSupervisor(): { armed: string[] } {
  const st = store();
  st.states.clear();
  const root = supervisorRoot();
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!isSafeProjectId(name)) continue;
      const file = path.join(root, name, "state.json");
      if (!existsSync(file)) continue;
      try {
        st.states.set(name, sanitize(JSON.parse(readFileSync(file, "utf8")), name));
      } catch {
        /* a corrupt file loads as nothing — off */
      }
    }
  }
  writeToken();
  return { armed: [...st.states.values()].filter((s) => s.mode !== "off").map((s) => s.projectId) };
}

// ── User actions ─────────────────────────────────────────────────────────────

export type SupervisorAction =
  | { projectId: string; action: "start" }
  | { projectId: string; action: "stop" }
  | { projectId: string; action: "pause" }
  | { projectId: string; action: "resume" }
  | { projectId: string; action: "kill" }
  | { projectId: string; action: "mode"; mode: string }
  | { projectId: string; action: "delegate"; marvinSessionId: string; level: string }
  | { projectId: string; action: "charter"; text: string };

export type SupervisorActionResult =
  | { ok: true; state: SupervisorState }
  | { ok: false; status: number; error: string };

const fail = (status: number, error: string): SupervisorActionResult => ({ ok: false, status, error });

/** Every user change to the supervisor. Token-gated; ledgered as a `control` line. */
export function applySupervisorAction(input: unknown, presentedToken: string | null | undefined): SupervisorActionResult {
  if (!verifySupervisorToken(presentedToken)) {
    return fail(403, "supervisor routes need the per-boot capability token (ADR-0127 §5)");
  }
  if (!input || typeof input !== "object") return fail(400, "body must be an object");
  const a = input as Partial<SupervisorAction> & Record<string, unknown>;
  const projectId = typeof a.projectId === "string" ? a.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return fail(400, "invalid projectId");
  const s = getSupervisorState(projectId);
  let detail = "";

  switch (a.action) {
    case "start":
      s.mode = "shadow";
      s.paused = false;
      s.pause = null;
      s.supervisorSessionId ??= randomUUID();
      break;
    case "stop":
      s.mode = "off";
      break;
    case "pause":
    case "kill":
      s.paused = true;
      s.pause = { reason: a.action === "kill" ? "kill" : "user", at: new Date().toISOString() };
      break;
    case "resume":
      s.paused = false;
      s.pause = null;
      break;
    case "mode": {
      if (a.mode === "shadow" || a.mode === "off") {
        s.mode = a.mode;
        if (a.mode === "shadow") s.supervisorSessionId ??= randomUUID();
      } else {
        return fail(400, "only off and shadow exist in milestone 1; autonomy is switched per category later");
      }
      detail = String(a.mode);
      break;
    }
    case "delegate": {
      const id = typeof a.marvinSessionId === "string" ? a.marvinSessionId.trim() : "";
      if (!id || id.length > 200) return fail(400, "marvinSessionId required");
      if (id === s.supervisorSessionId || isSupervisorSessionId(id)) {
        return fail(400, "a supervisor session cannot be delegated or targeted");
      }
      if (typeof a.level !== "string" || !(DELEGATION_LEVELS as readonly string[]).includes(a.level)) {
        return fail(400, `level must be one of ${DELEGATION_LEVELS.join(", ")}`);
      }
      if (a.level === "off") delete s.delegation[id];
      else s.delegation[id] = a.level as Delegation;
      detail = `${id}=${a.level}`;
      break;
    }
    case "charter": {
      if (typeof a.text !== "string") return fail(400, "text required");
      s.charter = a.text.slice(0, MAX_CHARTER_CHARS);
      break;
    }
    default:
      return fail(400, "unknown action");
  }

  const state = commit(s);
  appendLedgerEntry(projectId, {
    kind: "control",
    verb: String(a.action),
    tab: a.action === "delegate" ? String(a.marvinSessionId) : null,
    wakeId: null,
    mode: state.mode,
    reason: detail ? `user: ${a.action} ${detail}` : `user: ${a.action}`,
  });
  for (const l of store().listeners) {
    try {
      l({ projectId, action: a.action as SupervisorAction["action"] });
    } catch {
      /* a listener must not undo the user's action */
    }
  }
  return { ok: true, state };
}

/** The loop's hook for pause / kill / delegate changes. Returns an unsubscribe fn. */
export function onSupervisorControl(listener: (e: SupervisorControlEvent) => void): () => void {
  store().listeners.add(listener);
  return () => {
    store().listeners.delete(listener);
  };
}

/**
 * The runtime pauses a supervisor that is faulting (ADR-0127 §6). Narrowing
 * only — it never resumes one — so it needs no token. Escalated in the ledger.
 */
export function pauseSupervisorForFault(projectId: string, reason: string, code: Exclude<SupervisorPause["reason"], "user" | "kill"> = "refusals"): SupervisorState {
  const s = getSupervisorState(projectId);
  s.paused = true;
  s.pause = { reason: code, at: new Date().toISOString(), detail: reason.slice(0, 500) };
  const state = commit(s);
  appendLedgerEntry(projectId, { kind: "control", verb: "auto-pause", tab: null, wakeId: null, mode: state.mode, decision: "escalate", reason, reasonCode: code });
  for (const l of store().listeners) {
    try {
      l({ projectId, action: "pause" });
    } catch {
      /* a listener must not undo the pause */
    }
  }
  return state;
}

/** Runtime bookkeeping the loop owns (session rotation, spend) — not user authority. */
export function updateSupervisorRuntime(
  projectId: string,
  patch: Partial<Pick<SupervisorState, "sdkSessionId" | "sdkSessionStartedAt" | "lastInputTokens">> & { addSpendUsd?: number },
): SupervisorState {
  const s = getSupervisorState(projectId);
  if ("sdkSessionId" in patch) s.sdkSessionId = patch.sdkSessionId ?? null;
  if ("sdkSessionStartedAt" in patch) s.sdkSessionStartedAt = patch.sdkSessionStartedAt ?? null;
  if (patch.lastInputTokens !== undefined) s.lastInputTokens = patch.lastInputTokens;
  if (patch.addSpendUsd !== undefined && Number.isFinite(patch.addSpendUsd)) {
    const day = today();
    if (s.spend.day !== day) s.spend = { day, usd: 0, ownUsd: 0, tabsUsd: 0 };
    s.spend.usd += Math.max(0, patch.addSpendUsd);
    s.spend.ownUsd += Math.max(0, patch.addSpendUsd);
  }
  return commit(s);
}

/**
 * ADR-0127 §6 — a tab turn the supervisor started spends the tab's money, so
 * it counts against the supervisor's daily cap. At the cap the supervisor
 * pauses and the ledger escalates. A project whose supervisor is off (the
 * external prototype sending with the token) still has its spend counted.
 */
export function noteSupervisorTabSpend(projectId: string, costUsd: number | null | undefined): SupervisorState {
  const s = getSupervisorState(projectId);
  const add = typeof costUsd === "number" && Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0;
  const day = today();
  if (s.spend.day !== day) s.spend = { day, usd: 0, ownUsd: 0, tabsUsd: 0 };
  s.spend.usd += add;
  s.spend.tabsUsd += add;
  const state = commit(s);
  if (state.mode !== "off" && !state.paused && overBudget(state)) {
    return pauseSupervisorForFault(
      projectId,
      `daily cap reached: $${state.spend.usd.toFixed(2)} of $${state.caps.dailyBudgetUsd} (tab turns it started: $${state.spend.tabsUsd.toFixed(2)})`,
      "budget",
    );
  }
  return state;
}

/** Test-only — the cap mutation is a later milestone's (`cap {capUsd}`, brief §10.1). */
export function setSupervisorCapsForTests(projectId: string, caps: Partial<SupervisorCaps>): void {
  const s = getSupervisorState(projectId);
  s.caps = { ...s.caps, ...caps };
  commit(s);
}

/** Today's spend against the cap (a new day starts at zero). */
export function overBudget(s: SupervisorState): boolean {
  return s.spend.day === today() && s.spend.usd >= s.caps.dailyBudgetUsd;
}

export function resetSupervisorStateForTests(): void {
  const st = store();
  st.states.clear();
  st.token = null;
  st.listeners.clear();
}
