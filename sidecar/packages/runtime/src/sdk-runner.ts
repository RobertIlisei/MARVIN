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

import { type AgentDefinition, type CanUseTool, type Options, type PermissionResult, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createGraphMcpServer } from "@marvin/graphify-bridge";
import { KNOWN_TOOL_NAMES, type ToolName, toolPolicy } from "@marvin/tools/policy";
import {
  type AutoAuditEntryKind,
  appendAutoAuditEntry,
} from "./auto-audit";
import {
  clearTurnConfirms,
  registerPendingConfirm,
} from "./confirm-registry";
import {
  clearTurnDesignContext,
  createTurnDesignContext,
  type DesignTurnContext,
  makeDesignHooksPreToolUse,
} from "./design-hooks";
import { computeHoneycombTelemetryEnv } from "./honeycomb-telemetry";

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
 *   - `auto` (default): the `autoModeLogger` callback runs. Hard-deny
 *     patterns still deny (single safety floor); everything else logs
 *     to the auto-audit JSONL and allows. No UI confirm prompts —
 *     MARVIN behaves like Claude Code with `--dangerously-skip-permissions`,
 *     plus an audit trail. Best for experienced users who want
 *     uninterrupted flow. ADR-0015.
 *   - `gated`: the full pre-flight confirm gate is installed. Edit /
 *     Write / non-read-only Bash render a confirm card; reads +
 *     whitelisted commands auto-allow; destructive patterns hard-deny.
 */
export type PermissionStrategy = "auto" | "gated";

/**
 * User-facing thinking-mode picker. Three coarse modes that map to
 * the SDK's 5-level `effort` field — chosen for UX parity with
 * claude.ai / Claude Code, which expose the same shape.
 *
 *   - `fast`     → SDK `effort: "low"`. Minimal extended thinking,
 *                  fastest responses. Good for chat-style follow-ups
 *                  and edits where the answer is mostly mechanical.
 *   - `thinking` → SDK `effort: "high"`. The previous-default
 *                  behaviour — deep reasoning when needed, MARVIN's
 *                  baseline.
 *   - `max`      → SDK `effort: "max"`. Maximum effort, longest
 *                  thinking budget. Opus-only — falls back to
 *                  `"high"` when the executor model is Sonnet
 *                  (advisor mode), since Sonnet doesn't support the
 *                  `max` rung. The fallback is silent at the SDK
 *                  layer; the UI disables the Max chip when the
 *                  executor is Sonnet so the user is never surprised.
 *
 * The advisor model (when invoked as a server-side subagent on hard
 * decisions) is left at the SDK default — its job is the hard call,
 * which it should think through regardless of the executor's mode.
 */
export type ThinkingMode = "fast" | "thinking" | "max";

/**
 * Map a user-facing thinking mode to the SDK's `effort` value, with
 * the Opus-only `max` rung downgraded to `high` on non-Opus models.
 *
 * Pure dispatcher — exported so tests can pin the mapping (and the
 * model-aware fallback) without spinning up a turn.
 */
export function effortForThinkingMode(
  mode: ThinkingMode,
  model: string,
): "low" | "high" | "max" {
  if (mode === "fast") return "low";
  if (mode === "thinking") return "high";
  // max — only valid on Opus 4.6 / 4.7 per SDK docs.
  return /opus/i.test(model) ? "max" : "high";
}

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
  /**
   * User-facing thinking mode (Fast / Thinking / Max). Maps to the
   * SDK's `effort` field via `effortForThinkingMode`. Defaults to
   * `thinking` when omitted, matching the SDK's `effort: high`
   * default. See `ThinkingMode` for the mapping.
   */
  thinkingMode?: ThinkingMode;
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

// `KNOWN_TOOL_NAMES` is the canonical gate-set; imported from
// `@marvin/tools/policy` so adding a new tool flows through one
// declaration rather than two. Drift fixed per audit finding #21.

