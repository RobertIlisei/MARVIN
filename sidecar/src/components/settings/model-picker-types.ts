/**
 * Shared model-picker types, extracted into a pure .ts module so
 * non-TSX consumers (Vitest, the preset helpers) can import them
 * without dragging JSX through Vite's import-analyser. `model-picker.tsx`
 * re-exports `ModelInfo` + `ModelsResponse` so existing imports keep
 * working.
 */

export interface ModelInfo {
  id: string;
  displayName: string;
  tier: "opus" | "sonnet" | "haiku" | "other";
  createdAt: string | null;
  live: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  source: "anthropic-api" | "fallback";
  error: string | null;
  fetchedAt: string;
}
