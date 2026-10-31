/**
 * Cost tracker for MARVIN.
 *
 * Backed by `~/.marvin/cost-tracker.json`. We keep a per-day ledger keyed by
 * `YYYY-MM-DD` (UTC) plus a lifetime total. Each turn contributes one entry
 * (projectId, cost, tokens, timestamp). Aggregation is computed on read —
 * the file is small enough that reading and aggregating on every request
 * is cheaper than maintaining a summary file in sync.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { ensureDir, marvinPaths } from "./paths";

/**
 * Who pays for a turn, which decides what its dollar figure MEANS:
 * - `subscription`  — a Claude plan login: the figure is API-equivalent, not a bill.
 * - `anthropic-api` — an Anthropic API key (or a Console login): the figure is billed.
 * - `openrouter`    — OpenRouter: billing is OpenRouter's; MARVIN's figure is an estimate.
 * - `gateway`       — the CLI runs against an enterprise gateway (SDK `apiProvider`).
 * - `cloud-provider`— Bedrock / Vertex / Foundry / …: billed by the cloud account.
 * - `other`         — anything MARVIN could not classify.
 * Absent on entries recorded before 2026-10-31 — shown as "unknown".
 */
export type CostAuthMode = "subscription" | "anthropic-api" | "openrouter" | "gateway" | "cloud-provider" | "other";

/** `apiKeySource` values the CLI reports when a key — not a plan login — pays. */
const KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key", "user", "project", "org", "temporary"]);

/**
 * What the SDK says about the account (`query.accountInfo()`), minus anything
 * that identifies a person: `email` and `organization` are never kept. Every
 * value is shown as given — `subscriptionType` is the plan's own name
 * ("ultra", "max", …), and plans get renamed, so nothing maps it to a list.
 */
export interface AccountSignals {
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

export function accountSignals(info: unknown): AccountSignals {
  if (!info || typeof info !== "object") return {};
  const o = info as Record<string, unknown>;
  const out: AccountSignals = {};
  for (const k of ["subscriptionType", "tokenSource", "apiKeySource", "apiProvider"] as const) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0 && v.length <= 200) out[k] = v;
  }
  return out;
}

/**
 * Who pays for a turn. Precedence, strongest first:
 *  1. MARVIN's own OpenRouter routing — MARVIN rewrote ANTHROPIC_BASE_URL, so
 *     the CLI behind the proxy believes it is talking to `firstParty`.
 *  2. The SDK's `apiProvider` when it is not `firstParty`: `gateway`, or a
 *     cloud provider (Bedrock, Vertex, Foundry, …).
 *  3. The SDK's `apiKeySource` naming a key — a key the CLI is using beats a
 *     plan it is also logged into.
 *  4. The SDK's `subscriptionType` (or a token source with no key): a plan.
 *  5. MARVIN's auth status taken when the turn started (`getAnthropicAuth()`),
 *     only when the SDK reported nothing that decides it.
 */
export function classifyAuthMode(
  auth: { mode: string; provider?: string | undefined } | null | undefined,
  sdk: AccountSignals = {},
): CostAuthMode {
  if (auth?.mode === "api-key" && auth.provider === "openrouter") return "openrouter";
  const provider = sdk.apiProvider;
  if (provider && provider !== "firstParty") return provider === "gateway" ? "gateway" : "cloud-provider";
  const keySource = sdk.apiKeySource;
  if (keySource && KEY_SOURCES.has(keySource)) return "anthropic-api";
  if (sdk.subscriptionType) return "subscription";
  if (sdk.tokenSource && (!keySource || keySource === "none" || keySource === "oauth")) return "subscription";
  if (!auth) return "other";
  if (auth.mode === "api-key") return "anthropic-api";
  if (auth.mode === "oauth") return "subscription";
  if (auth.mode === "host-credentials" && (!keySource || keySource === "none" || keySource === "oauth")) return "subscription";
  return "other";
}

/** What a recorded `costUsd` is: a bill, an API-rate gauge, an estimate, or not known. */
export type CostKind = "billed" | "api-equivalent" | "estimate" | "unknown";

/** One model's share of a turn, from the SDK's `modelUsage` (per-turn delta). */
export interface CostModelUsage {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** SDK `costBasis` — `unknown` means the CLI had no price for this model and guessed. */
  costBasis?: string;
}

