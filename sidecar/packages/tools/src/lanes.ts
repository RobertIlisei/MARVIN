/**
 * Lanes (ADR-0107) — which repo-relative paths a shared-checkout tab owns.
 *
 * Anthropic's guidance for several sessions in ONE directory is partitioned
 * file ownership ("break the work so each teammate owns a different set of
 * files") and it provides no enforcement for it. A lane is that partition,
 * declared per tab: a list of repo-relative prefixes. The runtime gate raises
 * a confirm — never a silent deny — for an edit outside the lane, and for a
 * HEAD-moving git command when a lane is declared at all (ADR-0102 extended:
 * a tab that has claimed a lane has implicitly said other tabs may be live).
 *
 * Pure. Path semantics are prefix-by-segment: `src/api` owns `src/api/x.ts`
 * and `src/api`, not `src/api-v2/x.ts`. The root lane `.` owns everything.
 */

import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/** Normalise a repo-relative path for comparison: forward slashes, no leading `./`, no trailing `/`. */
export function normaliseRel(p: string): string {
  return p.split(sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\/+/, "");
}

/** Is `relPath` (repo-relative) inside one of `lane`'s prefixes? */
export function isInsideLane(relPath: string, lane: readonly string[]): boolean {
  const rel = normaliseRel(relPath);
  for (const raw of lane) {
    const prefix = normaliseRel(raw);
    if (prefix === "" || prefix === ".") return true;
    if (rel === prefix || rel.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * Resolve a tool's target against the checkout and answer whether it is
 * inside the lane. `null` when the target is outside the checkout entirely —
 * that is the normal permission ladder's business, not the lane's.
 */
export function laneVerdict(
  target: string,
  lane: readonly string[],
  checkout: string,
): { inside: boolean; rel: string } | null {
  const abs = isAbsolute(target) ? target : resolve(checkout, target);
  const rel = relative(resolve(checkout), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return rel === "" ? { inside: isInsideLane(".", lane), rel: "." } : null;
  }
  const posixRel = rel.split(sep).join(posix.sep);
  return { inside: isInsideLane(posixRel, lane), rel: posixRel };
}

/** Human line for the confirm. */
export function describeLane(lane: readonly string[]): string {
  const shown = lane.slice(0, 4).map((l) => (normaliseRel(l) === "" ? "." : normaliseRel(l)));
  return lane.length > 4 ? `${shown.join(", ")} (+${lane.length - 4} more)` : shown.join(", ");
}
