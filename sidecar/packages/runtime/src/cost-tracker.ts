/**
 * Cost tracker for MARVIN.
 *
 * Backed by `~/.marvin/cost-tracker.json`. We keep a per-day ledger keyed by
 * `YYYY-MM-DD` (UTC) plus a lifetime total. Each turn contributes one entry
 * (projectId, cost, tokens, timestamp). Aggregation is computed on read —
 * the file is small enough that reading and aggregating on every request
 * is cheaper than maintaining a summary file in sync.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { ensureDir, marvinPaths } from "./paths";

export interface CostEntry {
  at: string; // ISO
  projectId: string;
  /** Claude CLI reported cost in USD for the turn. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
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

interface CostFileShape {
  entries: CostEntry[];
  openRouter?: {
    totalCredits: number;
    totalUsage: number;
    fetchedAt: string;
  };
  /** Latest snapshot per window type, keyed by `type`. */
  claudeRateLimits?: Record<string, ClaudeRateLimitWindow>;
}

function readCostFile(): CostFileShape {
  const path = marvinPaths.costTracker();
  if (!existsSync(path)) return { entries: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as CostFileShape;
    if (!parsed) return { entries: [] };
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  } catch {
    return { entries: [] };
  }
}

function writeCostFile(data: CostFileShape): void {
  const path = marvinPaths.costTracker();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

export interface RecordTurnInput {
  projectId: string;
  costUsd?: number | null;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
}

export function recordTurnCost(input: RecordTurnInput): void {
  if (input.costUsd == null && !input.tokenUsage) return;
  const file = readCostFile();
  const entry: CostEntry = {
    at: new Date().toISOString(),
    projectId: input.projectId,
    costUsd: typeof input.costUsd === "number" ? input.costUsd : 0,
    inputTokens: input.tokenUsage?.input_tokens ?? 0,
    outputTokens: input.tokenUsage?.output_tokens ?? 0,
    cacheCreationTokens: input.tokenUsage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: input.tokenUsage?.cache_read_input_tokens ?? 0,
  };
  file.entries.push(entry);
  writeCostFile(file);
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

export async function pollOpenRouterBalance(): Promise<void> {
  const { readAuthConfig } = await import("./auth-config");
  const cfg = readAuthConfig();
  if (cfg?.provider !== "openrouter" || !cfg.apiKey) return;
  try {
    // Bounded — this poll is awaited inside GET /api/cost, which the UI
    // polls; an unbounded fetch would hang the popover on a slow
    // openrouter.ai (same pattern as listModels' 6s AbortController).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let body: { data?: { total_credits?: number; total_usage?: number } };
    try {
      const res = await fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${cfg.apiKey.trim()}` },
        signal: controller.signal,
      });
      if (!res.ok) return;
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (body?.data?.total_credits !== undefined && body?.data?.total_usage !== undefined) {
      recordOpenRouterBalance(body.data.total_credits, body.data.total_usage);
    }
  } catch {
    /* ignore fetch errors in background */
  }
}

export interface CostSummary {
  today: CostAggregate;
  week: CostAggregate;
  lifetime: CostAggregate;
  /** Newest 12 day buckets (UTC) for the active project, oldest→newest. */
  daily: Array<{ day: string; costUsd: number; turns: number }>;
  openRouter?: { totalCredits: number; totalUsage: number } | null;
  /** Claude plan windows, newest snapshot each — `[]` until the first event. */
  claudeRateLimits: ClaudeRateLimitWindow[];
}

export interface CostAggregate {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turns: number;
}

function emptyAggregate(): CostAggregate {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    turns: 0,
  };
}

function fold(agg: CostAggregate, e: CostEntry): void {
  agg.costUsd += e.costUsd;
  agg.inputTokens += e.inputTokens;
  agg.outputTokens += e.outputTokens;
  agg.cacheCreationTokens += e.cacheCreationTokens;
  agg.cacheReadTokens += e.cacheReadTokens;
  agg.turns += 1;
}

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

/** Optional filter: if `projectId` is set, only entries for that project. */
export function summarizeCost(options: { projectId?: string } = {}): CostSummary {
  const { projectId } = options;
  const file = readCostFile();
  const entries = projectId
    ? file.entries.filter((e) => e.projectId === projectId)
    : file.entries;

  const today = emptyAggregate();
  const week = emptyAggregate();
  const lifetime = emptyAggregate();

  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;

  const byDay = new Map<string, { costUsd: number; turns: number }>();
  for (const e of entries) {
    fold(lifetime, e);
    if (dayKey(e.at) === todayKey) fold(today, e);
    if (new Date(e.at).getTime() >= weekCutoff) fold(week, e);
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
    openRouter: file.openRouter ?? null,
    claudeRateLimits: Object.values(file.claudeRateLimits ?? {}).sort(
      (a, b) => windowRank(a.type) - windowRank(b.type) || a.type.localeCompare(b.type),
    ),
  };
}
