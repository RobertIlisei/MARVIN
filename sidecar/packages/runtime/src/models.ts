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

import { getAnthropicAuth, readHostOAuthToken } from "./auth";
import { readAuthConfig } from "./auth-config";

export interface ModelInfo {
  /** Canonical API model identifier, e.g. `claude-opus-4-8`. */
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
    id: "claude-opus-4-8",
    displayName: "Claude Opus 4.8",
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

/** Shape an Anthropic auth header from a raw key/token, picking the
 *  right header per credential shape (OAuth → Bearer, console → x-api-key). */
function headersForCredential(cred: string): Record<string, string> {
  if (/^sk-ant-oat/i.test(cred)) {
    return {
      Authorization: `Bearer ${cred}`,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "x-api-key": cred,
    "anthropic-version": "2023-06-01",
  };
}

/**
 * Build the best available auth headers for an Anthropic API call.
 * Resolution order mirrors `getAnthropicAuth`:
 *   1. UI-configured API key (`auth-config.json`, mode "api-key").
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env (OAuth-shaped).
 *   3. `ANTHROPIC_API_KEY` env (console key OR OAuth-shaped).
 *   4. Host-credentials: the OAuth token from the macOS Keychain — the
 *      default logged-in-Mac case. Before ADR-0029 this returned null,
 *      which is why `/v1/models` always served the stale fallback list.
 * Returns null only when no credential is reachable at all.
 */
function buildAuthHeaders(): Record<string, string> | null {
  // 1. UI-configured key wins, mirroring auth.ts precedence.
  const cfg = readAuthConfig();
  if (cfg?.mode === "api-key" && cfg.apiKey) {
    return headersForCredential(cfg.apiKey.trim());
  }

  // 2 + 3. Env-var credentials.
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth && /^sk-ant-oat/i.test(oauth)) {
    return headersForCredential(oauth);
  }
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    return headersForCredential(key);
  }

  // 4. Host-credentials — read the OAuth token from the Keychain (darwin).
  // This is the gap ADR-0029 closes: the default Mac login mode.
  const hostToken = readHostOAuthToken();
  if (hostToken) {
    return headersForCredential(hostToken);
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
          ? "could not read the Claude Code token from the macOS Keychain " +
            "(item missing, expired, or access declined); using fallback list. " +
            "Approve the Keychain prompt, or run `claude auth login` to refresh."
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

/**
 * Pick the newest model id for a tier from a model list. `createdAt` is
 * Anthropic's release timestamp; descending sort puts the newest first.
 * `live: false` entries (fallback list) are eligible only when no live
 * entry of that tier exists, so a stale pin never shadows a fresh model.
 * Pure — exported for tests and for the picker presets to share one
 * definition. Returns null when the tier is absent entirely.
 */
export function newestOfTier(
  models: ModelInfo[],
  tier: ModelInfo["tier"],
): string | null {
  const ranked = models
    .filter((m) => m.tier === tier)
    .sort((a, b) => {
      // Live beats fallback first.
      if (a.live !== b.live) return a.live ? -1 : 1;
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bt - at;
    });
  return ranked[0]?.id ?? null;
}

/**
 * TTL cache over `listModels` so the per-turn `resolveRuntimeMode` path
 * doesn't pay a ~1s `/v1/models` round-trip (and possible Keychain
 * prompt) on every turn. 10-minute window — models don't ship that
 * often, and the picker still calls `listModels` directly (no-store) so
 * the UI is always current.
 */
let modelCache: { result: ListModelsResult; at: number } | null = null;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

async function cachedListModels(): Promise<ListModelsResult> {
  const now = Date.now();
  if (modelCache && now - modelCache.at < MODEL_CACHE_TTL_MS) {
    return modelCache.result;
  }
  const result = await listModels();
  // Only cache a live result — a fallback (offline / denied prompt)
  // should be retried on the next call rather than pinned for 10 min.
  if (result.source === "anthropic-api") {
    modelCache = { result, at: now };
  }
  return result;
}

/**
 * Resolve the newest live model id for a tier, going through the TTL
 * cache. Falls back to the static FALLBACK_MODELS list's newest entry
 * of that tier when discovery is unavailable. This is the runtime-side
 * counterpart to the picker's `pickTierId` — both answer "what's the
 * current best <tier> model" without any hardcoded version number.
 */
export async function latestForTier(
  tier: ModelInfo["tier"],
): Promise<string | null> {
  const result = await cachedListModels();
  const live = newestOfTier(result.models, tier);
  if (live) return live;
  return newestOfTier(FALLBACK_MODELS, tier);
}

/** Test seam: drop the TTL cache so a test can force a fresh resolve. */
export function __clearModelCacheForTests(): void {
  modelCache = null;
}

/** Default context-window size when a model carries no explicit hint. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** The extended-window variant size, opted in via the `[1m]` / `-1m` suffix. */
const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/**
 * Resolve a model id to its context-window size in tokens.
 *
 * The Anthropic `/v1/models` API does not report window size, so this is a
 * lookup, not a fetch. The only signal we get for free is the extended-context
 * marker the runtime appends to a model id when the 1M window is enabled —
 * `claude-opus-4-8[1m]` (and the `-1m` spelling some surfaces use). Everything
 * else is the standard 200K window. Used by `GET /api/context` to compute the
 * usage percentage and the colour-band thresholds, so a 1M session isn't
 * flagged "critical" at 140K (which would be 14% of its real capacity).
 */
export function contextWindowFor(modelId: string | null | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  const lower = modelId.toLowerCase();
  if (lower.includes("[1m]") || lower.includes("-1m") || lower.includes("1m]")) {
    return EXTENDED_CONTEXT_WINDOW;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Synchronous newest-of-tier over the static fallback list only. No
 * network, no Keychain — the last-resort default when discovery can't
 * run at all (sync call sites like `defaultModel()`). This keeps the
 * single hardcoded "last known good" id in exactly one place:
 * FALLBACK_MODELS above. ADR-0029.
 */
export function fallbackNewestOfTier(tier: ModelInfo["tier"]): string | null {
  return newestOfTier(FALLBACK_MODELS, tier);
}