/** The SDK's cumulative figures for one model, kept so the next turn can diff. */
interface SdkModelCumulative {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface CostEntry {
  /** Absent on entries recorded before 2026-10-31. */
  id?: string;
  /**
   * 2 = `costUsd` is THIS turn's cost. Absent = a legacy entry: those recorded
   * the SDK's `total_cost_usd`, which is cumulative across a resumed session,
   * so their sum overstates spend and is reported separately, never added in.
   */
  v?: 2;
  at: string; // ISO
  projectId: string;
  /** ADR-0107 — which session the turn belonged to; absent on pre-0107 entries. */
  marvinSessionId?: string;
  /** The turn's cost in USD; read with `costKind`. 0 when the kind is `unknown`. */
  costUsd: number;
  costKind?: CostKind;
  /** The SDK's own per-turn figure (Claude rate card), kept beside `costUsd` when they differ. */
  sdkCostUsd?: number;
  /** Main-thread tokens (the SDK's `usage`) — subagents are in `models`. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Cache-write split by TTL, when the SDK reported it (`usage.cache_creation`). */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  model?: string;
  advisorModel?: string;
  authMode?: CostAuthMode;
  sdkSessionId?: string;
  /** Per-model per-turn usage, subagents and helpers included. */
  models?: CostModelUsage[];
  /** The SDK's cumulative totals after this turn — the next turn's baseline. */
  sdkCumulative?: { costUsd: number; models: Record<string, SdkModelCumulative> };
}

/**
 * One Claude plan rate-limit window, as last reported by the SDK's
 * `rate_limit_event` (ADR-0082). A subscription has no dollar balance to
 * poll — THIS is its usage: the 5-hour and 7-day windows the Claude app
 * shows. MARVIN received the event on every turn and dropped it.
 */
export interface ClaudeRateLimitWindow {
  /** `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`… */
  type: string;
  status: "allowed" | "allowed_warning" | "rejected";
  /** 0..1 — absent when the API did not report it on this event. */
  utilization?: number;
  /** Epoch seconds when the window refills. */
  resetsAt?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  /** ISO — when this snapshot was observed. */
  at: string;
}

/** OpenRouter's own figures for the configured key (`GET /api/v1/key`) — billed, but key-wide. */
export interface OpenRouterKeyUsage {
  usage: number;
  usageDaily?: number;
  usageWeekly?: number;
  usageMonthly?: number;
  limitRemaining?: number | null;
  fetchedAt: string;
}

interface CostFileShape {
  entries: CostEntry[];
  openRouter?: {
    totalCredits: number;
    totalUsage: number;
    fetchedAt: string;
  };
  openRouterKey?: OpenRouterKeyUsage;
  /** Latest SDK account signals per project (never email or organization). */
  accounts?: Record<string, AccountSignals & { at: string }>;
  /** Latest snapshot per window type, keyed by `type`. */
  claudeRateLimits?: Record<string, ClaudeRateLimitWindow>;
  /** Window types in the newest event that sized windows (`unifiedWindows`). */
  claudeRateLimitsLatestSet?: { types: string[]; at: string };
}

function readCostFile(): CostFileShape {
  const path = marvinPaths.costTracker();
  if (!existsSync(path)) return { entries: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { entries: [] };
  }
  try {
    const parsed = JSON.parse(raw) as CostFileShape;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  } catch {
    // An unreadable file used to read as empty, and the next write replaced it —
    // every entry gone, silently. Move it aside so the history survives.
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      /* best-effort; the write below is atomic either way */
    }
    return { entries: [] };
  }
}

