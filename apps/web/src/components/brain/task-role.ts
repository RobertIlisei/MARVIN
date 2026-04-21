/**
 * Task-subagent role detection for the Brain companion orbs.
 *
 * MARVIN spawns two kinds of subagent via the `Task` tool today: the
 * advisor (ADR-0007 — Opus-hinted second opinion) and the scout
 * (ADR-0014 — read-only parallel research). Both encode their role in
 * the `description` field with a leading prefix (`"advisor: …"`,
 * `"scout: …"`), which is the UI contract `personality.ts` tells
 * MARVIN to use when invoking them.
 *
 * This helper is the single place the prefix regex lives. Adding a
 * third role is one new entry in `ROLE_PREFIXES` — the orb rendering
 * and detection code should never grow a new regex of its own.
 */

export type TaskRole = "advisor" | "scout";

interface RoleMatch {
  role: TaskRole;
  /** The description text with the role prefix stripped. */
  topic: string;
}

/**
 * Ordered: advisor before scout so a hypothetical future `scout-advisor:`
 * brief would resolve as `advisor` (the more specific escalation mode).
 * Current invocation contracts never produce a collision; the ordering
 * is a tiebreaker, not a correctness requirement.
 */
const ROLE_PREFIXES: ReadonlyArray<{ role: TaskRole; re: RegExp }> = [
  { role: "advisor", re: /^\s*advisor[\s:—-]+(.*)$/i },
  { role: "scout", re: /^\s*scout[\s:—-]+(.*)$/i },
];

/** Extract the `description` string from a Task tool-use input, if any. */
export function taskDescriptionOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const d = (input as { description?: unknown }).description;
  return typeof d === "string" ? d : null;
}

/**
 * Classify a Task input by the role prefix on its description. Returns
 * null for Task calls that aren't MARVIN-sanctioned subagent patterns
 * (e.g. an ad-hoc `Task` the SDK preset exposes but that MARVIN didn't
 * route through the advisor/scout trigger rules — those don't light an
 * orb).
 */
export function taskRoleOf(input: unknown): RoleMatch | null {
  const desc = taskDescriptionOf(input);
  if (!desc) return null;
  for (const { role, re } of ROLE_PREFIXES) {
    const match = re.exec(desc);
    if (match) {
      const topic = (match[1] ?? "").trim();
      return { role, topic };
    }
  }
  return null;
}