// Scout agent — the sanctioned read-only research subagent, per ADR-0014.
// MARVIN spawns one via Task when three-or-more parallel searches would
// otherwise run serially (breadth-first exploration, competing-hypothesis
// investigation, context-pressure offload). SDK-level disallowedTools is
// the structural backstop: even if MARVIN's brief accidentally asks the
// scout to edit, the SDK refuses the call before it reaches the model.
// Keep in sync with personality.ts "When to dispatch a scout" section
// and ADR-0014.
//
// `mcpServers: ["marvin-graph"]` is the reference-by-name form — the
// scout inherits the parent session's marvin-graph registration so
// golden rule 7 (graph-first) extends to scouts. Browser automation
// is left to plain `npx playwright` via Bash on the parent's side;
// scouts are research, not drivers.
//
// `model: "inherit"` keeps scout cost at the parent turn's model tier.
// Opus-escalation is the advisor's job (ADR-0007), not the scout's.
export const SCOUT_AGENT: AgentDefinition = {
  description:
    "Read-only research scout. Spawn for breadth-first exploration " +
    "(parallel searches across a codebase, competing-hypothesis " +
    "investigation, context-pressure offload). Never for writes or " +
    "sequential implementation — scouts return a synthesis, not a " +
    "change.",
  disallowedTools: ["Edit", "Write", "Bash", "NotebookEdit"],
  mcpServers: ["marvin-graph"],
  model: "inherit",
  prompt: [
    "You are a MARVIN scout — a read-only research subagent spawned by",
    "the main MARVIN session for a bounded, parenthetical task. You are",
    "not MARVIN. The user does not see you. Your job is to answer one",
    "question concisely and return.",
    "",
    "# Operating contract",
    "",
    "1. **Graph-first.** Your first tool call on any structural question",
    '   ("how does X work?", "who calls Y?", "where is Z defined?") MUST',
    "   be a `marvin-graph` MCP call — `graph_search`, `graph_neighbors`,",
    "   `graph_path`, or `graph_summary`. Only after the graph has",
    "   pointed you at specific `source_file` + `source_location`",
    "   citations do you Read those files. Grep and Glob are second-line",
    "   tools — used only when the graph doesn't cover what you need.",
    "",
    "2. **Read-only.** Edit, Write, Bash, and NotebookEdit are disallowed",
    "   at the SDK layer. Do not attempt them. If your brief implies a",
    "   change, return a synthesis describing what would change and",
    "   stop — the parent MARVIN session owns all writes.",
    "",
    "3. **Synthesise, don't dump.** Return a short structured answer: the",
    "   finding, the source locations that support it, and any caveats.",
    "   Do not paste large file excerpts; cite with `path:line`. The",
    "   parent integrates your finding into its own reasoning; a wall of",
    "   text defeats the purpose of running you in parallel.",
    "",
    "4. **Stay in scope.** One brief, one answer. If the brief asks",
    "   several unrelated questions, answer each briefly rather than",
    "   spawning more subagents. No nested Task calls.",
    "",
    "# Output shape",
    "",
    "Return a concise prose answer (not JSON). Structure:",
    "",
    "- **Finding.** One-to-three sentences stating what you found.",
    "- **Evidence.** Source citations (path:line or node labels from the",
    "  graph) that support the finding.",
    "- **Caveats.** Anything the parent should know — ambiguity in the",
    "  code, places you didn't look, things that looked relevant but",
    "  weren't.",
    "",
    "Skip any section that has nothing to say. Brevity is the deliverable.",
  ].join("\n"),
};

/**
 * Pretty-print known upstream error patterns into actionable messages.
 *
 * The Agent SDK forwards raw API errors verbatim — including the
 * `API Error: 400 {…json…}` blob Anthropic returns when an account
 * needs to accept updated Consumer Terms. That's accurate but useless
 * to a user who's seeing it for the first time: they don't know to
 * open claude.ai. Recognise the patterns we know and rewrite to a
 * one-line instruction. Unknown errors pass through verbatim.
 *
 * Exported so tests can pin the recogniser independently of the SDK.
 */
