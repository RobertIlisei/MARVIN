/**
 * Posture without a turn (ADR-0127 §9, ADR-0108 amendment).
 *
 * A tab's posture — model, effort, permission strategy, mode — used to change
 * only by sending a turn. `applyPostureChange` changes it in the session meta
 * directly, with a revision and a source. Three rules ride on it:
 *
 *   - **The app's next post does not undo it.** The chat route keeps the
 *     API-set fields over what the app posts until the app sends the revision
 *     back (`apiPostureHold`). A session that never used the route holds
 *     nothing and behaves exactly as before.
 *   - **A supervisor only narrows.** Orders are explicit: strategy
 *     full > auto > gated; mode agent > plan > ask; effort max > xhigh > high >
 *     medium > low; a model is narrower only when it is known to cost no more
 *     — a pricier or unpriced model is a widening. Any widening by the
 *     supervisor escalates and changes nothing (ADR-0127 §4 item 5).
 *   - **A narrowing reaches a live turn.** Strategy and mode are enforced in
 *     the gate, chosen once per turn; the turn's gate consults
 *     `getLiveNarrowing` on every call, so a narrowing applies at the next
 *     tool call. A widening, and any model or effort change, waits for the
 *     next turn (`setModel()` on a live query is not used until verified).
 *
 * Server-started turns (wakeups, job completions, resumes) take the narrower
 * of what armed them and what the tab holds now (`scheduledTurnPosture`):
 * a narrowing applies, a widening does not elevate (ADR-0031).
 */

import { listModelsCached } from "./models";
import { isValidModelId } from "./role-models";
import { readSessionMeta, type SessionMeta, type SessionPosture, updateSessionMeta } from "./session-meta";
import { appendLedgerEntry, digestArgs, isSafeProjectId, type LedgerGround } from "./supervisor-ledger";
import { getLiveTurn } from "./turn-registry";

export type Strategy = SessionPosture["permissionStrategy"];
export type Mode = NonNullable<SessionPosture["mode"]>;

/** Narrowest first. */
export const STRATEGY_ORDER: readonly Strategy[] = ["gated", "auto", "full"];
export const MODE_ORDER: readonly Mode[] = ["ask", "plan", "agent"];
export const EFFORT_ORDER: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface PosturePatch {
  model?: string;
  thinkingMode?: string;
  permissionStrategy?: Strategy;
  mode?: Mode;
}

const PATCH_KEYS = ["model", "thinkingMode", "permissionStrategy", "mode"] as const;

export function validatePosturePatch(input: unknown): { ok: true; patch: PosturePatch } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "posture must be an object" };
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !(PATCH_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, error: `not a settable posture field: ${unknown.join(", ")} (settable: ${PATCH_KEYS.join(", ")})` };
  const patch: PosturePatch = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !isValidModelId(raw.model.trim())) return { ok: false, error: "model must be a model id" };
    patch.model = raw.model.trim();
  }
  if (raw.thinkingMode !== undefined) {
    if (typeof raw.thinkingMode !== "string" || !EFFORT_ORDER.includes(raw.thinkingMode)) {
      return { ok: false, error: `thinkingMode must be one of ${EFFORT_ORDER.join(", ")}` };
    }
    patch.thinkingMode = raw.thinkingMode;
  }
  if (raw.permissionStrategy !== undefined) {
    if (!(STRATEGY_ORDER as readonly unknown[]).includes(raw.permissionStrategy)) {
      return { ok: false, error: `permissionStrategy must be one of ${STRATEGY_ORDER.join(", ")}` };
    }
    patch.permissionStrategy = raw.permissionStrategy as Strategy;
  }
  if (raw.mode !== undefined) {
    if (!(MODE_ORDER as readonly unknown[]).includes(raw.mode)) return { ok: false, error: `mode must be one of ${MODE_ORDER.join(", ")}` };
    patch.mode = raw.mode as Mode;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "set at least one of model, thinkingMode, permissionStrategy, mode" };
  return { ok: true, patch };
}

/** What a model costs, as far as the active catalogue knows. Null = unknown. */
export type ModelLookup = (id: string) => { tier?: string; pricing?: { prompt?: string | number } } | null;

const TIER_ORDER = ["haiku", "sonnet", "opus"];