/** Write to a temp file and rename it over the original, so a crash mid-write cannot truncate it. */
function writeCostFile(data: CostFileShape): void {
  const path = marvinPaths.costTracker();
  ensureDir(path);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

/** The SDK's per-model usage record — `result.modelUsage[model]`. Cumulative across a resumed session. */
export interface SdkModelUsageInput {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  costBasis?: string;
}

export interface RecordTurnInput {
  projectId: string;
  /** ADR-0107 — the session the turn belongs to. */
  marvinSessionId?: string | undefined;
  /**
   * This turn's cost, when the caller already knows it. When `sdk` carries a
   * cumulative total instead, leave this unset and the tracker derives it.
   */
  costUsd?: number | null;
  costKind?: CostKind;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  } | null;
  model?: string | null | undefined;
  advisorModel?: string | null | undefined;
  authMode?: CostAuthMode | undefined;
  /**
   * For `openrouter`: MARVIN's estimate from OpenRouter's own model prices.
   * The SDK prices every model off the Claude rate card, measured ~10× over
   * for non-Claude models, so it never stands in for this.
   */
  estimateUsd?: number | null | undefined;
  /** The SDK result's session id and CUMULATIVE totals (`total_cost_usd`, `modelUsage`). */
  sdk?: {
    sessionId?: string | null | undefined;
    totalCostUsd?: number | null | undefined;
    modelUsage?: Record<string, SdkModelUsageInput> | null | undefined;
  } | undefined;
}

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * This turn's share of a cumulative counter. The SDK's `total_cost_usd` and
 * `modelUsage` carry the running total of the whole resumed session — read
 * as per-turn, one real session summed to $93 against a true $32.
 *
 * - No baseline: the first turn of an SDK session, so the total IS the turn.
 * - The total went DOWN: the session restarted (reset context, a fresh id
 *   reused). The current total is the turn. This undercounts when a reset
 *   turn alone exceeds the old baseline — undetectable, so the bias is down,
 *   never up.
 *
 * Assumes MARVIN never forks a session (only `resume` is used). A fork
 * inherits the parent's total under a new id, and its first turn would book
 * the parent's whole history.
 */
export function cumulativeDelta(current: number, baseline: number | undefined): number {
  if (baseline === undefined || current < baseline) return nonNeg(current);
  return nonNeg(current - baseline);
}

function sdkCumulativeModels(mu: Record<string, SdkModelUsageInput>): Record<string, SdkModelCumulative> {
  const out: Record<string, SdkModelCumulative> = {};
  for (const [id, u] of Object.entries(mu)) {
    if (!u || typeof u !== "object") continue;
    out[id] = {
      costUSD: nonNeg(Number(u.costUSD)),
      inputTokens: nonNeg(Number(u.inputTokens)),
      outputTokens: nonNeg(Number(u.outputTokens)),
      cacheReadInputTokens: nonNeg(Number(u.cacheReadInputTokens)),
      cacheCreationInputTokens: nonNeg(Number(u.cacheCreationInputTokens)),
    };
  }
  return out;
}

/** Newest entry of an SDK session that carries cumulative totals — the diff baseline. */
function baselineFor(entries: CostEntry[], sdkSessionId: string): CostEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (e.sdkSessionId === sdkSessionId && e.sdkCumulative) return e;
  }
  return undefined;
}

