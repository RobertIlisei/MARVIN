/**
 * ADR-0127 §5 — the executor's half of the side-door rule.
 *
 * `toolPolicy` hard-denies a tab tool call that names MARVIN's own control API
 * or the supervisor's data directory, but Read / Grep / Glob never reach the
 * permission callback (`sdk-runner.ts`: the SDK auto-allows them). This
 * PreToolUse hook applies the same rule to every tool, in every posture,
 * before the SDK's permission pipeline runs.
 */

import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { supervisorBoundaryDenial } from "@marvin/tools/policy";

export function makeSideDoorPreToolUseHook(): HookCallback {
  return async (input) => {
    const evt = input as { tool_name?: unknown; tool_input?: unknown };
    const toolInput = evt.tool_input && typeof evt.tool_input === "object" ? (evt.tool_input as Record<string, unknown>) : {};
    const denial = supervisorBoundaryDenial(String(evt.tool_name ?? ""), toolInput);
    if (!denial) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denial.reason },
    } as HookJSONOutput;
  };
}
