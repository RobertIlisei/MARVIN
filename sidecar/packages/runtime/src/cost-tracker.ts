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

interface CostFileShape {
  entries: CostEntry[];
  openRouter?: {
    totalCredits: number;
    totalUsage: number;
    fetchedAt: string;
  };
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

  return { today, week, lifetime, daily, openRouter: file.openRouter ?? null };
}
