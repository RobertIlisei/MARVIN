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
import { projectSkillsPluginConfig } from "./project-skills-plugin";
import { createWakeupMcpServer } from "./wakeup-tools";
import { recordPreImage } from "./change-checkpoints";
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
import { latestForTier } from "./models";
import { defaultModel } from "./claude-cli";

export type RuntimeMode = "opus" | "advisor";

/** Map a user-facing runtime mode to the SDK's model + advisorModel pair.
 *
 *  - `opus`: the newest live Opus everywhere — the default, highest quality.
 *  - `advisor`: the newest live Sonnet drives the turn loop (cheap, fast),
 *    the newest live Opus is registered as `advisorModel` so the executor
 *    can call it through the server-side advisor tool on hard steps. Per
 *    Anthropic's launch data (advisor_20260301), this saves ~30-40% on
 *    routine code work with minimal quality loss.
 *
 *  Tier-resolved via `latestForTier` (ADR-0029) so a newly-shipped model
 *  (e.g. Opus 4.8) becomes the default automatically — no hardcoded
 *  version id to bump. Falls back to `defaultModel()` (env / last-known-
 *  good) when discovery is unavailable. Async because tier resolution
 *  goes through the live-model TTL cache.
 */
export async function resolveRuntimeMode(mode: RuntimeMode): Promise<{
  model: string;
  advisorModel?: string;
}> {
  if (mode === "advisor") {
    const [sonnet, opus] = await Promise.all([
      latestForTier("sonnet"),
      latestForTier("opus"),
    ]);
    return {
      model: sonnet ?? defaultModel(),
      advisorModel: opus ?? undefined,
    };
  }
  const opus = await latestForTier("opus");
  return { model: opus ?? defaultModel() };
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
 * Autonomy mode for a turn (ADR-0036) — orthogonal to {@link PermissionStrategy}.
 * Mode = what MARVIN may *do*; strategy = how its edits get *confirmed*.
 *
 *   - `ask`   — read-only. Any mutating tool (Edit / Write / NotebookEdit /
 *               mutating Bash) is hard-denied at the gate; reads / grep /
 *               graph still work. Like Cursor's Ask.
 *   - `agent` — full autonomy (the default; pre-ADR-0036 behaviour). The
 *               `auto`/`gated` strategy governs confirmation.
 *   - `plan`  — the SDK's native `permissionMode: "plan"`: MARVIN drafts a
 *               plan + to-do list, makes no edits, and surfaces an approval
 *               step (ExitPlanMode) before executing.
 */
export type AgentMode = "ask" | "agent" | "plan";

/**
 * The SDK's reasoning-effort ladder, surfaced directly in MARVIN's
 * picker (UX parity with Claude Desktop / Claude Code, which let you
 * pick the level rather than a coarse alias):
 *
 *   - `low`    — minimal extended thinking, fastest responses.
 *   - `medium` — moderate thinking.
 *   - `high`   — deep reasoning (the SDK default, MARVIN's baseline).
 *   - `xhigh`  — deeper than high. Opus-only; this is the rung that
 *                enables Claude's dynamic-workflow ("ultracode")
 *                behaviour — the model may spin up parallel subagents
 *                for large audits/migrations. Falls back to `high` on
 *                non-Opus executors.
 *   - `max`    — maximum effort, longest budget. Opus-only; falls back
 *                to `high` on non-Opus executors.
 *
 * The advisor model (server-side subagent on hard decisions) is left
 * at the SDK default — its job is the hard call, which it thinks
 * through regardless of the executor's effort.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Legacy 3-mode picker values, accepted for backward compatibility
 *  (persisted prefs, old transcripts). Mapped onto the effort ladder. */
const LEGACY_EFFORT_ALIAS: Record<string, ReasoningEffort> = {
  fast: "low",
  thinking: "high",
  // "max" is already a valid ladder rung — passes through.
};

const EFFORT_LEVELS: readonly ReasoningEffort[] = [
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
 * @deprecated Use {@link resolveEffort}. Kept as a thin alias so any
 * older import keeps compiling; the picker now sends ladder values
 * directly. Returns the resolved SDK effort for a legacy 3-mode value.
 */
export type ThinkingMode = "fast" | "thinking" | "max";
export function effortForThinkingMode(
  mode: ThinkingMode,
  model: string,
): ReasoningEffort {
  return resolveEffort(mode, model);
}

export interface RunAgentInput {
  message: string;
  cwd: string;
  model: string;
  /**
   * Optional advisor model. Carried by the registered `advisor` agent
   * definition (ADR-0033) — the SDK `advisorModel` Option is typed but
   * NOT forwarded by sdk.mjs 0.2.113, so the agents-map registration is
   * the wiring that actually works. Still passed as an Option for
   * forward-compat with SDK versions that wire it.
   */
  advisorModel?: string | undefined;
  /**
   * Reasoning effort for the ADVISOR subagent, independent of the
   * executor's `thinkingMode` (ADR-0033). Same ladder values. Defaults
   * to the executor's effort when omitted — preserving the old
   * single-effort behaviour.
   */
  advisorThinkingMode?: string | undefined;
  /** Unique ID for this turn — used to key the confirm registry. */
  turnId: string;
  /** Resume a previous SDK session by ID (omit for a new one). */
  sessionId?: string | undefined;
  /** Permission strategy. Defaults to `auto` when omitted. */
  permissionStrategy?: PermissionStrategy;
  /** Autonomy mode (ADR-0036). Defaults to `agent` when omitted —
   *  preserving pre-0.1.22 behaviour. `ask` makes the turn read-only at
   *  the gate; `plan` runs under the SDK's plan permissionMode. */
  mode?: AgentMode;
  /**
   * User-facing reasoning-effort selection. A {@link ReasoningEffort}
   * ladder value (`low`/`medium`/`high`/`xhigh`/`max`) or a legacy
   * `fast`/`thinking`/`max` alias. Resolved to the SDK `effort` field
   * via {@link resolveEffort} (Opus-only fallback for the top rungs).
   * Defaults to `high` when omitted. Field name kept as `thinkingMode`
   * for wire/transcript/pref backward compatibility.
   */
  thinkingMode?: string;
  appendSystemPrompt: string;
  /**
   * Session + config identity the `marvin-control` wakeup tools (ADR-0031)
   * capture so a self-scheduled turn can resume THIS session under the same
   * posture. Optional so non-chat callers (tests, scout) can omit them — the
   * wakeup server is only wired when `marvinSessionId` + `projectId` are
   * present.
   */
  marvinSessionId?: string;
  projectId?: string;
  personality?: "marvin" | "neutral";
  /** Depth of this turn in a wakeup chain (0 = human-started). ADR-0031. */
  wakeupDepth?: number;
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
  // No writes (Edit/Write/Bash/NotebookEdit) by SDK-level contract.
  // WebFetch is also blocked: a scout's job is reading the project's
  // own code + the graph, not the public web. Audit 🟠 #10 flagged
  // WebFetch as a potential exfil channel — a prompt-injection in
  // source code MARVIN reads could ask the scout to GET an
  // attacker-controlled URL with a request body shaped by the
  // scout's parent env. If the scout needs web context for a brief,
  // it escalates to the parent MARVIN session which can confirm.
  disallowedTools: ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch"],
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
 * Build the registered `advisor` agent definition (ADR-0033).
 *
 * Why a registered agent instead of the old `general-purpose` + model-hint
 * pattern (ADR-0007): the Task tool input has NO effort field, so per-advisor
 * reasoning effort can only be set on an `agents:`-map definition — the SDK's
 * `AgentDefinition.effort` is the one mechanical lever. Registering also
 * fixes the advisor model wiring: the SDK `advisorModel` Option is typed but
 * not forwarded by sdk.mjs 0.2.113, whereas `AgentDefinition.model` accepts a
 * full model id and works.
 *
 * Read-only like the scout (Golden Rule 1 / ADR-0030): the subagent gate in
 * `classifyToolCall` already hard-denies mutations from any agentID, and
 * `disallowedTools` is the SDK-level backstop. The advisor reasons about a
 * plan; it does not touch the workspace.
 */
export function buildAdvisorAgent(args: {
  /** Full model id for the advisor; falls back to inheriting the executor. */
  model?: string | undefined;
  /** Resolved SDK effort for the advisor. */
  effort: ReasoningEffort;
}): AgentDefinition {
  return {
    description:
      "Second-opinion advisor. Spawn for a blunt critique of a plan, " +
      "ADR, or hard decision — risks missed, alternatives, pushback, " +
      "verdict. Read-only; returns advice, never edits.",
    disallowedTools: ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch"],
    mcpServers: ["marvin-graph"],
    model: args.model ?? "inherit",
    effort: args.effort,
    prompt: [
      "You are an advisor consulted by MARVIN's executor for a second",
      "opinion. You are not MARVIN; the user does not see you directly.",
      "Be blunt — agreement theater helps no one. Structure your reply:",
      "",
      "## Risks the plan misses",
      "## Alternatives worth considering",
      "## Pushback on the weakest points",
      "## Verdict (go / go-with-caveats / reject — one paragraph)",
      "",
      "Ground claims in the provided context; consult the marvin-graph",
      "MCP tools or read files when the question is structural. Return",
      "the critique and nothing else.",
    ].join("\n"),
  };
}

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
  opts?: {
    /** The SDK's `agentID` for this call. Present iff the tool call
     *  originates inside a sub-agent (scout, advisor, or a dynamic-
     *  workflow child). See ADR-0030. */
    agentID?: string;
    /** Ask mode (ADR-0036) — the whole turn is read-only. Collapses the
     *  ladder exactly like the subagent invariant: auto-class allows,
     *  anything that would confirm or deny is hard-denied. */
    readOnly?: boolean;
  },
): { decision: "allow" | "confirm" | "deny"; reason: string } {
  // Tools outside our named set (Task, NotebookEdit, MCP, etc.) are
  // auto-allowed by default — they're sandboxed or delegate back to tools
  // we already gate.
  if (!KNOWN_TOOL_NAMES.has(name as ToolName)) {
    return { decision: "allow", reason: `${name} is not in the gated set.` };
  }
  const policy = toolPolicy(name as ToolName, input);
  const baseDecision: "allow" | "confirm" | "deny" =
    policy.class === "auto" ? "allow" : policy.class === "deny" ? "deny" : "confirm";

  // SUBAGENT READ-ONLY INVARIANT (ADR-0030, Golden Rule 1).
  // No MARVIN subagent — scout, advisor, or dynamic-workflow child —
  // may mutate the workspace. Scouts are already write-denied via
  // `disallowedTools`, but dynamic-workflow children are spawned by the
  // Claude binary with no MARVIN-controlled agent definition, so the
  // ONLY tool-layer control over them is this gate. The SDK passes
  // `agentID` precisely so the parent permission handler can govern
  // sub-agent calls. For any sub-agent call we collapse the ladder:
  // read-only / whitelisted tools (auto-class) stay allowed; everything
  // that would otherwise confirm OR deny (Write / Edit / NotebookEdit /
  // unsafe or destructive Bash) is hard-denied. There is no per-subagent
  // confirm UI, and "confirm" must never silently become "allow" here.
  if (opts?.agentID && baseDecision !== "allow") {
    return {
      decision: "deny",
      reason:
        `Sub-agent (${opts.agentID}) attempted a workspace-mutating tool ` +
        `(${name}). MARVIN sub-agents are read-only — Golden Rule 1 / ADR-0030. ` +
        `Mutations belong to the single main loop.`,
    };
  }

  // ASK MODE READ-ONLY INVARIANT (ADR-0036). The same collapse as the
  // subagent invariant, applied to the whole turn: read-only / whitelisted
  // tools stay allowed; anything that would confirm OR deny is hard-denied.
  // The honest enforcement point for "Ask is read-only" — not a prompt.
  if (opts?.readOnly && baseDecision !== "allow") {
    return {
      decision: "deny",
      reason:
        `Ask mode is read-only — ${name} would change the workspace. ` +
        `Switch to Agent or Plan mode to make edits (ADR-0036).`,
    };
  }

  if (baseDecision === "allow") return { decision: "allow", reason: policy.reason };
  if (baseDecision === "deny") return { decision: "deny", reason: policy.reason };
  return { decision: "confirm", reason: policy.reason };
}

/** Mode-specific system-prompt stanza (ADR-0036). Empty for `agent` so
 *  the default posture is unchanged. The gate / permissionMode do the
 *  actual enforcement; this just sets expectations so the model behaves
 *  coherently (e.g. proposes edits as suggestions in Ask instead of trying
 *  them and getting denied). */
function modeGuidance(mode: AgentMode): string {
  if (mode === "ask") {
    return (
      "\n\n## Mode: ASK (read-only)\n" +
      "You are in Ask mode. The permission gate hard-denies every " +
      "workspace-mutating tool (Edit / Write / NotebookEdit / mutating " +
      "Bash) for this entire turn — do not attempt them. Read, search, " +
      "query the graph, and explain. When the user wants a change, " +
      "describe exactly what you'd do and tell them to switch to Agent or " +
      "Plan mode; do not try to edit."
    );
  }
  if (mode === "plan") {
    return (
      "\n\n## Mode: PLAN (read-only — produce a plan, then STOP)\n" +
      "You are in Plan mode. This turn is READ-ONLY: the gate hard-denies " +
      "every edit/mutation, so do not attempt them. Investigate (read, grep, " +
      "graph), then present ONE clear, ordered, **numbered** plan as your " +
      "reply — and STOP.\n" +
      "Hard rules:\n" +
      "- The plan MUST be your final message, and that message MUST start " +
      "with the exact line `# Plan — <short title>` (a level-1 Markdown " +
      "heading). The native UI detects that heading to render the plan as a " +
      "structured plan card; without it the plan shows as plain prose. Put " +
      "any preamble/findings in earlier messages, not above the heading.\n" +
      "- Do NOT call ExitPlanMode. Do NOT start executing. Do NOT call " +
      "`TodoWrite` yet. Just present the numbered plan and end the turn.\n" +
      "- The user reviews the plan in the chat and clicks Approve, which " +
      "starts a SEPARATE execution turn (Agent mode, the executor model). " +
      "That turn — not this one — does the work and tracks a `TodoWrite` " +
      "checklist of your plan's steps.\n" +
      "- If the user asks you to revise, produce the new numbered plan and " +
      "STOP again. Never silently keep planning in a loop."
    );
  }
  return "";
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
 * Snapshot the pre-image of a file an agent write tool is about to touch
 * (ADR-0034 change review). Fires for main-loop Edit / Write /
 * NotebookEdit only — subagent mutations are hard-denied anyway, and a
 * snapshot for a call that ends up denied is harmless (baseline == disk,
 * GC'd on the next read). Best-effort: checkpointing must never block or
 * fail a write.
 */
function maybeRecordPreImage(args: {
  checkpoint: { projectId: string; marvinSessionId: string } | undefined;
  cwd: string;
  turnId: string;
  toolName: string;
  input: Record<string, unknown>;
  agentID: string | undefined;
}): void {
  if (!args.checkpoint || args.agentID) return;
  if (!["Edit", "Write", "NotebookEdit"].includes(args.toolName)) return;
  const raw =
    args.toolName === "NotebookEdit" ? args.input.notebook_path : args.input.file_path;
  if (typeof raw !== "string" || !raw) return;
  try {
    recordPreImage({
      key: {
        projectId: args.checkpoint.projectId,
        marvinSessionId: args.checkpoint.marvinSessionId,
      },
      cwd: args.cwd,
      turnId: args.turnId,
      absPath: raw,
    });
  } catch {
    /* never block the write on checkpoint bookkeeping */
  }
}

/**
 * Plan-mode approval (ADR-0036). In `plan` mode the model finishes by
 * calling `ExitPlanMode` to signal "ready to execute"; the SDK consults
 * `canUseTool` for it. We route that through MARVIN's existing confirm
 * pipeline so it becomes a user-facing approval — ALLOW = approve the plan
 * and start executing (the SDK exits plan mode), DENY = keep planning. This
 * is what makes Plan mode "wait for my approval" regardless of the auto/
 * gated strategy. Returns null when this isn't the ExitPlanMode-in-plan
 * case so callers fall through to normal classification.
 */
const EXIT_PLAN_TOOL = "ExitPlanMode";
function maybePlanApproval(_args: {
  mode: AgentMode | undefined;
  toolName: string;
  turnId: string;
  toolUseID: string;
  input: Record<string, unknown>;
  onConfirmRequest?: (request: ConfirmRequestPayload) => void;
}): Promise<PermissionResult> | null {
  // ADR-0036 (revised): Plan mode is now a read-only planning turn that
  // presents the plan inline and stops — there is no modal ExitPlanMode
  // approval and no plan→execute coupling. Disabled (kept as a no-op so the
  // call sites stay stable). Approval is now an inline "Approve & execute"
  // action in the chat that starts a fresh Agent-mode turn.
  return null;
}

/**
 * Interactive AskUserQuestion (ADR-0040). The model's built-in
 * `AskUserQuestion` tool arrives here through `canUseTool`; the answer is
 * returned to the model as `{ behavior: "allow", updatedInput }` where
 * `updatedInput` is the AskUserQuestionOutput the SDK hands back as the tool
 * result. Unlike a normal tool, it can NEVER be auto-answered — there's no
 * sensible default for "which option does the user want" — so we route it
 * through the same confirm registry as gated confirms in EVERY mode (auto /
 * gated / plan / ask). The native UI renders the options and POSTs
 * `/api/confirm` with `{ decision: "allow", updatedInput: { questions, answers } }`.
 *
 * Returns null when this isn't AskUserQuestion (callers fall through to normal
 * classification). When there's no UI wired to answer (e.g. a headless wakeup
 * turn), denies rather than hanging — the 5-min confirm timeout would do the
 * same, but failing fast is clearer to the model.
 */
const ASK_USER_TOOL = "AskUserQuestion";
function maybeAskUserQuestion(args: {
  toolName: string;
  turnId: string;
  toolUseID: string;
  input: Record<string, unknown>;
  onConfirmRequest?: (request: ConfirmRequestPayload) => void;
}): Promise<PermissionResult> | null {
  const { toolName, turnId, toolUseID, input, onConfirmRequest } = args;
  if (toolName !== ASK_USER_TOOL) return null;
  if (!onConfirmRequest) {
    return Promise.resolve({
      behavior: "deny",
      message: "AskUserQuestion can't be answered here (no interactive UI). Proceed with your own recommendation instead.",
      interrupt: false,
    } as PermissionResult);
  }
  return new Promise<PermissionResult>((resolve) => {
    registerPendingConfirm(turnId, toolUseID, resolve, input);
    onConfirmRequest({
      turnId,
      toolUseId: toolUseID,
      toolName: ASK_USER_TOOL,
      input,
      reason: "MARVIN needs you to choose.",
    });
  });
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
  /** Per-session change-review checkpointing (ADR-0034); omit to disable. */
  checkpoint?: { projectId: string; marvinSessionId: string };
  /** Ask mode (ADR-0036) — make the turn read-only at the gate. */
  readOnly?: boolean;
  /** Autonomy mode (ADR-0036) — drives plan-approval routing. */
  mode?: AgentMode;
  /** Needed for the plan-approval confirm even in auto strategy. */
  onConfirmRequest?: (request: ConfirmRequestPayload) => void;
}): CanUseTool {
  const { cwd, turnId, checkpoint, readOnly, mode, onConfirmRequest } = args;
  return async (toolName, toolInput, { toolUseID, agentID }) => {
    const safeInput = normaliseInput(toolInput);
    // Plan approval gate first — even in auto strategy, ExitPlanMode waits
    // for the user (ADR-0036).
    const planApproval = maybePlanApproval({ mode, toolName, turnId, toolUseID, input: safeInput, onConfirmRequest });
    if (planApproval) return planApproval;
    // AskUserQuestion always reaches the user, even in auto mode (ADR-0040).
    const ask = maybeAskUserQuestion({ toolName, turnId, toolUseID, input: safeInput, onConfirmRequest });
    if (ask) return ask;
    const cls = classifyToolCall(toolName, toolInput as Record<string, unknown>, { agentID, readOnly });
    if (cls.decision !== "deny") {
      maybeRecordPreImage({ checkpoint, cwd, turnId, toolName, input: safeInput, agentID });
    }
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
  /** Per-session change-review checkpointing (ADR-0034); omit to disable. */
  checkpoint?: { projectId: string; marvinSessionId: string };
  /** Ask mode (ADR-0036) — make the turn read-only at the gate. */
  readOnly?: boolean;
  /** Autonomy mode (ADR-0036) — drives plan-approval routing. */
  mode?: AgentMode;
}): CanUseTool {
  const { cwd, turnId, onConfirmRequest, checkpoint, readOnly, mode } = args;
  return async (toolName, toolInput, { toolUseID, title, description, displayName, agentID }) => {
    const safeInput = normaliseInput(toolInput);
    // Plan approval gate first (ADR-0036).
    const planApproval = maybePlanApproval({ mode, toolName, turnId, toolUseID, input: safeInput, onConfirmRequest });
    if (planApproval) return planApproval;
    // AskUserQuestion routes to the same confirm channel (ADR-0040).
    const ask = maybeAskUserQuestion({ toolName, turnId, toolUseID, input: safeInput, onConfirmRequest });
    if (ask) return ask;
    const cls = classifyToolCall(toolName, toolInput as Record<string, unknown>, { agentID, readOnly });
    if (cls.decision !== "deny") {
      // Pre-image BEFORE the confirm round-trip too: if the user allows,
      // the write executes inside the SDK with no further hook here.
      maybeRecordPreImage({ checkpoint, cwd, turnId, toolName, input: safeInput, agentID });
    }

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
  // Change-review checkpointing (ADR-0034) needs the session identity to
  // scope the store; absent (tests, ad-hoc callers) it simply disables.
  const checkpoint =
    input.marvinSessionId && input.projectId
      ? { projectId: input.projectId, marvinSessionId: input.marvinSessionId }
      : undefined;
  // ADR-0036 autonomy mode (revised). BOTH `ask` and `plan` are read-only
  // at the gate — Plan is now a read-only *planning* turn that produces the
  // plan inline and stops; execution is a SEPARATE Agent-mode turn (on the
  // executor model) the user starts by approving. This decouples plan from
  // execute so they can use different models, and removes the modal +
  // re-planning that the SDK's coupled plan permissionMode caused.
  const mode: AgentMode = input.mode ?? "agent";
  const readOnly = mode === "ask" || mode === "plan";
  const gatedCanUseTool = makeGatedCanUseTool({ cwd, turnId, onConfirmRequest, readOnly, mode, ...(checkpoint ? { checkpoint } : {}) });
  const autoModeLogger = makeAutoModeLogger({ cwd, turnId, readOnly, mode, onConfirmRequest, ...(checkpoint ? { checkpoint } : {}) });

  // In-process MCP server exposing graphify graph tools to MARVIN. Built
  // per-turn so the server is scoped to the current workDir. Safe to always
  // include: if the project has no `graphify-out/`, the tools politely report
  // that instead of failing the turn.
  const graphMcp = createGraphMcpServer(cwd);

  // In-process MCP server exposing the self-wakeup tools (ADR-0031). Only
  // wired when we know which session to resume — a wakeup turn must be able
  // to re-enter THIS marvinSession. Captures the turn's config so the fired
  // turn inherits the same model / permission posture (no elevation).
  const wakeupMcp =
    input.marvinSessionId && input.projectId
      ? createWakeupMcpServer({
          marvinSessionId: input.marvinSessionId,
          projectId: input.projectId,
          cwd,
          model,
          advisorModel: advisorModel ?? null,
          personality: input.personality ?? "marvin",
          permissionStrategy,
          thinkingMode: input.thinkingMode ?? "high",
          advisorThinkingMode: input.advisorThinkingMode,
          depth: input.wakeupDepth ?? 0,
        })
      : null;

  // Project-local skills plugin (ADR-0024). When the project has
  // committed any `<workDir>/.marvin/skills/<name>/SKILL.md` files, we
  // synthesize a minimal plugin manifest at `<workDir>/.marvin/.claude-plugin/plugin.json`
  // (idempotent — never overwrites a customised one) and pass the
  // plugin spec to the SDK so the project-local skills become callable
  // from this session. No skills committed → `null` returned, the
  // option is omitted, the SDK runs with user-global skills only.
  const projectSkillsPlugin = projectSkillsPluginConfig(cwd);

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
    // ADR-0036 (revised): all modes use `default`. Plan + Ask read-only
    // enforcement lives in the gate (`readOnly`) below — Plan is no longer
    // the SDK's coupled plan permissionMode.
    permissionMode: "default",
    canUseTool: permissionStrategy === "gated" ? gatedCanUseTool : autoModeLogger,
    // ADR-0036: SDK-level backstop for Ask read-only — the gate already
    // hard-denies these, this is the belt-and-braces (same shape as the
    // scout). Bash is NOT disallowed: read-only shell (ls/grep/cat) stays
    // available; the gate denies only *mutating* Bash.
    ...(readOnly ? { disallowedTools: ["Edit", "Write", "NotebookEdit"] } : {}),
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
      append: appendSystemPrompt + modeGuidance(mode),
    },
    mcpServers: {
      "marvin-graph": graphMcp,
      ...(wakeupMcp ? { "marvin-control": wakeupMcp } : {}),
    },
    // Project-local skills (ADR-0024). When `<workDir>/.marvin/skills/`
    // contains at least one SKILL.md, the SDK loads the synthesised
    // plugin and the project's skills become callable from this turn.
    // Project-local skill names SHADOW user-global ones on conflict —
    // mirrors the per-project MCP override precedence rule.
    ...(projectSkillsPlugin ? { plugins: [projectSkillsPlugin] } : {}),
    // ADR-0014: register the read-only `scout` subagent so MARVIN can
    // dispatch parallel research (graph-first, read-only, synthesis-
    // returning) via `Task` with `subagent_type: "scout"`.
    // ADR-0033: register the `advisor` agent so consults carry their OWN
    // model + reasoning effort — the Task input has no effort field, so
    // the agents-map definition is the only mechanical lever for
    // per-advisor effort. Replaces the ADR-0007 `general-purpose` +
    // model-hint spawn (still policy-sanctioned for back-compat).
    agents: {
      scout: SCOUT_AGENT,
      advisor: buildAdvisorAgent({
        model: advisorModel,
        // Default the advisor to the EXECUTOR's effort when no separate
        // advisor effort was picked — exactly the pre-ADR-0033 behaviour.
        effort: resolveEffort(
          input.advisorThinkingMode ?? input.thinkingMode,
          advisorModel ?? model,
        ),
      }),
    },
    includePartialMessages: false,
    // Reasoning-effort selection → SDK effort. Accepts the full ladder
    // (low/medium/high/xhigh/max) and legacy fast/thinking/max aliases;
    // `xhigh`/`max` fall back to `high` on non-Opus executors per
    // `resolveEffort`. Defaults to `high` (the SDK default), so existing
    // sessions keep their current responsiveness.
    effort: resolveEffort(input.thinkingMode, model),
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