export function recordTurnCost(input: RecordTurnInput): CostEntry | null {
  if (input.costUsd == null && !input.tokenUsage && input.sdk?.totalCostUsd == null) return null;
  const file = readCostFile();
  const tu = input.tokenUsage ?? {};
  const sdkSessionId = input.sdk?.sessionId ?? undefined;
  const sdkTotal = input.sdk?.totalCostUsd;
  const modelUsage = input.sdk?.modelUsage ?? undefined;

  // This turn's SDK figure, from the cumulative totals.
  let sdkTurnUsd: number | null = null;
  let models: CostModelUsage[] | undefined;
  let sdkCumulative: CostEntry["sdkCumulative"];
  // A session already running when this accounting landed has legacy entries
  // whose cost cannot serve as a baseline: some recorded the cumulative total,
  // some (OpenRouter) a per-turn estimate, and the two are indistinguishable.
  // Its first turn here starts the chain and is recorded as `unknown`.
  let startsChainMidSession = false;
  // A zero total is never a baseline: crash and startup-error results carry
  // zeroed values (SDK docs), and filing one would make the session's next
  // turn book its whole history.
  if (typeof sdkTotal === "number" && sdkTotal > 0) {
    const cum = sdkCumulativeModels(modelUsage ?? {});
    sdkCumulative = { costUsd: nonNeg(sdkTotal), models: cum };
    const base = sdkSessionId ? baselineFor(file.entries, sdkSessionId) : undefined;
    startsChainMidSession =
      !base &&
      !!input.marvinSessionId &&
      file.entries.some((e) => e.v !== 2 && e.marvinSessionId === input.marvinSessionId);
    sdkTurnUsd = cumulativeDelta(sdkTotal, base?.sdkCumulative?.costUsd);
    const baseModels = base?.sdkCumulative?.models ?? {};
    // When the session total reset, every model's baseline is void too.
    const reset = base !== undefined && sdkTotal < (base.sdkCumulative?.costUsd ?? 0);
    models = Object.entries(cum)
      .map(([model, c]): CostModelUsage => {
        const b = reset ? undefined : baseModels[model];
        const basis = modelUsage?.[model]?.costBasis;
        return {
          model,
          costUsd: cumulativeDelta(c.costUSD, b?.costUSD),
          inputTokens: cumulativeDelta(c.inputTokens, b?.inputTokens),
          outputTokens: cumulativeDelta(c.outputTokens, b?.outputTokens),
          cacheReadTokens: cumulativeDelta(c.cacheReadInputTokens, b?.cacheReadInputTokens),
          cacheCreationTokens: cumulativeDelta(c.cacheCreationInputTokens, b?.cacheCreationInputTokens),
          ...(typeof basis === "string" ? { costBasis: basis } : {}),
        };
      })
      .filter((m) => m.costUsd > 0 || m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens > 0);
  }

  // What the figure means depends on who pays.
  let costUsd: number;
  let costKind: CostKind | undefined = input.costKind;
  if (typeof input.costUsd === "number") {
    costUsd = nonNeg(input.costUsd);
  } else if (startsChainMidSession) {
    costUsd = 0;
    costKind = "unknown";
  } else if (input.authMode === "openrouter") {
    const est = input.estimateUsd;
    costUsd = typeof est === "number" ? nonNeg(est) : 0;
    costKind = typeof est === "number" ? "estimate" : "unknown";
  } else if (sdkTurnUsd !== null) {
    costUsd = sdkTurnUsd;
    const guessed = (models ?? []).some((m) => m.costBasis === "unknown");
    costKind =
      input.authMode === "subscription"
        ? "api-equivalent"
        : input.authMode === "anthropic-api" && !guessed
          ? "billed"
          : "estimate";
  } else {
    costUsd = 0;
    costKind = costKind ?? "unknown";
  }

  const cw = tu.cache_creation;
  const entry: CostEntry = {
    id: randomUUID(),
    v: 2,
    at: new Date().toISOString(),
    projectId: input.projectId,
    ...(input.marvinSessionId ? { marvinSessionId: input.marvinSessionId } : {}),
    costUsd,
    ...(costKind ? { costKind } : {}),
    ...(sdkTurnUsd !== null && sdkTurnUsd !== costUsd ? { sdkCostUsd: sdkTurnUsd } : {}),
    inputTokens: tu.input_tokens ?? 0,
    outputTokens: tu.output_tokens ?? 0,
    cacheCreationTokens: tu.cache_creation_input_tokens ?? 0,
    cacheReadTokens: tu.cache_read_input_tokens ?? 0,
    ...(typeof cw?.ephemeral_5m_input_tokens === "number" ? { cacheWrite5mTokens: cw.ephemeral_5m_input_tokens } : {}),
    ...(typeof cw?.ephemeral_1h_input_tokens === "number" ? { cacheWrite1hTokens: cw.ephemeral_1h_input_tokens } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.advisorModel ? { advisorModel: input.advisorModel } : {}),
    ...(input.authMode ? { authMode: input.authMode } : {}),
    ...(sdkSessionId ? { sdkSessionId } : {}),
    ...(models && models.length > 0 ? { models } : {}),
    ...(sdkCumulative ? { sdkCumulative } : {}),
  };
  file.entries.push(entry);
  writeCostFile(file);
  return entry;
}

export function recordOpenRouterBalance(totalCredits: number, totalUsage: number): void {
  const file = readCostFile();
  file.openRouter = {
    totalCredits,
    totalUsage,
    fetchedAt: new Date().toISOString(),
  };
  writeCostFile(file);
}

/** Persist the latest account signals for a project; a no-op when nothing changed. */
export function recordAccountInfo(projectId: string, info: unknown): void {
  const sig = accountSignals(info);
  if (Object.keys(sig).length === 0) return;
  const file = readCostFile();
  const prev = file.accounts?.[projectId];
  const same = prev && (["subscriptionType", "tokenSource", "apiKeySource", "apiProvider"] as const).every((k) => prev[k] === sig[k]);
  if (same) return;
  file.accounts = { ...(file.accounts ?? {}), [projectId]: { ...sig, at: new Date().toISOString() } };
  writeCostFile(file);
}

export function recordOpenRouterKeyUsage(u: Omit<OpenRouterKeyUsage, "fetchedAt">): void {
  const file = readCostFile();
  file.openRouterKey = { ...u, fetchedAt: new Date().toISOString() };
  writeCostFile(file);
}

