/**
 * Branches a queued entry still needs (ADR-0133 decision 3).
 *
 * `after: ["A"]` waits for A's branch to read `merged` in the DERIVED worktree
 * state (ADR-0103). A sweep reclaims a merged session branch the moment its
 * tab closes, and a branch that is gone cannot be told from one that was
 * discarded — so the sweep keeps a predecessor's branch while an entry that
 * comes after it is still waiting. Once the successor opens (or leaves the
 * queue) the branch is reclaimed as before.
 *
 * A leaf on purpose: `worktrees.ts` imports it, so it parses `queue.json`
 * itself and imports nothing that could import `worktrees.ts` back. It only
 * ever makes a branch live longer, so it needs no more validation than that.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isSafeProjectId, supervisorDir } from "./supervisor-ledger";

export function branchesHeldForQueue(projectId: string): Set<string> {
  const out = new Set<string>();
  if (!isSafeProjectId(projectId)) return out;
  const file = path.join(supervisorDir(projectId), "queue.json");
  if (!existsSync(file)) return out;
  try {
    const entries = (JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return out;
    const byId = new Map<string, { branch?: unknown }>();
    for (const e of entries) if (e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string") byId.set((e as { id: string }).id, { branch: (e as { openedBranch?: unknown }).openedBranch });
    for (const e of entries) {
      const o = e as { status?: unknown; after?: unknown };
      if (o?.status !== "queued" || !Array.isArray(o.after)) continue;
      for (const a of o.after) {
        const b = typeof a === "string" ? byId.get(a)?.branch : undefined;
        if (typeof b === "string" && b) out.add(b);
      }
    }
  } catch {
    /* an unreadable queue holds nothing */
  }
  return out;
}