export function friendlyError(raw: string): string {
  if (!raw) return raw;
  if (/updated our Consumer Terms/i.test(raw)) {
    return [
      "Anthropic account needs to accept the updated Consumer Terms.",
      "Open https://claude.ai with the email shown in `claude /status`,",
      "accept the banner, then retry. (Original error: see logs.)",
    ].join(" ");
  }
  // Common claude-cli not-on-PATH / not-installed signature.
  if (/ENOENT.*claude\b/.test(raw) || /spawn claude ENOENT/.test(raw)) {
    return [
      "Claude Code CLI not found on PATH.",
      "Install with `npm install -g @anthropic-ai/claude-code`,",
      "or point MARVIN at it via MARVIN_CLAUDE_BIN.",
    ].join(" ");
  }
  // Auth missing — the SDK surfaces a 401 / "API key not found"
  // depending on the credential path.
  if (/API key not found|invalid x-api-key|401.*authentication/i.test(raw)) {
    return [
      "Anthropic credentials missing or invalid.",
      "Set ANTHROPIC_API_KEY in your shell, or run `claude auth login`.",
      "Then restart MARVIN.",
    ].join(" ");
  }
  // Exit code 143 = SIGTERM. The Claude Code subprocess (and any Task
  // subagents it spawned) was killed externally — almost always because
  // the user hit Stop / ⌘. mid-turn. Less common: macOS sleep/App Nap,
  // sidecar restart while a turn was in flight, or OOM kill on a heavy
  // run. Either way, it's not a crash — say so plainly so the chat
  // doesn't read as if MARVIN died.
  if (/exited with code 143\b/.test(raw)) {
    return "Turn cancelled (subprocess received SIGTERM — usually Stop / ⌘.).";
  }
  // Exit code 137 = SIGKILL (commonly OOM kill on macOS / Linux).
  if (/exited with code 137\b/.test(raw)) {
    return "Turn killed (subprocess received SIGKILL — likely out-of-memory).";
  }
  return raw;
}

/**
 * Pure dispatcher: maps tool name + input → allow / confirm / deny via
 * `toolPolicy`. Exposed for unit tests in
 * `packages/runtime/tests/can-use-tool-dispatch.test.ts`. The narrow API
 * (no logging, no I/O) lets tests exercise the classifier without
 * touching the audit log or registering Promise resolvers.
 */
