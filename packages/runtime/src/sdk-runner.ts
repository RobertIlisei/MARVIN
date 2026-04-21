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

import { type CanUseTool, type Options, type PermissionResult, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createGraphMcpServer } from "@marvin/graphify-bridge";
import { type ToolName, toolPolicy } from "@marvin/tools/policy";
import {
  clearTurnConfirms,
  registerPendingConfirm,
} from "./confirm-registry";
import { createPlaywrightMcpConfig } from "./playwright-mcp";

export type RuntimeMode = "opus" | "advisor";

/** Map a user-facing runtime mode to the SDK's model + advisorModel pair.
 *
 *  - `opus`: full Opus 4.7 everywhere — the default, highest quality.
 *  - `advisor`: Sonnet 4.6 drives the turn loop (cheap, fast), Opus 4.6 is
 *    registered as the `advisorModel` so the executor can call it through
 *    the server-side advisor tool on hard steps. Per Anthropic's launch
 *    data (advisor_20260301), this saves ~30-40% on routine code work
 *    with minimal quality loss.
 */
export function resolveRuntimeMode(mode: RuntimeMode): {
  model: string;
  advisorModel?: string;
} {
  if (mode === "advisor") {
    return {
      model: "claude-sonnet-4-6",
      advisorModel: "claude-opus-4-6",
    };
  }
  return { model: "claude-opus-4-7" };
}

/**
 * Permission strategy for a turn.
 *
 *   - `auto` (default): SDK runs with `permissionMode: "bypassPermissions"`,
 *     no `canUseTool` callback installed. Every tool call executes
 *     immediately — MARVIN behaves like Claude Code with
 *     `--dangerously-skip-permissions`. Best for experienced users who
 *     want uninterrupted flow.
 *   - `gated`: the pre-flight confirm gate is installed. Edit / Write /
 *     non-read-only Bash render a confirm card; reads + whitelisted
 *     commands auto-allow; destructive patterns hard-deny.
 */
export type PermissionStrategy = "auto" | "gated";

export interface RunAgentInput {
  message: string;
  cwd: string;
  model: string;
  /** Optional advisor model — enables the SDK's server-side advisor tool. */
  advisorModel?: string | undefined;
  /** Unique ID for this turn — used to key the confirm registry. */
  turnId: string;
  /** Resume a previous SDK session by ID (omit for a new one). */
  sessionId?: string | undefined;
  /** Permission strategy. Defaults to `auto` when omitted. */
  permissionStrategy?: PermissionStrategy;
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
    advisorModel,
    turnId,
    sessionId,
    appendSystemPrompt,
    onEvent,
    onConfirmRequest,
    signal,
  } = input;
  const permissionStrategy: PermissionStrategy = input.permissionStrategy ?? "auto";

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const canUseTool: CanUseTool = async (toolName, toolInput, { toolUseID, title, description, displayName }) => {
    const cls = classifyToolCall(toolName, toolInput);
    // The SDK's PermissionResult zod schema requires `updatedInput` to be a
    // record on `allow`. When the SDK hands us `toolInput === undefined` (or
    // a non-object), passing it through produces "Invalid input: expected
    // record, received undefined" and the turn dies. Always normalise.
    const safeInput: Record<string, unknown> =
      toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
        ? (toolInput as Record<string, unknown>)
        : {};

    if (cls.decision === "allow") {
      return { behavior: "allow", updatedInput: safeInput } as PermissionResult;
    }
    if (cls.decision === "deny") {
      return {
        behavior: "deny",
        message: cls.reason || "tool use denied",
        interrupt: false,
      } as PermissionResult;
    }
    // confirm — wait on the client.
    return new Promise<PermissionResult>((resolve) => {
      registerPendingConfirm(turnId, toolUseID, resolve, safeInput);
      onConfirmRequest({
        turnId,
        toolUseId: toolUseID,
        toolName,
        input: safeInput,
        reason: cls.reason,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(displayName ? { displayName } : {}),
      });
    });
  };

  // In-process MCP server exposing graphify graph tools to MARVIN. Built
  // per-turn so the server is scoped to the current workDir. Safe to always
  // include: if the project has no `graphify-out/`, the tools politely report
  // that instead of failing the turn.
  const graphMcp = createGraphMcpServer(cwd);

  // Playwright MCP — a real browser MARVIN controls, for screenshotting /
  // interacting with / verifying localhost sites. Registered only if
  // `@playwright/mcp` resolves on disk AND `MARVIN_PLAYWRIGHT != "0"`. The
  // stdio process is spawned by the SDK per turn.
  const playwrightMcp = createPlaywrightMcpConfig();

  // Permission wiring. In `auto` mode we don't install canUseTool at all
  // and ask the SDK for full bypass — MARVIN's agents just execute. In
  // `gated` mode we install the pre-flight gate so Edit / Write / unsafe
  // Bash render a confirm card, reads auto-allow, and destructive
  // patterns hard-deny.
  const options: Options = {
    model,
    cwd,
    abortController,
    permissionMode:
      permissionStrategy === "auto" ? "bypassPermissions" : "default",
    ...(permissionStrategy === "gated" ? { canUseTool } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: appendSystemPrompt,
    },
    mcpServers: {
      "marvin-graph": graphMcp,
      ...(playwrightMcp ? { "marvin-playwright": playwrightMcp } : {}),
    },
    includePartialMessages: false,
    ...(advisorModel ? { advisorModel } : {}),
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
