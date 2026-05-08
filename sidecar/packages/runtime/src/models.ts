/**
 * Dynamic model discovery for MARVIN.
 *
 * Asks Anthropic's `/v1/models` API for the live list of models MARVIN
 * can target — executor OR advisor. Falls back to a minimal static list
 * only when the API is unreachable (no credentials, offline, etc.). We
 * surface the source so the UI can label fallback entries.
 *
 * Auth paths (best-effort, in order):
 *   1. `ANTHROPIC_API_KEY` (console API key) → `x-api-key` header.
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` (OAuth token) → `Authorization: Bearer …`.
 *      Also works when `ANTHROPIC_API_KEY` is shaped as `sk-ant-oat-*`.
 *   3. Host-credentials mode (token in macOS Keychain) — we can't read
 *      the token directly, so we fall through to the static list.
 */

import { getAnthropicAuth } from "./auth";

export interface ModelInfo {
  /** Canonical API model identifier, e.g. `claude-opus-4-7`. */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Coarse tier for UI grouping. */
  tier: "opus" | "sonnet" | "haiku" | "other";
  /** ISO date Anthropic reported as "created_at", when known. */
  createdAt: string | null;
  /**
   * True when the info came from Anthropic's live API. UIs may want to
   * warn the user when they're picking from the fallback list.
   */
  live: boolean;
}

export interface ListModelsResult {
  models: ModelInfo[];
  source: "anthropic-api" | "fallback";
  /** Present when the live API was attempted and failed. */
  error: string | null;
  fetchedAt: string;
}

/**
 * Minimal fallback list — kept up to date as Anthropic publishes new
 * flagships but intentionally short; the live API is the source of
 * truth. Marked `live: false` so the UI can flag them as "may be
 * stale".
 */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    tier: "opus",
    createdAt: null,
    live: false,
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    tier: "sonnet",
    createdAt: null,
    live: false,
  },
  {
    id: "claude-haiku-4-5-20251001",
    displayName: "Claude Haiku 4.5",
    tier: "haiku",
    createdAt: null,
    live: false,
  },
];

function tierFor(id: string): ModelInfo["tier"] {
  const lower = id.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return "other";
}

/**
 * Build the best available auth headers for an Anthropic API call.
 * Returns null when no usable credentials are exposed to the MARVIN
 * process (e.g. host-credentials mode with the token in Keychain).
 */
function buildAuthHeaders(): Record<string, string> | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth && /^sk-ant-oat/i.test(oauth)) {
    return {
      Authorization: `Bearer ${oauth}`,
      "anthropic-version": "2023-06-01",
    };
  }
  if (key) {
    if (/^sk-ant-oat/i.test(key)) {
      return {
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
      };
    }
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }
  return null;
}

interface AnthropicModelsResponse {
  data: Array<{
    id: string;
    type: string;
    display_name?: string;
    created_at?: string;
  }>;
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

/**
 * Fetch the live model list. Handles pagination by following
 * `last_id` + `has_more` until the API says we're done. Returns a
 * `ListModelsResult` with the source flagged correctly.
 */
export async function listModels(options: {
  /** Override the timeout for the upstream request. Default 6000ms. */
  timeoutMs?: number;
} = {}): Promise<ListModelsResult> {
  const auth = getAnthropicAuth();
  const fetchedAt = new Date().toISOString();

  // No credentials the MARVIN process can use → fallback.
  const headers = buildAuthHeaders();
  if (!headers) {
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      error:
        auth.mode === "host-credentials"
          ? "host-credentials token lives in the OS keychain and isn't readable by MARVIN; using fallback list"
          : "no credentials available to query the models API",
      fetchedAt,
    };
  }

  const timeoutMs = options.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const collected: ModelInfo[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL("https://api.anthropic.com/v1/models");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after_id", after);

      const res = await fetch(url.toString(), {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          models: FALLBACK_MODELS,
          source: "fallback",
          error: `anthropic /v1/models returned ${res.status}`,
          fetchedAt,
        };
      }
      const body = (await res.json()) as AnthropicModelsResponse;
      for (const m of body.data) {
        collected.push({
          id: m.id,
          displayName: m.display_name ?? m.id,
          tier: tierFor(m.id),
          createdAt: m.created_at ?? null,
          live: true,
        });
      }
      if (!body.has_more || !body.last_id) break;
      after = body.last_id;
    }

    // Sort by tier (opus → sonnet → haiku → other), then by createdAt desc
    // within a tier so the newest flagships land first.
    const tierOrder: Record<ModelInfo["tier"], number> = {
      opus: 0,
      sonnet: 1,
      haiku: 2,
      other: 3,
    };
    collected.sort((a, b) => {
      const t = (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99);
      if (t !== 0) return t;
      const av = a.createdAt ?? "";
      const bv = b.createdAt ?? "";
      if (av > bv) return -1;
      if (av < bv) return 1;
      return a.id.localeCompare(b.id);
    });

    return {
      models: collected.length > 0 ? collected : FALLBACK_MODELS,
      source: collected.length > 0 ? "anthropic-api" : "fallback",
      error: collected.length > 0 ? null : "empty response from /v1/models",
      fetchedAt,
    };
  } catch (err) {
    return {
      models: FALLBACK_MODELS,
      source: "fallback",
      error: err instanceof Error ? err.message : String(err),
      fetchedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
