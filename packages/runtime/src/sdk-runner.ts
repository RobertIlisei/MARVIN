/**
 * Claude Agent SDK runner — replacement for `runClaudeCli` that wires up a
 * proper pre-flight `canUseTool` gate. The SDK still spawns the Claude Code
 * binary under the hood but exposes a programmatic interface, which gives
 * us a structural confirm-before-act path that the raw CLI could not
 * (stdin was piped, so the CLI's interactive permission prompts never
 * reached the user).
 *
 * Event compatibility: the SDK emits messages whose inner shape matches
 * what the CLI was emitting (system/assistant/user/result blocks with the
 * same content arrays), so the web client's existing `cli.event` handler
 * keeps working without changes. We forward SDK messages to `onEvent`
 * verbatim.
 *
 * Confirm flow:
 *   1. SDK invokes `canUseTool(name, input, { toolUseID, ... })`.
 *   2. We consult the tool policy. Auto-allowed tools (Read/Grep/Glob/
 *      WebFetch/WebSearch + whitelisted Bash) resolve immediately.
 *   3. Otherwise we register a pending resolver keyed by (turnId,
 *      toolUseID), emit a `confirm.request` event to the client, and
 *      await the resolver. /api/confirm calls resolvePendingConfirm
 *      when the user clicks allow or deny.
 */

import { query, type CanUseTool, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  clearTurnConfirms,
  registerPendingConfirm,
} from "./confirm-registry";
import { toolPolicy, type ToolName } from "@marvin/tools/policy";

export interface RunAgentInput {
  message: string;
  cwd: string;
  model: string;
  /** Unique ID for this turn — used to key the confirm registry. */
  turnId: string;
  /** Resume a previous SDK session by ID (omit for a new one). */
  sessionId?: string | undefined;
  appendSystemPrompt: string;
  onEvent: (event: SDKMessage) => void;
  onConfirmRequest: (request: ConfirmRequestPayload) => void;
  signal?: AbortSignal;
}

export interface ConfirmRequestPayload {
  turnId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Free-text reason from the policy (why a confirm was needed). */
  reason: string;
  /** Optional human-facing title / description emitted by the SDK. */
  title?: string;
  description?: string;
  displayName?: string;
}

export interface RunAgentResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  durationMs?: number;
  costUsd?: number;
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  permissionDenials?: number;
}

const KNOWN_TOOL_NAMES = new Set<ToolName>([
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
]);

function classifyToolCall(
  name: string,
  input: Record<string, unknown>,
): { decision: "allow" | "confirm" | "deny"; reason: string } {
  // Tools outside our named set (Task, NotebookEdit, MCP, etc.) are
  // auto-allowed by default — they're sandboxed or delegate back to tools
  // we already gate.
  if (!KNOWN_TOOL_NAMES.has(name as ToolName)) {
    return { decision: "allow", reason: `${name} is not in the gated set.` };
  }
  const policy = toolPolicy(name as ToolName, input);
  if (policy.class === "auto") return { decision: "allow", reason: policy.reason };
  if (policy.class === "deny") return { decision: "deny", reason: policy.reason };
  return { decision: "confirm", reason: policy.reason };
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const {
    message,
    cwd,
    model,
    turnId,
    sessionId,
    appendSystemPrompt,
    onEvent,
    onConfirmRequest,
    signal,
  } = input;

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, { toolUseID, title, description, displayName }) => {
    const cls = classifyToolCall(toolName, toolInput);
    if (cls.decision === "allow") {
      return { behavior: "allow", updatedInput: toolInput } as PermissionResult;
    }
    if (cls.decision === "deny") {
      return {
        behavior: "deny",
        message: cls.reason,
        interrupt: false,
      } as PermissionResult;
    }
    // confirm — wait on the client.
    return new Promise<PermissionResult>((resolve) => {
      registerPendingConfirm(turnId, toolUseID, resolve);
      onConfirmRequest({
        turnId,
        toolUseId: toolUseID,
        toolName,
        input: toolInput,
        reason: cls.reason,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(displayName ? { displayName } : {}),
      });
    });
  };

  const options: Options = {
    model,
    cwd,
    abortController,
    canUseTool,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: appendSystemPrompt,
    },
    includePartialMessages: false,
    ...(sessionId ? { resume: sessionId } : {}),
  } as Options;

  let lastSessionId: string | undefined = sessionId;
  let durationMs: number | undefined;
  let costUsd: number | undefined;
  let tokenUsage: RunAgentResult["tokenUsage"];
  let permissionDenials = 0;
  let resultError: string | undefined;

  try {
    const q = query({ prompt: message, options });
    for await (const ev of q) {
      onEvent(ev);
      if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
        lastSessionId = ev.session_id;
      } else if (ev.type === "result") {
        lastSessionId = ev.session_id;
        durationMs = ev.duration_ms;
        if ("total_cost_usd" in ev && typeof ev.total_cost_usd === "number") {
          costUsd = ev.total_cost_usd;
        }
        if ("usage" in ev && ev.usage) {
          const u = ev.usage as Record<string, unknown>;
          tokenUsage = {
            ...(typeof u.input_tokens === "number" ? { input_tokens: u.input_tokens } : {}),
            ...(typeof u.output_tokens === "number" ? { output_tokens: u.output_tokens } : {}),
            ...(typeof u.cache_creation_input_tokens === "number"
              ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
              : {}),
            ...(typeof u.cache_read_input_tokens === "number"
              ? { cache_read_input_tokens: u.cache_read_input_tokens }
              : {}),
          };
        }
        if ("permission_denials" in ev && Array.isArray(ev.permission_denials)) {
          permissionDenials = ev.permission_denials.length;
        }
        if (ev.subtype === "error_during_execution" || ev.subtype === "error_max_turns") {
          resultError = `SDK result: ${ev.subtype}`;
        }
      }
    }
  } catch (err) {
    resultError = err instanceof Error ? err.message : String(err);
  } finally {
    // Any lingering confirm requests are auto-denied so the SDK unwinds.
    clearTurnConfirms(turnId);
  }

  if (resultError) {
    return {
      ok: false,
      error: resultError,
      ...(lastSessionId ? { sessionId: lastSessionId } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      ...(costUsd != null ? { costUsd } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      permissionDenials,
    };
  }
  return {
    ok: true,
    ...(lastSessionId ? { sessionId: lastSessionId } : {}),
    ...(durationMs != null ? { durationMs } : {}),
    ...(costUsd != null ? { costUsd } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    permissionDenials,
  };
}
