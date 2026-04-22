/**
 * Pure helpers powering the model picker's one-click presets.
 *
 * Extracted from `model-picker.tsx` so Vitest can import them without
 * a JSX-capable plugin (same reason `filter-matches.ts` exists
 * alongside `file-tree.tsx`).
 *
 * Presets mirror the two `RuntimeMode` values the backend understands
 * (`packages/runtime/src/sdk-runner.ts::resolveRuntimeMode`). Clicking
 * a preset rewrites the executor + advisor slots in one action — users
 * shouldn't have to learn that "advisor mode" means opening two
 * dropdowns by hand.
 */

import type { ModelInfo } from "./model-picker-types";

export type PresetId = "solo" | "advisor";

export interface Preset {
  id: PresetId;
  label: string;
  helper: string;
  /** Fallback values used when `/api/models` hasn't responded yet or the
   *  expected tier is missing from the list. These match the hardcoded
   *  defaults in `resolveRuntimeMode()` exactly. */
  fallback: { executor: string | null; advisor: string | null };
}

export const PRESETS: readonly Preset[] = [
  {
    id: "solo",
    label: "Solo Opus",
    helper: "Opus runs everything. Best quality, highest cost.",
    fallback: { executor: null, advisor: null },
  },
  {
    id: "advisor",
    label: "Advisor",
    helper: "Sonnet executes, Opus advises on hard steps. ~30% cheaper.",
    fallback: { executor: "claude-sonnet-4-6", advisor: "claude-opus-4-6" },
  },
] as const;

/**
 * Pick the freshest model id for a given tier from the live list. Falls
 * back to the hardcoded default when the live list is empty. `createdAt`
 * is the Anthropic release timestamp; sorting descending picks the newest.
 * Skips `live: false` entries so deprecated-but-listed models never win.
 */
export function pickTierId(
  tier: ModelInfo["tier"],
  models: ModelInfo[],
  fallback: string | null,
): string | null {
  const candidates = models
    .filter((m) => m.tier === tier && m.live)
    .sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      return bt - at;
    });
  return candidates[0]?.id ?? fallback;
}

/**
 * Resolve a preset to concrete model ids, using the live model list
 * when available. For `solo`, executor stays null so the server's
 * default model (whatever `resolveRuntimeMode("opus")` picks) applies.
 */
export function resolvePreset(
  preset: Preset,
  models: ModelInfo[],
): { executor: string | null; advisor: string | null } {
  if (preset.id === "solo") {
    return preset.fallback; // executor null + advisor null
  }
  // Advisor mode — prefer the latest live Sonnet + Opus ids so the
  // preset tracks model upgrades without needing a code change.
  return {
    executor: pickTierId("sonnet", models, preset.fallback.executor),
    advisor: pickTierId("opus", models, preset.fallback.advisor),
  };
}

/**
 * Which preset currently matches the chosen executor / advisor pair.
 * Returns null when the pair doesn't fit either preset — the user is
 * in power-user mode and both preset buttons should render dim.
 */
export function activePreset(
  executor: string | null,
  advisor: string | null,
  models: ModelInfo[],
): PresetId | null {
  // Solo: no advisor, executor is default (null) OR the latest Opus.
  if (!advisor) {
    if (!executor) return "solo";
    const latestOpus = pickTierId("opus", models, null);
    if (latestOpus && executor === latestOpus) return "solo";
    if (executor === "claude-opus-4-7") return "solo"; // hardcoded default
  }
  // Advisor: both slots filled, executor is Sonnet-tier, advisor is Opus-tier.
  if (executor && advisor) {
    const execModel = models.find((m) => m.id === executor);
    const advModel = models.find((m) => m.id === advisor);
    if (execModel?.tier === "sonnet" && advModel?.tier === "opus") {
      return "advisor";
    }
    // Fallback-list case: models[] is empty but ids match the hardcoded
    // advisor-mode defaults. Keeps the preset highlighted during the
    // loading moment instead of flickering to "custom" and back.
    if (
      models.length === 0 &&
      executor === "claude-sonnet-4-6" &&
      advisor === "claude-opus-4-6"
    ) {
      return "advisor";
    }
  }
  return null;
}
