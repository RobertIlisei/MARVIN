/**
 * SubagentRegistry — which running subagent is which (ADR-0081).
 *
 * `canUseTool` receives an `agentID` for every call made inside a subagent,
 * and nothing else about it. The SDK's `system/task_started` message is the
 * only place the pair (`task_id`, `subagent_type`) is stated — and verified
 * live (2026-08-29), the `agentID` on the inner calls IS that `task_id`.
 * This registry keeps the mapping for the life of the turn so the gate can
 * apply per-type policy: the implementer's worktree allowance, and nothing
 * for anyone else.
 *
 * Binding an implementer to its worktree also happens here. The dispatch
 * prompt is MARVIN's own text and names the worktree path; matching it
 * against the registered worktrees is deterministic and needs no new field
 * on the Agent tool (whose `cwd` is ignored anyway).
 */

export interface SubagentBinding {
  turnId: string;
  subagentType: string;
  /** Absolute worktree path — only for implementers. */
  worktree?: string;
}

const bindings = new Map<string, SubagentBinding>();

export const IMPLEMENTER_TYPE = "implementer";

/** Narrow an SDK message to the `task_started` payload this registry consumes. */
export function taskStartedPayload(
  ev: unknown,
): { task_id: string; subagent_type?: string; prompt?: string } | null {
  if (!ev || typeof ev !== "object") return null;
  const o = ev as Record<string, unknown>;
  if (o.type !== "system" || o.subtype !== "task_started") return null;
  if (typeof o.task_id !== "string") return null;
  return {
    task_id: o.task_id,
    ...(typeof o.subagent_type === "string" ? { subagent_type: o.subagent_type } : {}),
    ...(typeof o.prompt === "string" ? { prompt: o.prompt } : {}),
  };
}

/**
 * Record a started subagent. `worktrees` are the registered paths for this
 * workDir; an implementer whose prompt names exactly one of them is bound to
 * it. Naming none (or several) leaves it unbound, and unbound implementers
 * fall through to the ordinary read-only collapse — the safe default.
 */
export function registerSubagent(args: {
  turnId: string;
  taskId: string;
  subagentType: string;
  prompt?: string;
  worktrees: readonly string[];
}): SubagentBinding {
  const { turnId, taskId, subagentType, prompt, worktrees } = args;
  let worktree: string | undefined;
  if (subagentType === IMPLEMENTER_TYPE && prompt) {
    const named = worktrees.filter((w) => prompt.includes(w));
    if (named.length === 1) worktree = named[0];
  }
  const binding: SubagentBinding = { turnId, subagentType, ...(worktree ? { worktree } : {}) };
  bindings.set(taskId, binding);
  return binding;
}

export function lookupSubagent(agentID: string | undefined): SubagentBinding | undefined {
  return agentID ? bindings.get(agentID) : undefined;
}

/** Drop every binding the turn created. Called from `runAgent`'s finally. */
export function clearSubagentsForTurn(turnId: string): void {
  for (const [id, b] of bindings) if (b.turnId === turnId) bindings.delete(id);
}

/** Test hook. */
export function _resetSubagentRegistry(): void {
  bindings.clear();
}