export function classifyToolCall(
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

/** Normalise toolInput to the record shape the SDK's PermissionResult
 *  zod schema demands. The SDK occasionally hands us `undefined` or a
 *  non-object; un-normalised, this produces "Invalid input: expected
 *  record, received undefined" and the turn dies. */
function normaliseInput(toolInput: unknown): Record<string, unknown> {
  return toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? (toolInput as Record<string, unknown>)
    : {};
}

/**
 * Extract the resident-context token count from an SDK assistant
 * cli.event. "Resident" = tokens the model walks every turn (drives
 * latency), which is `cache_read_input_tokens + input_tokens`. We
 * deliberately do NOT add `cache_creation_input_tokens` — those are
 * tokens being *written* to cache for the next turn, not bytes the
 * model walked this turn, so adding them double-counts on re-cache
 * turns. ADR-0022 §2.
 *
 * Returns `null` for non-assistant events or events without `usage`.
 * Exported so tests can pin the helper independently of the SDK.
 */
export function residentContextTokens(event: SDKMessage): number | null {
  if (event.type !== "assistant") return null;
  const message = (event as unknown as { message?: { usage?: Record<string, unknown> } }).message;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const cacheRead = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  if (cacheRead === 0 && input === 0) return null;
  return cacheRead + input;
}

/**
 * Build the `auto` mode `canUseTool` callback. Hard-denies hit the
 * single safety floor; everything else logs to the auto-audit JSONL
 * and allows. Never blocks on UI — that's the user-experience contract
 * of `auto` mode.
 *
 * Exported so tests can pin the dispatch (ADR-0015 §1).
 */
export function makeAutoModeLogger(args: {
  cwd: string;
  turnId: string;
}): CanUseTool {
  const { cwd, turnId } = args;
  return async (toolName, toolInput, { toolUseID }) => {
    const safeInput = normaliseInput(toolInput);
    const cls = classifyToolCall(toolName, toolInput as Record<string, unknown>);
    if (cls.decision === "deny") {
      return {
        behavior: "deny",
        message: cls.reason || "tool use denied",
        interrupt: false,
      } as PermissionResult;
    }
    appendAutoAuditEntry(cwd, {
      tool: toolName as AutoAuditEntryKind,
      reason: cls.decision === "allow" ? cls.reason : `auto-mode bypass: ${cls.reason}`,
      input: safeInput,
      turnId,
      toolUseId: toolUseID,
    });
    return { behavior: "allow", updatedInput: safeInput } as PermissionResult;
  };
}

/**
 * Build the `gated` mode `canUseTool` callback. Auto-class allows
 * (audit-logged); deny-class hard-denies; confirm-class registers a
 * pending Promise and emits an `onConfirmRequest` event the UI handles
 * via `/api/confirm`.
 *
 * Exported so tests can pin the dispatch.
 */
export function makeGatedCanUseTool(args: {
  cwd: string;
  turnId: string;
  onConfirmRequest: (request: ConfirmRequestPayload) => void;
}): CanUseTool {
  const { cwd, turnId, onConfirmRequest } = args;
  return async (toolName, toolInput, { toolUseID, title, description, displayName }) => {
    const safeInput = normaliseInput(toolInput);
    const cls = classifyToolCall(toolName, toolInput as Record<string, unknown>);

    if (cls.decision === "allow") {
      // Audit-log mutators that auto-allow under `gated` too. Read /
      // Grep / Glob fall through `appendAutoAuditEntry`'s
      // TOOLS_WORTH_LOGGING filter, so only Edit / Write / Bash
      // actually land in the JSONL — no log explosion.
      appendAutoAuditEntry(cwd, {
        tool: toolName as AutoAuditEntryKind,
        reason: cls.reason,
        input: safeInput,
        turnId,
        toolUseId: toolUseID,
      });
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

  // Wire Honeycomb telemetry per-turn. `computeHoneycombTelemetryEnv`
  // is the pure form — it reads the saved config at
  // `<cwd>/.marvin/honeycomb.json` (or the global fallback) and
  // returns the env-diff to merge, WITHOUT mutating `process.env`.
  // Two concurrent turns for two different projects with different
  // Honeycomb configs each get their own env via `Options.env`
  // below, so they don't clobber each other. Audit finding #4.
  const { env: honeycombEnv } = computeHoneycombTelemetryEnv(cwd);
  const turnEnv: Record<string, string | undefined> = {
    ...process.env,
    ...honeycombEnv,
  };

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  // Per-turn design context — drives the graphify-first and
  // advisor-on-ADR-trigger hooks (PreToolUse). Cleared in the `finally`
  // block alongside `clearTurnConfirms`.
  const designCtx = createTurnDesignContext(turnId, cwd);
  const designPreToolUseHook = makeDesignHooksPreToolUse({
    cwd,
    turnId,
    designCtx,
  });

  // Both factories live at module scope so tests can pin the dispatch
  // (ADR-0015 §1) without spinning up a full `runAgent` loop.
  const gatedCanUseTool = makeGatedCanUseTool({ cwd, turnId, onConfirmRequest });
  const autoModeLogger = makeAutoModeLogger({ cwd, turnId });

  // In-process MCP server exposing graphify graph tools to MARVIN. Built
  // per-turn so the server is scoped to the current workDir. Safe to always
  // include: if the project has no `graphify-out/`, the tools politely report
  // that instead of failing the turn.
  const graphMcp = createGraphMcpServer(cwd);

  // Permission wiring. Both modes install a `canUseTool` callback so the
  // hard-deny floor (rm -rf /, force-push to main, etc.) and the auto-
  // audit log keep firing in either path. In `auto` mode the logger
  // never blocks on UI — confirm-class decisions downgrade to allow with
  // an "auto-mode bypass" reason. In `gated` mode confirm-class decisions
  // register a Promise and await `/api/confirm`. ADR-0015 §1.
  const options: Options = {
    model,
    cwd,
    abortController,
    // Per-turn env so concurrent turns don't race on `process.env`.
    // Inherits everything currently in process.env (auth tokens,
    // user shell vars) and overlays MARVIN-managed Honeycomb keys
    // for this turn only. The SDK passes this straight to the
    // spawned Claude CLI.
    env: turnEnv,
    permissionMode: "default",
    canUseTool: permissionStrategy === "gated" ? gatedCanUseTool : autoModeLogger,
    // PreToolUse fires on EVERY tool call BEFORE the SDK's permission
    // pipeline. canUseTool only gets called for tools the SDK considers
    // gate-worthy (Edit / Write / Bash) — Read / Grep / Glob auto-allow
    // without consulting it. The design hooks need to gate the read /
    // search side too (graphify-first), so they live here as PreToolUse.
    hooks: {
      PreToolUse: [{ hooks: [designPreToolUseHook] }],
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: appendSystemPrompt,
    },
    mcpServers: {
      "marvin-graph": graphMcp,
    },
    // ADR-0014: register the read-only `scout` subagent so MARVIN can
    // dispatch parallel research (graph-first, read-only, synthesis-
    // returning) via `Task` with `subagent_type: "scout"`. The advisor
    // carve-out (ADR-0007) continues to use `subagent_type: "general-
    // purpose"` with an Opus hint; scout and advisor do not overlap.
    agents: {
      scout: SCOUT_AGENT,
    },
    includePartialMessages: false,
    // Thinking mode → SDK effort. The user-facing modes (fast /
    // thinking / max) map to a subset of the SDK's 5-level effort
    // ladder; `max` falls back to `high` on non-Opus executors per
    // `effortForThinkingMode`. Defaults to `"thinking"` (= effort
    // "high") which matches the SDK default and MARVIN's prior
    // behaviour, so existing sessions keep their current responsiveness.
    effort: effortForThinkingMode(input.thinkingMode ?? "thinking", model),
    ...(advisorModel ? { advisorModel } : {}),
    ...(sessionId ? { resume: sessionId } : {}),
  } as Options;

  let lastSessionId: string | undefined = sessionId;
  let durationMs: number | undefined;
  let costUsd: number | undefined;
  let tokenUsage: RunAgentResult["tokenUsage"];
  let permissionDenials = 0;
  let resultError: string | undefined;
  // True once a non-error `result` envelope has been observed. Drives
  // the watchdog: if the SDK iterator hasn't terminated within
  // WATCHDOG_MS of seeing `result`, we force-abort the subprocess
  // and treat the resulting AbortError as a clean exit (the turn
  // already succeeded — we just couldn't get the SDK process to
  // close its stdio). Observed in v0.2.113 when stdio MCP children
  // (e.g. Playwright) hold the parent open after `result`.
  let seenSuccessfulResult = false;
  let watchdogTimer: NodeJS.Timeout | null = null;
  // Watchdog window. Tunable via env in case a future SDK version
  // needs longer post-`result` cleanup; the default is generous
  // enough that any honest cleanup completes naturally.
  const WATCHDOG_MS = (() => {
    const raw = process.env.MARVIN_RESULT_WATCHDOG_MS;
    if (!raw) return 5_000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 5_000;
  })();

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
          // Some SDK builds populate `result` with the upstream
          // failure body for error subtypes; capture it so
          // `friendlyError` can match the pattern. Fall back to the
          // subtype label when nothing better is available.
          const detail =
            "result" in ev && typeof ev.result === "string" && ev.result.length > 0
              ? ev.result
              : ev.subtype;
          resultError = detail;
        } else {
          // Successful result. Arm the watchdog: if the iterator
          // doesn't terminate naturally within WATCHDOG_MS, force-
          // close the subprocess. The for-await loop will then
          // throw, but the catch block treats the abort as benign
          // (we already captured the result + token usage above).
          seenSuccessfulResult = true;
          if (watchdogTimer) clearTimeout(watchdogTimer);
          watchdogTimer = setTimeout(() => {
            try {
              abortController.abort();
            } catch {
              /* nothing meaningful to do — subprocess is wedged */
            }
          }, WATCHDOG_MS);
        }
      }
    }
  } catch (err) {
    // If the watchdog fired after a successful `result`, the SDK
    // throws an AbortError as the iterator unwinds. That's the
    // benign case we built the watchdog FOR — the turn already
    // succeeded; we just couldn't get the subprocess to close
    // cleanly. Swallow it so the caller sees ok:true.
    if (seenSuccessfulResult) {
      // Optional: leave a breadcrumb so this is visible in logs
      // when it does kick in. No telemetry library here yet — the
      // structured `[marvin.telemetry]` line keeps with the rest.
      try {
        console.info(
          "[marvin.telemetry] " +
            JSON.stringify({
              kind: "runagent.watchdog",
              turnId,
              note: "subprocess did not exit within WATCHDOG_MS of result; force-aborted",
              at: new Date().toISOString(),
            }),
        );
      } catch {
        /* never break the turn on serialisation */
      }
    } else {
      resultError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    // Any lingering confirm requests are auto-denied so the SDK unwinds.
    clearTurnConfirms(turnId);
    clearTurnDesignContext(turnId);
  }

  if (resultError) {
    return {
      ok: false,
      error: friendlyError(resultError),
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
