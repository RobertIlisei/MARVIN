/**
 * Reasoning-effort ladder — the SDK `effort` values MARVIN drives per turn.
 *
 * Lives in its own dependency-free module so the wakeup scheduler and the
 * background-job runner can reason about effort without importing
 * `sdk-runner` (which imports THEM — a cycle). `sdk-runner` re-exports
 * everything here, so existing import paths keep working.
 *
 * Ladder, lowest to highest:
 *
 *   - `low`    — minimal extended thinking, fastest responses.
 *   - `medium` — moderate thinking.
 *   - `high`   — deep reasoning (the SDK default, MARVIN's baseline).
 *   - `xhigh`  — deeper than high. Opus-only; the rung that enables Claude's
 *                dynamic-workflow ("ultracode") behaviour. Falls back to
 *                `high` on non-Opus executors.
 *   - `max`    — maximum effort, longest budget. Opus-only; falls back to
 *                `high` on non-Opus executors.
 *
 * ## Dynamic effort (2026-08-29)
 *
 * The user's picker sets a CEILING, not a constant. Every turn used to run at
 * it, including the ones that only read a finished job's output and say
 * "green, continuing" — at `max`, each of those carries a full thinking budget
 * and a ~1.6K-char thinking signature per step, which the measured 158K-token
 * session showed as one of its largest non-content costs. Two rules move
 * effort below the ceiling; nothing ever moves it above:
 *
 *   1. A turn the MODEL schedules for itself may name the effort it will need
 *      (`schedule_wakeup({ effort })`): a "did the build pass?" check does not
 *      need what "continue the migration" needs, and the model knows which it
 *      is arming. `clampEffort` guarantees the request cannot exceed the
 *      ceiling.
 *   2. A background job that SUCCEEDED wakes the session one rung down
 *      (`stepDownEffort`): the follow-up is "read the result and carry on". A
 *      job that FAILED keeps the ceiling — diagnosing is real work.
 */

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Legacy 3-mode picker values, accepted for backward compatibility
 *  (persisted prefs, old transcripts). Mapped onto the effort ladder. */
const LEGACY_EFFORT_ALIAS: Record<string, ReasoningEffort> = {
  fast: "low",
  thinking: "high",
  // "max" is already a valid ladder rung — passes through.
};

export const EFFORT_LEVELS: readonly ReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Top rungs (`xhigh`, `max`) are Opus-only per the SDK; on other
 *  executors the SDK silently falls back to `high`, and so do we so
 *  the call is always valid even if the UI and a stale pref disagree. */
function supportsTopEffort(model: string): boolean {
  return /opus/i.test(model);
}

/**
 * Resolve a user-facing effort selection (new ladder value OR a legacy
 * fast/thinking/max alias) to a concrete SDK `effort`, applying the
 * Opus-only fallback for the top two rungs. Unknown / undefined input
 * defaults to `high` (the SDK default). Pure — exported so tests can
 * pin the mapping + fallback without spinning up a turn.
 */
export function resolveEffort(
  selection: string | undefined,
  model: string,
): ReasoningEffort {
  const raw = (selection ?? "high").toLowerCase();
  const mapped = LEGACY_EFFORT_ALIAS[raw] ?? (raw as ReasoningEffort);
  const level: ReasoningEffort = EFFORT_LEVELS.includes(mapped)
    ? mapped
    : "high";
  if ((level === "xhigh" || level === "max") && !supportsTopEffort(model)) {
    return "high";
  }
  return level;
}

/**
 * One rung below `selection`, floored at `low`. Resolves through
 * `resolveEffort` first, so a `max` on a non-Opus model steps down from the
 * `high` it would actually have run at, not from a rung it never had.
 */
export function stepDownEffort(
  selection: string | undefined,
  model: string,
): ReasoningEffort {
  const level = resolveEffort(selection, model);
  const i = EFFORT_LEVELS.indexOf(level);
  return EFFORT_LEVELS[Math.max(0, i - 1)] ?? "low";
}

/**
 * The lower of a requested effort and the user's ceiling. `undefined`
 * request → the ceiling, unchanged. This is the ONLY way a model-chosen
 * effort reaches a turn, which is what makes rule 1 above safe: the model
 * can spend less than the user allowed, never more.
 */
export function clampEffort(
  requested: string | undefined,
  ceiling: string | undefined,
  model: string,
): ReasoningEffort {
  const cap = resolveEffort(ceiling, model);
  if (requested === undefined) return cap;
  const want = resolveEffort(requested, model);
  return EFFORT_LEVELS.indexOf(want) < EFFORT_LEVELS.indexOf(cap) ? want : cap;
}