function promptPrice(info: ReturnType<ModelLookup>): number | null {
  const p = info?.pricing?.prompt;
  const n = typeof p === "number" ? p : typeof p === "string" ? Number(p) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

export type Direction = "narrow" | "widen" | "same";

function byOrder<T>(order: readonly T[], from: T | undefined, to: T): Direction {
  const a = from === undefined ? order.length - 1 : order.indexOf(from); // an unknown "from" is the widest
  const b = order.indexOf(to);
  if (b < 0) return "widen";
  return b === a ? "same" : b < a ? "narrow" : "widen";
}

function modelDirection(from: string, to: string, lookup: ModelLookup): Direction {
  if (from === to) return "same";
  const a = lookup(from);
  const b = lookup(to);
  const pa = promptPrice(a);
  const pb = promptPrice(b);
  if (pa !== null && pb !== null) return pb <= pa ? "narrow" : "widen";
  const ta = TIER_ORDER.indexOf(a?.tier ?? "");
  const tb = TIER_ORDER.indexOf(b?.tier ?? "");
  if (ta >= 0 && tb >= 0 && pa === null && pb === null) return tb <= ta ? "narrow" : "widen";
  return "widen"; // unpriced, or no common scale — never assumed cheaper
}

/**
 * Agent → Plan or Ask narrows (both are read-only at the gate). Between Plan
 * and Ask the gate is the same, but Plan runs the ADVISOR model and Ask the
 * executor — so the move is judged by what the next turn's model costs.
 */
function modeDirection(from: SessionPosture, to: Mode, lookup: ModelLookup): Direction {
  const f = from.mode ?? "agent";
  if (f === to) return "same";
  if (f === "agent" || to === "agent") return byOrder(MODE_ORDER, f, to);
  const planModel = from.advisorModel ?? from.model;
  return f === "plan" ? modelDirection(planModel, from.model, lookup) : modelDirection(from.model, planModel, lookup);
}

export interface FieldChange {
  field: keyof PosturePatch;
  from: string | undefined;
  to: string;
  direction: Direction;
}

export function classifyPostureChange(from: SessionPosture, patch: PosturePatch, lookup: ModelLookup): FieldChange[] {
  const out: FieldChange[] = [];
  if (patch.permissionStrategy) {
    out.push({ field: "permissionStrategy", from: from.permissionStrategy, to: patch.permissionStrategy, direction: byOrder(STRATEGY_ORDER, from.permissionStrategy, patch.permissionStrategy) });
  }
  if (patch.mode) out.push({ field: "mode", from: from.mode ?? "agent", to: patch.mode, direction: modeDirection(from, patch.mode, lookup) });
  if (patch.thinkingMode) {
    out.push({ field: "thinkingMode", from: from.thinkingMode, to: patch.thinkingMode, direction: byOrder(EFFORT_ORDER, EFFORT_ORDER.includes(from.thinkingMode) ? from.thinkingMode : undefined, patch.thinkingMode) });
  }
  if (patch.model) out.push({ field: "model", from: from.model, to: patch.model, direction: modelDirection(from.model, patch.model, lookup) });
  return out;
}

export function isNarrowing(from: SessionPosture, patch: PosturePatch, lookup: ModelLookup): boolean {
  return classifyPostureChange(from, patch, lookup).every((c) => c.direction !== "widen");
}

export function narrowerStrategy(a: Strategy, b: Strategy | undefined): Strategy {
  return b && STRATEGY_ORDER.indexOf(b) < STRATEGY_ORDER.indexOf(a) ? b : a;
}
export function narrowerMode(a: Mode, b: Mode | undefined): Mode {
  return b && MODE_ORDER.indexOf(b) < MODE_ORDER.indexOf(a) ? b : a;
}
export function narrowerEffort(a: string, b: string | undefined): string {
  if (!b) return a;
  const ia = EFFORT_ORDER.indexOf(a);
  const ib = EFFORT_ORDER.indexOf(b);
  if (ib < 0) return a;
  return ia < 0 || ib < ia ? b : a;
}

// ── Live narrowing (the gate reads it on every call) ─────────────────────────

const G = globalThis as typeof globalThis & { __marvinLiveNarrowing?: Map<string, { permissionStrategy?: Strategy; mode?: Mode }> };
function liveStore() {
  G.__marvinLiveNarrowing ??= new Map();
  return G.__marvinLiveNarrowing;
}

export function setLiveNarrowing(turnId: string, patch: { permissionStrategy?: Strategy; mode?: Mode }): void {
  const prev = liveStore().get(turnId) ?? {};
  liveStore().set(turnId, {
    ...prev,
    ...(patch.permissionStrategy ? { permissionStrategy: prev.permissionStrategy ? narrowerStrategy(prev.permissionStrategy, patch.permissionStrategy) : patch.permissionStrategy } : {}),
    ...(patch.mode ? { mode: prev.mode ? narrowerMode(prev.mode, patch.mode) : patch.mode } : {}),
  });
}
export function getLiveNarrowing(turnId: string): { permissionStrategy?: Strategy; mode?: Mode } | null {
  return liveStore().get(turnId) ?? null;
}
export function clearLiveNarrowing(turnId: string): void {
  liveStore().delete(turnId);
}

// ── Applying a change ────────────────────────────────────────────────────────

export type PostureChangeResult =
  | { ok: true; meta: SessionMeta; changes: FieldChange[]; liveApplied: string[] }
  | { ok: false; status: 400 | 404 | 409; error: string; changes?: FieldChange[] };

export function applyPostureChange(args: {
  projectId: string;
  marvinSessionId: string;
  patch: PosturePatch;
  actor: "user" | "supervisor";
  lookup: ModelLookup;
  /** How a supervisor act is ledgered: `autonomous` when this call performs it. */
  ledger?: { mode: "shadow" | "autonomous"; grounds?: LedgerGround[] };
}): PostureChangeResult {
  const { projectId, marvinSessionId, patch, actor, lookup } = args;
  const meta = readSessionMeta(projectId, marvinSessionId);
  if (!meta) return { ok: false, status: 404, error: "no such session (posture can only change on a session that has started)" };
  const changes = classifyPostureChange(meta.posture, patch, lookup);
  const widening = changes.filter((c) => c.direction === "widen");
  const ledger = (decision: "act" | "escalate", reason: string) => {
    if (actor !== "supervisor" || !isSafeProjectId(projectId)) return;
    appendLedgerEntry(projectId, {
      kind: "verb",
      verb: "set_posture",
      tab: marvinSessionId,
      wakeId: null,
      mode: args.ledger?.mode ?? "autonomous",
      decision,
      reason,
      argsDigest: digestArgs(patch),
      grounds: args.ledger?.grounds ?? [],
    });
  };
  if (actor === "supervisor" && widening.length) {
    const what = widening.map((c) => `${c.field} ${c.from ?? "?"} → ${c.to}`).join("; ");
    ledger("escalate", `widening is the user's act (ADR-0127 §4): ${what}`);
    return { ok: false, status: 409, error: `a supervisor may only narrow a posture; widening escalates to the user: ${what}`, changes };
  }

  const revision = (meta.postureRevision ?? 0) + 1;
  // Fields the app has not seen yet keep their hold; once it has, a change starts a fresh hold.
  const unacked = (meta.postureAck ?? 0) < (meta.postureRevision ?? 0);
  const postureOverride = { ...(unacked ? meta.postureOverride : {}), ...patch };
  const next = updateSessionMeta(projectId, marvinSessionId, {
    posture: { ...meta.posture, ...patch },
    postureRevision: revision,
    postureSource: actor,
    postureOverride,
  });
  if (!next) return { ok: false, status: 400, error: "could not write the session meta" };

  const liveApplied: string[] = [];
  const live = getLiveTurn(marvinSessionId);
  if (live && !live.ended) {
    const narrowLive: { permissionStrategy?: Strategy; mode?: Mode } = {};
    for (const c of changes) {
      if (c.direction !== "narrow") continue;
      if (c.field === "permissionStrategy" && patch.permissionStrategy) narrowLive.permissionStrategy = patch.permissionStrategy;
      if (c.field === "mode" && patch.mode) narrowLive.mode = patch.mode;
    }
    if (Object.keys(narrowLive).length) {
      setLiveNarrowing(live.turnId, narrowLive);
      liveApplied.push(...Object.keys(narrowLive));
    }
  }
  ledger("act", `narrowed: ${changes.map((c) => `${c.field} ${c.from ?? "?"} → ${c.to}`).join("; ")}`);
  return { ok: true, meta: next, changes, liveApplied };
}

/** The API-set fields the chat route keeps over a client that has not echoed the revision. */
export function apiPostureHold(meta: SessionMeta | null, clientRevision: number | undefined): PosturePatch | null {
  if (!meta?.postureRevision || !meta.postureOverride) return null;
  if ((clientRevision ?? 0) >= meta.postureRevision) return null;
  return { ...meta.postureOverride };
}

/** The revision a client may acknowledge: never past the one the server holds. */
export function ackRevision(meta: SessionMeta | null, clientRevision: number | undefined): number | undefined {
  if (clientRevision === undefined) return undefined;
  return Math.max(0, Math.min(clientRevision, meta?.postureRevision ?? 0));
}

/**
 * The posture a server-started or queued turn runs with: the narrower of what
 * armed it and what the tab holds now, field by field. A narrowing applies; a
 * widening since arming does not elevate (ADR-0031). The model moves only to a
 * candidate the catalogue knows to cost no more.
 */
export function scheduledTurnPosture(
  record: { model: string; permissionStrategy: Strategy; thinkingMode: string; mode?: Mode | undefined },
  tab: SessionPosture | null,
  override: PosturePatch | undefined,
  lookup: ModelLookup = () => null,
): { model: string; permissionStrategy: Strategy; thinkingMode: string; mode: Mode } {
  let model = record.model;
  for (const candidate of [tab?.model, override?.model]) {
    if (candidate && modelDirection(model, candidate, lookup) === "narrow") model = candidate;
  }
  return {
    model,
    permissionStrategy: narrowerStrategy(record.permissionStrategy, tab?.permissionStrategy),
    thinkingMode: narrowerEffort(record.thinkingMode, tab?.thinkingMode),
    mode: narrowerMode(record.mode ?? "agent", tab?.mode),
  };
}

/** A lookup over the active provider's catalogue (ADR-0126); unknown ids are unpriced. */
export async function activeModelLookup(): Promise<ModelLookup> {
  try {
    const { models } = await listModelsCached();
    const byId = new Map(models.map((m) => [m.id, m]));
    return (id) => {
      const m = byId.get(id);
      return m ? { tier: m.tier, ...(m.pricing ? { pricing: m.pricing } : {}) } : null;
    };
  } catch {
    return () => null;
  }
}