/**
 * Record a `rate_limit_event` from the SDK stream. Keyed by window type so
 * the popover can show 5-hour and weekly side by side; an event with no
 * `rateLimitType` is a bare status and is filed under `unknown` only when
 * nothing better exists, so it can never overwrite a typed window.
 */
export function recordClaudeRateLimit(info: {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  /** Per-window utilisation — what the Claude CLI's Usage tab and the
   *  desktop app render. Undeclared in the SDK types; observed live
   *  2026-08-29 with `five_hour` + `seven_day` (and per-model weekly
   *  windows such as `seven_day_opus` when those models were used). */
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}): ClaudeRateLimitWindow | null {
  const status = info.status;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return null;
  const file = readCostFile();
  const existing = file.claudeRateLimits ?? {};
  const at = new Date().toISOString();
  const next: Record<string, ClaudeRateLimitWindow> = { ...existing };

  // The headline window the event is about — carries the status flags.
  const type = info.rateLimitType ?? "unknown";
  let headline: ClaudeRateLimitWindow | null = null;
  if (type !== "unknown" || Object.keys(existing).length === 0) {
    // "Newest snapshot wins, fields are not merged" is the rule, and it is the
    // right one for TIME-SENSITIVE fields: carrying a stale `resetsAt` forward
    // would state a refill time that has already passed. `utilization` is the
    // exception — it is a gauge, and a slightly old percentage is strictly
    // better than the blank one it was being replaced with.
    //
    // Seen live 2026-08-30: `five_hour` showed "no % yet" with a NEWER
    // timestamp than `seven_day`'s 49%. The 2.1.92 CLI does not report
    // `unifiedWindows` (ADR-0087/0093), so its headline-only event carried
    // status + resetsAt but no percentage — and erased the one the newer CLI
    // had recorded. `seven_day` survived purely because it is only ever
    // written through the merging `unifiedWindows` loop below.
    const carriedUtilization =
      typeof info.utilization === "number" ? undefined : next[type]?.utilization;
    headline = {
      type,
      status,
      ...(typeof carriedUtilization === "number" ? { utilization: carriedUtilization } : {}),
      ...(typeof info.utilization === "number" ? { utilization: info.utilization } : {}),
      ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
      ...(typeof info.overageStatus === "string" ? { overageStatus: info.overageStatus } : {}),
      ...(typeof info.isUsingOverage === "boolean" ? { isUsingOverage: info.isUsingOverage } : {}),
      at,
    };
    next[type] = headline;
  }

  // Every window the event sized. Utilisation here is authoritative — it is
  // the number the CLI shows — so it overrides the headline's, and a window
  // the headline did not mention (weekly, per-model) gets its own row.
  for (const [wtype, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (!w || typeof w !== "object") continue;
    const base = next[wtype] ?? { type: wtype, status: "allowed" as const, at };
    next[wtype] = {
      ...base,
      status: wtype === type ? status : base.status,
      ...(typeof w.utilization === "number" ? { utilization: w.utilization } : {}),
      ...(typeof w.resetsAt === "number" ? { resetsAt: w.resetsAt } : {}),
      at,
    };
  }

  if (headline === null && Object.keys(info.unifiedWindows ?? {}).length === 0) return null;
  file.claudeRateLimits = next;
  // The newest SET of sized windows. A window the server stops sending (a
  // verified Ultra account's `five_hour`) is absent from it from then on — the
  // headline write above still stamps such a window `at = now`, so recency
  // alone cannot tell. Headline-only events (older CLIs) never touch it.
  const sized = Object.entries(info.unifiedWindows ?? {})
    .filter(([, w]) => !!w && typeof w === "object")
    .map(([t]) => t);
  if (sized.length > 0) file.claudeRateLimitsLatestSet = { types: sized, at };
  writeCostFile(file);
  return headline ?? next[Object.keys(info.unifiedWindows ?? {})[0] ?? ""] ?? null;
}

/** Narrow an SDK message to a rate-limit payload; null for anything else. */
export function rateLimitPayload(ev: unknown): Parameters<typeof recordClaudeRateLimit>[0] | null {
  if (!ev || typeof ev !== "object") return null;
  const o = ev as { type?: unknown; rate_limit_info?: unknown };
  if (o.type !== "rate_limit_event" || !o.rate_limit_info || typeof o.rate_limit_info !== "object") return null;
  return o.rate_limit_info as Parameters<typeof recordClaudeRateLimit>[0];
}

/** One bounded GET against OpenRouter; null on any failure. */
async function openRouterGet<T>(path: string, apiKey: string): Promise<T | null> {
  // Bounded — this poll is awaited inside GET /api/cost, which the UI
  // polls; an unbounded fetch would hang the popover on a slow
  // openrouter.ai (same pattern as listModels' 6s AbortController).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const finite = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);

export async function pollOpenRouterBalance(): Promise<void> {
  const { readAuthConfig } = await import("./auth-config");
  const cfg = readAuthConfig();
  if (cfg?.provider !== "openrouter" || !cfg.apiKey) return;
  const [credits, key] = await Promise.all([
    openRouterGet<{ data?: { total_credits?: number; total_usage?: number } }>("credits", cfg.apiKey),
    // What OpenRouter itself billed this key — today / this week / this month.
    // Key-wide (every app using the key counts), so it is shown as the
    // account's figure, never as this project's.
    openRouterGet<{ data?: Record<string, unknown> }>("key", cfg.apiKey),
  ]);
  try {
    if (credits?.data?.total_credits !== undefined && credits?.data?.total_usage !== undefined) {
      recordOpenRouterBalance(credits.data.total_credits, credits.data.total_usage);
    }
    const d = key?.data;
    const usage = finite(d?.usage);
    if (d && usage !== undefined) {
      const daily = finite(d.usage_daily);
      const weekly = finite(d.usage_weekly);
      const monthly = finite(d.usage_monthly);
      const remaining = d.limit_remaining === null ? null : finite(d.limit_remaining);
      recordOpenRouterKeyUsage({
        usage,
        ...(daily !== undefined ? { usageDaily: daily } : {}),
        ...(weekly !== undefined ? { usageWeekly: weekly } : {}),
        ...(monthly !== undefined ? { usageMonthly: monthly } : {}),
        ...(remaining !== undefined ? { limitRemaining: remaining } : {}),
      });
    }
  } catch {
    /* ignore write errors in background */
  }
}

export interface CostAggregate {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  turns: number;
  /** Turns whose cost is an estimate / not known — they are in `turns`, their dollars may not be. */
  estimatedTurns: number;
  unpricedTurns: number;
}

/** Auth-mode key in a breakdown; `unknown` = recorded before the mode was. */
export type CostModeKey = CostAuthMode | "unknown";

export interface CostPeriod extends CostAggregate {
  /**
   * The same period split by who pays. `costUsd` above adds them up and
   * must never be shown without these labels when more than one mode is present.
   */
  byAuthMode: Partial<Record<CostModeKey, CostAggregate>>;
}

export interface CostModelRow {
  authMode: CostModeKey;
  /** `unknown model` for entries recorded before the model was. */
  model: string;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** True when this row's cost is not a rate-card or billed figure. */
  estimated: boolean;
}

/** A plan window as the popover shows it. */
export interface ClaudeRateLimitWindowView extends ClaudeRateLimitWindow {
  /** Readable label derived from `type`. */
  label: string;
  /**
   * False when the newest report that sized windows did not include this one —
   * it is shown dimmed with its last-reported time, not as current. Null when
   * no such report exists yet (an older CLI reports one window at a time).
   */
  inLatestReport: boolean | null;
}

export interface CostSummary {
  today: CostPeriod;
  week: CostPeriod;
  lifetime: CostPeriod;
  /** Newest 12 day buckets (UTC) for the active project, oldest→newest. */
  daily: Array<{ day: string; costUsd: number; turns: number }>;
  /** Per-model, per-auth-mode breakdowns, costliest first. */
  byModel: { today: CostModelRow[]; week: CostModelRow[] };
  /**
   * Entries recorded before 2026-10-31. They stored the SDK's cumulative
   * session total as each turn's cost, so this sum overstates spend and is
   * not comparable with the periods above. Null when there are none.
   */
  legacy: { costUsd: number; turns: number; from: string; to: string } | null;
  openRouter?: { totalCredits: number; totalUsage: number } | null;
  openRouterKey?: OpenRouterKeyUsage | null;
  /** The project's latest SDK account signals — the plan's name comes from here. Null when none were reported. */
  account: (AccountSignals & { at: string }) | null;
  /** Claude plan windows, newest snapshot each — `[]` until the first event. Expired ones are omitted. */
  claudeRateLimits: ClaudeRateLimitWindowView[];
}

function emptyAggregate(): CostAggregate {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    turns: 0,
    estimatedTurns: 0,
    unpricedTurns: 0,
  };
}

function emptyPeriod(): CostPeriod {
  return { ...emptyAggregate(), byAuthMode: {} };
}

function fold(agg: CostAggregate, e: CostEntry): void {
  agg.costUsd += e.costUsd;
  agg.inputTokens += e.inputTokens;
  agg.outputTokens += e.outputTokens;
  agg.cacheCreationTokens += e.cacheCreationTokens;
  agg.cacheReadTokens += e.cacheReadTokens;
  agg.cacheWrite5mTokens += e.cacheWrite5mTokens ?? 0;
  agg.cacheWrite1hTokens += e.cacheWrite1hTokens ?? 0;
  agg.turns += 1;
  if (e.costKind === "estimate") agg.estimatedTurns += 1;
  if (e.costKind === "unknown") agg.unpricedTurns += 1;
}

function foldPeriod(p: CostPeriod, e: CostEntry): void {
  fold(p, e);
  const key: CostModeKey = e.authMode ?? "unknown";
  const sub = p.byAuthMode[key] ?? emptyAggregate();
  fold(sub, e);
  p.byAuthMode[key] = sub;
}

/**
 * An entry's per-model rows. OpenRouter turns carry the SDK's rate-card cost
 * per model, which is not what OpenRouter bills — their cost goes to the
 * turn's own model, with the tokens per model.
 */
function modelRowsOf(e: CostEntry): Array<Omit<CostModelRow, "turns" | "authMode">> {
  const unknownModel = "unknown model";
  const estimated = e.costKind === "estimate" || e.costKind === "unknown";
  if (!e.models || e.models.length === 0) {
    return [{
      model: e.model ?? unknownModel,
      costUsd: e.costUsd,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheCreationTokens: e.cacheCreationTokens,
      estimated,
    }];
  }
  const sdkPriced = e.authMode !== "openrouter" && e.costKind !== "unknown";
  return e.models.map((m) => ({
    model: m.model,
    costUsd: sdkPriced ? m.costUsd : m.model === e.model ? e.costUsd : 0,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheCreationTokens: m.cacheCreationTokens,
    estimated: estimated || m.costBasis === "unknown",
  }));
}

function foldModels(rows: Map<string, CostModelRow>, e: CostEntry): void {
  const authMode: CostModeKey = e.authMode ?? "unknown";
  for (const r of modelRowsOf(e)) {
    const k = `${authMode}\u0000${r.model}`;
    const cur = rows.get(k) ?? {
      authMode, model: r.model, costUsd: 0, turns: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, estimated: false,
    };
    cur.costUsd += r.costUsd;
    cur.turns += 1;
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.cacheReadTokens += r.cacheReadTokens;
    cur.cacheCreationTokens += r.cacheCreationTokens;
    cur.estimated = cur.estimated || r.estimated;
    rows.set(k, cur);
  }
}

const sortRows = (m: Map<string, CostModelRow>) =>
  [...m.values()].sort((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model));

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Display order: current session, weekly (all models), then per-model weeklies. */
function windowRank(type: string): number {
  if (type === "five_hour") return 0;
  if (type === "seven_day") return 1;
  if (type.startsWith("seven_day")) return 2;
  return 3;
}

const KNOWN_WINDOW_LABELS: Record<string, string> = {
  five_hour: "current session",
  seven_day: "current week (all models)",
  seven_day_overage_included: "current week (incl. overage)",
  overage: "overage",
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fourteen: 14, thirty: 30,
};

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * A readable label for any window type the server sends. Known types keep
 * the Claude app's wording; anything else is read structurally — a leading
 * `<count>_<unit>` becomes the span, the rest names what it is scoped to —
 * so `seven_day_fable` reads "current week (Fable)" with no list to update.
 */
export function windowLabel(type: string): string {
  const known = KNOWN_WINDOW_LABELS[type];
  if (known) return known;
  const parts = type.split("_").filter(Boolean);
  const count = parts[0] !== undefined ? (NUMBER_WORDS[parts[0]] ?? (/^\d+$/.test(parts[0]) ? Number(parts[0]) : undefined)) : undefined;
  const unit = parts[1]?.replace(/s$/, "");
  if (count !== undefined && unit && ["minute", "hour", "day", "week", "month"].includes(unit)) {
    const span =
      count === 5 && unit === "hour" ? "current session"
        : count === 7 && unit === "day" ? "current week"
          : `${count}-${unit} window`;
    const scope = parts.slice(2).join(" ");
    return scope ? `${span} (${capitalise(scope)})` : span;
  }
  return parts.join(" ") || type;
}

/**
 * A window is dropped once its refill time has passed and the server has not
 * reported it since: it describes a period that is over. One absent from the
 * newest sized report is kept but marked, because per-model windows may be
 * sized only on turns that used that model.
 */
export function visibleWindows(
  windows: ClaudeRateLimitWindow[],
  latestSet: { types: string[] } | undefined,
  nowMs: number,
): ClaudeRateLimitWindowView[] {
  return windows
    .filter((w) => {
      if (typeof w.resetsAt !== "number") return true;
      const resetMs = w.resetsAt * 1000;
      if (resetMs > nowMs) return true;
      const seenMs = Date.parse(w.at);
      return Number.isFinite(seenMs) && seenMs >= resetMs;
    })
    .map((w) => ({
      ...w,
      label: windowLabel(w.type),
      inLatestReport: latestSet ? latestSet.types.includes(w.type) : null,
    }))
    .sort((a, b) => windowRank(a.type) - windowRank(b.type) || a.type.localeCompare(b.type));
}

/** ADR-0107 — per-session totals for one project, in a single pass. Entries
 *  recorded before sessions were tagged count for the project, not here. */
export function sessionCostTotals(projectId: string): Map<string, { turns: number; costUsd: number }> {
  const out = new Map<string, { turns: number; costUsd: number }>();
  for (const e of readCostFile().entries) {
    if (e.projectId !== projectId || !e.marvinSessionId) continue;
    const cur = out.get(e.marvinSessionId) ?? { turns: 0, costUsd: 0 };
    cur.turns += 1;
    cur.costUsd += e.costUsd;
    out.set(e.marvinSessionId, cur);
  }
  return out;
}

/** Optional filters: `projectId` narrows to a project; `marvinSessionId` to one session. */
export function summarizeCost(options: { projectId?: string; marvinSessionId?: string; now?: number } = {}): CostSummary {
  const { projectId, marvinSessionId } = options;
  const file = readCostFile();
  const matching = file.entries.filter(
    (e) => (!projectId || e.projectId === projectId) && (!marvinSessionId || e.marvinSessionId === marvinSessionId),
  );

  const today = emptyPeriod();
  const week = emptyPeriod();
  const lifetime = emptyPeriod();
  const modelsToday = new Map<string, CostModelRow>();
  const modelsWeek = new Map<string, CostModelRow>();
  const legacyAcc = { costUsd: 0, turns: 0, from: "", to: "" };

  const now = options.now ?? Date.now();
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;

  const byDay = new Map<string, { costUsd: number; turns: number }>();
  for (const e of matching) {
    if (e.v !== 2) {
      legacyAcc.costUsd += e.costUsd;
      legacyAcc.turns += 1;
      if (!legacyAcc.from || e.at < legacyAcc.from) legacyAcc.from = e.at;
      if (e.at > legacyAcc.to) legacyAcc.to = e.at;
      continue;
    }
    foldPeriod(lifetime, e);
    if (dayKey(e.at) === todayKey) {
      foldPeriod(today, e);
      foldModels(modelsToday, e);
    }
    if (new Date(e.at).getTime() >= weekCutoff) {
      foldPeriod(week, e);
      foldModels(modelsWeek, e);
    }
    const k = dayKey(e.at);
    const cur = byDay.get(k) ?? { costUsd: 0, turns: 0 };
    cur.costUsd += e.costUsd;
    cur.turns += 1;
    byDay.set(k, cur);
  }

  const daily = Array.from(byDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([day, v]) => ({ day, costUsd: v.costUsd, turns: v.turns }));

  return {
    today,
    week,
    lifetime,
    daily,
    byModel: { today: sortRows(modelsToday), week: sortRows(modelsWeek) },
    legacy: legacyAcc.turns > 0 ? legacyAcc : null,
    openRouter: file.openRouter ?? null,
    openRouterKey: file.openRouterKey ?? null,
    account: projectId ? (file.accounts?.[projectId] ?? null) : null,
    claudeRateLimits: visibleWindows(Object.values(file.claudeRateLimits ?? {}), file.claudeRateLimitsLatestSet, now),
  };
}
