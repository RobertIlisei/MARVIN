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

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type AgentDefinition, type CanUseTool, type McpServerConfig, type Options, type PermissionResult, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createGraphMcpServer, searchGraph } from "@marvin/graphify-bridge";
import { buildOrientationQuery, formatOrientation } from "./graph-orientation";
import { makeTurnCloseStopHook } from "./turn-close-hook";
import { isSubagentDispatch, KNOWN_TOOL_NAMES, looksLikeSubagentDispatch, mcpToolPolicy, PLAYWRIGHT_SERVER_KEY, type ToolName, toolPolicy } from "@marvin/tools/policy";
import { classifySharedTreeRisk, describeSharedTreeRisk } from "@marvin/tools/shared-tree";
import { makeAdvisorVerdictPostToolUse } from "./advisor-verdict";
import { buildSubprocessEnv } from "./auth";
import {
  type AutoAuditEntryKind,
  appendAutoAuditEntry,
} from "./auto-audit";
import { BackgroundTaskLedger, backgroundTasksPayload, taskNotificationPayload } from "./background-tasks";
import { createBacklogMcpServer } from "./backlog-mcp";
import { recordPreImage } from "./change-checkpoints";
import {
  buildCheckBackWakeup,
  detectUncoveredCheckBack,
  isCheckBackCovered,
} from "./checkback-guard";
import { defaultModel, discoverClaudeBinary } from "./claude-cli";
import {
  clearTurnConfirms,
  registerPendingConfirm,
} from "./confirm-registry";
import { rateLimitPayload, recordClaudeRateLimit } from "./cost-tracker";
import {
  ADVISOR_SUBAGENT_TYPE,
  clearTurnDesignContext,
  createTurnDesignContext,
  type DesignTurnContext,
  logDesignTurnSummary,
  makeDesignHooksPreToolUse,
  recordAllowedTool,
} from "./design-hooks";
import { computeHoneycombTelemetryEnv } from "./honeycomb-telemetry";
import { createMemoryMcpServer } from "./memory-mcp";
import { ensureProviderModelId, latestForTier } from "./models";
import { createObsidianMcpServer } from "./obsidian-mcp";
import { makeOutputGovernorPostToolUse } from "./output-governor";
import { readPlanState } from "./plan-state";
import { loadEnabledPlugins } from "./plugin-loader";
import { projectSkillsPluginConfig } from "./project-skills-plugin";
import { saveSlashCommands } from "./slash-commands";
import { clearSubagentsForTurn, IMPLEMENTER_TYPE, lookupSubagent, registerSubagent, type SubagentBinding, taskStartedPayload } from "./subagent-registry";
import { TurnInputChannel } from "./turn-input";
import { listLiveTurns, markTurnMutated } from "./turn-registry";
import { scheduleWakeup } from "./wakeup-scheduler";
import { createWakeupMcpServer, type WakeupToolContext } from "./wakeup-tools";
import {
  buildReconcilePrompt,
  hasScopeMet,
  hasWorkflowGap,
  openPlanSteps,
  openTodos,
  scopeOfDoneEntirelyUnticked,
  type WorkflowGap,
} from "./workflow-guard";
import { bindWorktreeTask, implementerWorktreePolicy, listWorktrees, markWorktreeFinished, sweepWorktrees, type WorktreeState } from "./worktrees";

export type RuntimeMode = "opus" | "advisor";

/**
 * GUI-launch PATH fix (ADR-0045 follow-up). A macOS app launched from Finder /
 * Spotlight inherits the minimal launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * which OMITS Homebrew (`/opt/homebrew/bin`) and `/usr/local/bin` where the
 * user's `node` / `npx` actually live. The SDK spawns the Playwright MCP server
 * via bare `npx @playwright/mcp@latest`, so under that PATH it ENOENTs, the
 * stdio server never starts, and the `mcp__playwright__browser_*` tools never
 * register — MARVIN genuinely can't see them. (A `Bash` `npx` works because it
 * runs through a login shell that sources the user's profile.) Prepend the
 * running node's own bin dir + the common Homebrew / `/usr/local` locations so
 * `npx` (and the `node` it re-spawns) resolve regardless of how MARVIN was
 * launched. Order-preserving + de-duplicated; existing PATH entries win ties
 * after the prepended ones.
 */
export function enrichedToolPath(base: string = process.env.PATH ?? ""): string {
  // ADR-0093 — the DIRECTORY of the resolved Claude CLI goes first.
  //
  // MARVIN never passes the binary to the SDK; the SDK resolves `claude` from
  // PATH itself. With `/opt/homebrew/bin` prepended, every turn spawned
  // Homebrew's 2.1.92 while `discoverClaudeBinary()` — and therefore the About
  // panel — reported the user's 2.1.251. ADR-0087 fixed the reporting and left
  // the spawn untouched, so the symptom (blank plan-usage bars: 2.1.92
  // predates `unifiedWindows`) survived that fix entirely.
  //
  // Resolution failures are non-fatal: PATH enrichment must not throw on a
  // machine with no CLI, or nothing runs at all.
  let claudeDir: string[] = [];
  try {
    claudeDir = [dirname(discoverClaudeBinary())];
  } catch {
    claudeDir = [];
  }
  const prepend = [...claudeDir, dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...prepend, ...base.split(":")]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out.join(":");
}

/** Sanitized copy of `process.env` (drops `undefined` values) with PATH
 *  enriched — suitable as a stdio MCP server's `env`. */
function browserServerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.PATH = enrichedToolPath();
  return env;
}

/** Map a user-facing runtime mode to the SDK's model + advisorModel pair.
 *
 *  - `opus`: the newest live Opus everywhere — the default, highest quality.
 *  - `advisor`: the newest live Sonnet drives the turn loop (cheap, fast),
 *    the newest live Opus is the `advisorModel` — wired as the registered
 *    `advisor` *subagent* (ADR-0033), MARVIN's Task-dispatched second opinion
 *    on hard steps. (The binary's *server-side* advisor tool would auto-escalate
 *    instead, but it's experimental + model-allowlisted and stays unwired — see
 *    ADR-0033 addendum.) Cheap Sonnet loop + Opus only on hard consults is the
 *    cost win.
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
      model: ensureProviderModelId(sonnet ?? defaultModel()) ?? defaultModel(),
      advisorModel: ensureProviderModelId(opus) ?? undefined,
    };
  }
  const opus = await latestForTier("opus");
  return { model: ensureProviderModelId(opus ?? defaultModel()) ?? defaultModel() };
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
 *   - `plan`  — read-only planning turn (ADR-0036 revised). Runs under
 *               `permissionMode: "default"` + the `readOnly` gate (NOT the
 *               SDK's coupled plan permissionMode, which was retired): it
 *               investigates, presents the plan inline, and stops. Execution
 *               is a SEPARATE Agent-mode turn the user starts by approving.
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
// The effort ladder (`ReasoningEffort`, `resolveEffort`, `stepDownEffort`,
// `clampEffort`) lives in `./effort` — dependency-free so the wakeup
// scheduler and background-job runner can use it without importing this
// module (which imports them). Re-exported here so every existing import
// path keeps working.
export {
  clampEffort,
  EFFORT_LEVELS,
  type ReasoningEffort,
  resolveEffort,
  stepDownEffort,
} from "./effort";

import { type ReasoningEffort, resolveEffort } from "./effort";

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
  /**
   * ADR-0076 — streaming input. When present the SDK runs in streaming
   * input mode and further user messages pushed into the channel are
   * delivered into THIS turn instead of queueing behind it. The runner
   * closes the channel on a `result` with nothing pending, so a turn with
   * no extra input terminates exactly as single-message mode did.
   */
  inputChannel?: TurnInputChannel | undefined;
  /**
   * ADR-0051 — a compact snapshot of the ACTIVE plan + live per-step status,
   * sent by the client each turn so the model (not just the UI strip) stays
   * aware of where it is in the plan. Appended to the user turn wrapped in a
   * `<system-reminder>` — a VOLATILE SUFFIX on the latest message, never part
   * of the cached system prefix (prompt-cache-safe per Anthropic's caching
   * rules), and never persisted to the transcript (the clean `message` is what
   * `turn.user` records). Absent when no plan is active.
   */
  planContext?: string | undefined;
  cwd: string;
  model: string;
  /**
   * Optional advisor model. The ONE wired consumer is the registered
   * `advisor` *subagent* (the `agents` map, ADR-0033) — MARVIN's
   * Task-dispatched second opinion.
   *
   * It is NOT passed as `options.advisorModel`: that is a Claude Code
   * *settings* field, not a `query()` option, so `sdk.mjs` 0.2.113 drops it.
   * The binary's *server-side* advisor tool (`--advisor <model>`, the
   * auto-escalate-on-hard-steps mechanism behind runtime "advisor" mode) is
   * real but EXPERIMENTAL + model-allowlisted server-side (the current default
   * Opus is rejected), so it is deliberately not wired. See ADR-0033 addendum.
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
  /** Opt-in: register the gated Playwright MCP browser server for this turn
   *  (ADR-0045). Off by default — a browser subprocess is heavy. */
  playwrightEnabled?: boolean;
  /** Autonomy mode (ADR-0036). Defaults to `agent` when omitted —
   *  preserving pre-0.1.22 behaviour. Both `ask` and `plan` are read-only
   *  at the gate (see the `readOnly` wiring, L905/L967-969); `plan` adds the
   *  inline plan-then-stop contract. Neither uses the SDK plan permissionMode. */
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
  personality?: "marvin" | "neutral" | "ultron";
  /** Depth of this turn in a wakeup chain (0 = human-started). ADR-0031. */
  wakeupDepth?: number;
  onEvent: (event: SDKMessage) => void;
  onConfirmRequest: (request: ConfirmRequestPayload) => void;
  /**
   * An implementer subagent finished and its branch is now a deliverable
   * (ADR-0103). Fired from `task_notification`, so it is deterministic —
   * before this, "tell the user the branch is ready" was a line of prompt
   * text the model was free to forget, and did.
   */
  onWorktreeFinished?: (w: WorktreeFinished) => void;
  signal?: AbortSignal;
}

export interface WorktreeFinished {
  slug: string;
  branch: string;
  state: WorktreeState;
  commits: number;
  filesChanged: number;
  base: string;
  task: string;
  /** True when the branch was empty and has already been reclaimed. */
  reclaimed: boolean;
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
  // RUNAWAY RAIL (ADR-0079). A scout returns a synthesis; it does not
  // implement. Before this, nothing bounded one — a scout that kept finding
  // "one more thing to check" burned the parent turn's budget with no ceiling
  // and no signal to the user. 40 round-trips is far above what a real
  // breadth-first sweep of this repo takes and far below a runaway.
  maxTurns: 40,
  // ADR-0080 — run in the background, declared explicitly.
  //
  // When this was written the SDK default was FOREGROUND: the parent turn
  // blocked until the scout returned, which made MARVIN's one sanctioned form
  // of parallelism execute serially ("waiting for 1 agent to finish before
  // continuing kills our speed" — user, 2026-08-29). **That default flipped
  // in Claude Code v2.1.198** — an Agent call omitting `run_in_background`
  // now backgrounds — so the sentence this comment used to open with was
  // asserting the opposite of reality on the 2.1.251 CLI MARVIN runs.
  //
  // The field stays set regardless: it is what makes the behaviour
  // independent of the harness default rather than a bet on it, which is the
  // same lesson as ADR-0079. Verified live that background agents keep their
  // MCP tools, so graph-first still holds.
  background: true,
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
    "   citations do you Read those files. Text search is second-line —",
    "   used only when the graph doesn't cover what you need. NOTE: this",
    "   CLI has no `Grep`/`Glob` tool (removed upstream in 2.1.251, and",
    "   NOT recoverable via `ToolSearch`); search with `Bash` (`rg`), which",
    "   the graphify-first rail treats exactly like the old `Grep`.",
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
    "   spawning more subagents. No nested subagent dispatches.",
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
 * Build the registered `graph-extractor` agent (ADR-0058).
 *
 * The cheap, parallel vehicle for graphify's semantic pass. Two levers this
 * gives us over graphify's default `general-purpose` fan-out:
 *
 * 1. **Model** — pinned to the Haiku tier (resolved live via `latestForTier`).
 *    Chunk → nodes/edges extraction is mechanical; it doesn't need the
 *    executor's frontier model, and the per-call saving is large on a big
 *    corpus.
 * 2. **Scoped write** — the subagent gate (`classifyToolCall`) permits its
 *    file-writes ONLY under `graphify-out/`; every other mutation stays denied.
 *    `WebFetch` is disallowed at the SDK layer (exfil, same as the scout).
 *
 * Not a general-purpose worker — dispatch it for graph EXTRACTION only.
 */
export function buildGraphExtractorAgent(args: {
  /** Haiku-tier model id; `"inherit"` only if resolution somehow returns null. */
  model?: string | undefined;
}): AgentDefinition {
  return {
    description:
      "Cheap, parallel graph-extraction subagent (ADR-0058). Reads the assigned " +
      "files, extracts entities/relations, and writes chunk output UNDER " +
      "graphify-out/ — nowhere else. Dispatch for graphify's semantic pass so it " +
      "runs in parallel on a low-cost model. Not a general worker.",
    // WebFetch blocked (exfil, per the scout). Write stays available — the gate
    // scopes it to graphify-out/; a write elsewhere is hard-denied there.
    disallowedTools: ["WebFetch"],
    // Bounded by construction: read an assigned chunk, write one output file,
    // stop. A run that needs more than this has misunderstood its brief, and
    // the fan-out means the cost of a runaway is multiplied by the chunk count.
    maxTurns: 15,
    // ADR-0080 — the extraction fan-out is the textbook case for background
    // execution: N independent chunks, parent has nothing to wait for.
    background: true,
    model: args.model ?? "inherit",
    prompt: [
      "You are a MARVIN graph-extraction subagent (ADR-0058) — a cheap,",
      "read-mostly worker spawned to extract knowledge-graph structure from a",
      "bounded set of files. You are not MARVIN; the user does not see you.",
      "",
      "# Contract",
      "1. Read the files named in your brief; extract the entities and",
      "   relations exactly as the graphify instructions specify.",
      "2. Write your chunk/graph output ONLY under `graphify-out/`. Writes",
      "   anywhere else are hard-denied by the gate — do not attempt them.",
      "3. Do not edit source, run mutating shell, or fetch the web.",
      "4. Return a one-line summary of what you extracted (counts) and stop.",
    ].join("\n"),
  };
}

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
  /** Full model id for the advisor. Callers resolve the default to the latest
   *  Opus tier (see `advisorModelResolved` in `runAgent`); `"inherit"` only if
   *  an undefined model somehow reaches here. */
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
    // One critique, one answer — and this is the Opus-tier agent, so it is the
    // expensive one to leave unbounded (ADR-0079).
    maxTurns: 20,
    // Declared, not inherited. Claude Code v2.1.198 flipped the subagent
    // default to BACKGROUND, so leaving this unset gives the advisor exactly
    // the behaviour that broke it: a launch receipt instead of a verdict.
    // The docs only promise that `background: true` FORCES background, so
    // this field is a statement of intent — the enforcement that actually
    // holds is the gate's deny on any advisor dispatch that is not
    // explicitly `run_in_background: false` (ADR-0094 amendment).
    background: false,
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
      "",
      "Then END your reply with this block, verbatim in this shape. It is",
      "read by machine (ADR-0095): the executor parks each caveat as a",
      "backlog item so your advice survives a context compaction. Prose is",
      "for the human; this block is the contract. Emit it even for a clean",
      "`go` (with no caveats), and put EVERY condition you attached to a",
      "`go-with-caveats` in it — a caveat you mention only in prose is one",
      "that can be lost.",
      "",
      "```marvin-verdict",
      "verdict: go | go-with-caveats | reject",
      "caveats:",
      "- one line per caveat, imperative, self-contained",
      "```",
    ].join("\n"),
  };
}

/**
 * Build the registered `implementer` agent (ADR-0081).
 *
 * The ONE subagent allowed to write — and only inside a worktree MARVIN
 * created for it. It is a bounded builder: one task, one branch, commits its
 * work, reports. It never merges; the user does. Background, so the main
 * loop keeps going while it builds.
 *
 * Model inherits the executor's: implementation quality is the point, and
 * Anthropic's 2026-08 data shows collaborative coding only holds up on the
 * current model generation.
 */
export function buildImplementerAgent(): AgentDefinition {
  return {
    description:
      "Isolated implementer (ADR-0081). Builds ONE bounded task in a git " +
      "worktree MARVIN created for it — its own checkout, its own branch — " +
      "commits the work and reports. Never touches the main tree; never " +
      "merges. Dispatch only after `worktree_create`, with the worktree path " +
      "in the prompt.",
    disallowedTools: ["WebFetch", "NotebookEdit"],
    mcpServers: ["marvin-graph"],
    model: "inherit",
    background: true,
    maxTurns: 60,
    prompt: [
      "You are a MARVIN implementer subagent (ADR-0081) — a bounded builder",
      "working in an ISOLATED git worktree. You are not MARVIN; the user does",
      "not see you. Your brief names your worktree path. That path is your",
      "entire world.",
      "",
      "# Hard rules — enforced by the permission gate, not just asked",
      "1. Every file you read or edit: use the ABSOLUTE path under your",
      "   worktree. Relative paths resolve against the MAIN tree, which you",
      "   cannot write to, and reading from it shows you a stale checkout.",
      "2. Every shell command runs inside your worktree — the gate pins it",
      "   there. Do not `cd` elsewhere, do not use `..`, do not reference",
      "   paths outside your worktree.",
      "3. Commit on your branch when the task is done (`git add` + `git commit`",
      "   with a clear message). Do NOT push, merge, rebase, or switch branch.",
      "4. Stay in scope: the brief is the task. Noticed-but-out-of-scope",
      "   items go in your report, not in the diff.",
      "",
      "# Output shape",
      "Return: the BRANCH you committed on, what you built (files + commit",
      "hash), how you verified it (tests run and their result), and anything",
      "the reviewer must know. If you committed nothing, say so in the first",
      "line — an empty branch reported as work is worse than no branch.",
      "Concise prose; the parent integrates it.",
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
/** Bash operators/commands that mutate a file mentioned in the command.
 *  Shared by the app-owned-path denies below (plans ADR-0052, memory
 *  ADR-0042) so the two blocks can't drift. Read-only access (grep, cat,
 *  plain redirect-free commands) deliberately passes. */
const BASH_MUTATING_OPS = /(?:>>?|\btee\b|\bsed\s+-i\b|\brm\b|\bmv\b|\bcp\b|\btruncate\b)/;

/** True when `name`+`input` is a workspace mutation aimed at a path the
 *  app owns: Edit/Write/NotebookEdit whose target matches `pathMatches`,
 *  or a Bash command that mentions such a path alongside a mutating op. */
function mutatesProtectedPath(
  name: string,
  input: Record<string, unknown> | undefined,
  pathMatches: (path: string) => boolean,
): boolean {
  // Defensive: one auto-mode caller passes a runtime-undefined input
  // before its own `?? {}` normalisation — never dereference `input` raw.
  const inp: Record<string, unknown> = input ?? {};
  const target =
    typeof inp.file_path === "string"
      ? inp.file_path
      : typeof inp.notebook_path === "string"
        ? inp.notebook_path
        : "";
  return (
    ((name === "Edit" || name === "Write" || name === "NotebookEdit") &&
      target !== "" &&
      pathMatches(target)) ||
    (name === "Bash" &&
      typeof inp.command === "string" &&
      pathMatches(inp.command) &&
      BASH_MUTATING_OPS.test(inp.command))
  );
}

/**
 * Canonical graph artifacts a subagent may NEVER write, even inside the
 * ADR-0058 slit (addendum): the merged graphs every later query reads
 * (`graph.json` anywhere under graphify-out) and the curated Q&A memory
 * stores (`memory/`). Chunk/cache writes remain allowed — a prompt-injected
 * extractor can then only contribute chunk data that flows through the main
 * loop's deterministic merge (the same exposure serial extraction already
 * has), never overwrite the canonical query targets directly.
 */
const GRAPH_CANONICAL_WRITE_DENY =
  /(^|\/)graphify-out\/(?:.*\/)?(?:graph\.json$|memory\/)/;

/**
 * True when a call is a FILE WRITE (Write/Edit/NotebookEdit — deliberately NOT
 * Bash, which can't be path-scoped safely) whose target resolves under a
 * `graphify-out/` directory AND is not a canonical artifact. The narrow write
 * surface a graph-extraction subagent needs (ADR-0058): it emits chunk output
 * there and nowhere else. `graphify-out/` is a distinctive generated cache
 * name, matched the same relative way the plan/memory protected-path checks
 * are. Exported for tests.
 */
export function writesUnderGraphOut(
  name: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (name !== "Write" && name !== "Edit" && name !== "NotebookEdit") return false;
  const inp = input ?? {};
  const target =
    typeof inp.file_path === "string"
      ? inp.file_path
      : typeof inp.notebook_path === "string"
        ? inp.notebook_path
        : "";
  return (
    target !== "" &&
    /(^|\/)graphify-out\//.test(target) &&
    !GRAPH_CANONICAL_WRITE_DENY.test(target)
  );
}

/**
 * ADR-0058 addendum — make the Haiku saving UNCONDITIONAL, not a prose steer.
 *
 * graphify's stock skill hardcodes `subagent_type: "general-purpose"` for its
 * extraction fan-out, so the model saving originally depended on the
 * personality steer being followed (the ADR's own noted limit). The gate can
 * close that itself: `canUseTool` may return `updatedInput`, so when a
 * general-purpose Task is recognisably a graph-extraction dispatch we rewrite
 * it to `graph-extractor` at the gate — mechanical, works with the stock skill.
 *
 * The signature is deliberately conservative (both conditions required):
 *   1. the brief references a `graphify-out/` path (where extractors write
 *      their chunk output), AND
 *   2. it uses extraction vocabulary (extract/chunk/nodes/edges/semantic).
 * A general-purpose Task that merely *mentions* graphify-out (e.g. "analyse
 * the report in graphify-out/") lacks (2) and is left alone. A false positive
 * costs only the model tier — the rewritten agent keeps the same read access,
 * and the write scope is governed by the gate either way.
 *
 * Returns the rewritten input, or null to leave the dispatch untouched.
 * Exported for tests.
 */
/**
 * One line per gated subagent call (ADR-0081 observability). Before this,
 * a subagent deny reached the model as the SDK's generic "the user doesn't
 * want to take this action" and left no trace of WHICH rule fired or whether
 * the agent was even recognised — the exact blind spot that cost the first
 * live implementer run.
 */
function logSubagentGate(args: {
  turnId: string;
  agentID: string;
  binding: SubagentBinding | undefined;
  toolName: string;
  decision: string;
  reason: string;
}): void {
  try {
    console.info(
      "[marvin.telemetry] " +
        JSON.stringify({
          kind: "gate.subagent",
          turnId: args.turnId,
          agentID: args.agentID,
          subagentType: args.binding?.subagentType ?? null,
          worktree: args.binding?.worktree ?? null,
          tool: args.toolName,
          decision: args.decision,
          reason: args.reason.slice(0, 160),
          at: new Date().toISOString(),
        }),
    );
  } catch {
    /* never break on serialisation */
  }
}

export function remapGraphExtractionDispatch(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!isSubagentDispatch(toolName)) return null;
  if (input.subagent_type !== "general-purpose") return null;
  const brief = [input.prompt, input.description]
    .filter((v): v is string => typeof v === "string")
    .join("\n");
  if (!/(^|\/|`|\s)graphify-out\//i.test(brief)) return null;
  if (!/\b(extract\w*|chunk\w*|nodes|edges|hyperedges|semantic)\b/i.test(brief)) return null;
  return { ...input, subagent_type: "graph-extractor" };
}

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
    /** ADR-0081 — the worktree an implementer subagent is bound to. Only the
     *  registry sets this, only for `implementer`, only when its dispatch
     *  prompt named exactly one registered worktree. */
    worktree?: string;
    /** The project root, for resolving relative targets in the worktree check. */
    workDir?: string;
  },
): { decision: "allow" | "confirm" | "deny"; reason: string; updatedInput?: Record<string, unknown> } {
  // Resolve a base decision + reason from EITHER the named-tool policy OR an
  // external-MCP classifier, then share the collapse + mapping tail below.
  let baseDecision: "allow" | "confirm" | "deny";
  let policyReason: string;

  // RENAME CANARY (ADR-0088). Checked BEFORE the not-in-the-gated-set
  // blanket-allow below, because that allow is exactly what ADR-0079's
  // rename fell through: `Agent` was not in KNOWN_TOOL_NAMES, so dispatch
  // was ungated entirely. A call carrying `subagent_type` is a dispatch
  // whatever it is called, so an unrecognised tool with that input gets the
  // sanctioned-type ladder rather than a free pass — and is logged loudly,
  // because the right fix is to add the name to SUBAGENT_DISPATCH_TOOLS.
  if (looksLikeSubagentDispatch(name, input)) {
    try {
      console.warn(
        "[marvin.telemetry] " +
          JSON.stringify({
            kind: "gate.unknown_dispatch_tool",
            tool: name,
            subagentType: typeof input.subagent_type === "string" ? input.subagent_type : null,
            note: "tool takes subagent_type but is not in SUBAGENT_DISPATCH_TOOLS — likely a rename (ADR-0079/0088)",
            at: new Date().toISOString(),
          }),
      );
    } catch {
      /* never break a turn on telemetry */
    }
  }

  if (!KNOWN_TOOL_NAMES.has(name as ToolName) && !looksLikeSubagentDispatch(name, input)) {
    // Tools outside our named set are auto-allowed by default — they're
    // sandboxed or delegate back to tools we already gate. EXCEPTION (ADR-0045):
    // a classified external MCP server (Playwright) goes through the ladder so
    // its code-exec/egress tools are gated and the subagent invariant applies.
    const mcpClass = mcpToolPolicy(name);
    if (mcpClass === null) {
      return { decision: "allow", reason: `${name} is not in the gated set.` };
    }
    baseDecision = mcpClass === "auto" ? "allow" : mcpClass === "deny" ? "deny" : "confirm";
    policyReason =
      mcpClass === "deny"
        ? `${name} executes arbitrary code — denied (ADR-0045).`
        : mcpClass === "confirm"
          ? `${name} changes browser state or reaches the network — confirm (ADR-0045).`
          : `${name} is a read-only browser tool.`;
  } else {
    // An unknown-but-dispatch-shaped tool lands here too (canary above), and
    // toolPolicy's dispatch branch handles it by shape, not by name.
    const policy = toolPolicy(name as ToolName, input);
    baseDecision =
      policy.class === "auto" ? "allow" : policy.class === "deny" ? "deny" : "confirm";
    policyReason = policy.reason;
  }

  // PLAN-FILE OWNERSHIP (ADR-0052). Files under `.marvin/plans/` are the
  // app's rendered projection of the tracked plan spine — checkbox overlays,
  // reconciled sub-tasks, live status. When the MODEL writes them directly
  // (observed 2026-07-02: a plan created via the Write tool in agent mode),
  // the plan never enters the spine: no tracking, no plan-context injection,
  // a file that silently freezes. Deny the direct write and steer the model
  // to the contract: present the plan as a `# Plan — <title>` reply and let
  // TodoWrite drive progress; the app owns the file.
  if (
    mutatesProtectedPath(name, input, (p) => p.includes(".marvin/plans/"))
  ) {
    return {
      decision: "deny",
      reason:
        `${name} targets a file under .marvin/plans/ — that directory is ` +
        `MARVIN's app-owned projection of the tracked plan (ADR-0052). ` +
        `Never write plan files directly. To create or revise a plan, ` +
        `reply with a message starting \`# Plan — <title>\`; to record ` +
        `progress, keep TodoWrite updated with [N]/[N.M]-tagged items. ` +
        `The app renders both into the file.`,
    };
  }

  // MEMORY OWNERSHIP (ADR-0042 enforcement addendum). `.marvin/memory.md`
  // (the index) and `.marvin/memory/` (the fact files) belong to the
  // `remember` tool — the caps + content-class guards live there, and a
  // direct edit bypasses them exactly the way the 419 KB append-log did.
  // The match is deliberately precise: `.marvin/memory.archive.md` (the
  // /memory-compact archive) and `.marvin/session-notes.md` stay writable.
  // `mcp__marvin-memory__remember` never reaches this block (non-Playwright
  // MCP short-circuits to allow above); its writes are server-side fs calls.
  if (
    mutatesProtectedPath(
      name,
      input,
      (p) => p.includes(".marvin/memory.md") || p.includes(".marvin/memory/"),
    )
  ) {
    return {
      decision: "deny",
      reason:
        `${name} targets MARVIN's memory layer (.marvin/memory.md / ` +
        `.marvin/memory/) — the enforced write path is the \`remember\` ` +
        `MCP tool (ADR-0042). Call remember with a name, a one-line hook, ` +
        `and the durable fact; it writes the fact file and rebuilds the ` +
        `index. Use \`recall\` to read facts.`,
    };
  }

  // GRAPH-EXTRACTION WRITE EXCEPTION (ADR-0058). Building the knowledge graph
  // is read-only *discovery* — the sanctioned fan-out pattern (scouts ADR-0014,
  // dynamic workflows ADR-0030), NOT the forbidden parallel-implementation of
  // Golden Rule 1. The only friction is that graphify's extractor subagents
  // must write their chunk output under `graphify-out/`. Narrowly permit that:
  // a sub-agent file-write whose target is under `graphify-out/` is allowed,
  // so the extraction fan-out can run in parallel. Everything else a sub-agent
  // writes stays hard-denied by the invariant below. NOT granted in Ask mode
  // (readOnly) — that whole-turn constraint still wins.
  if (
    opts?.agentID &&
    !opts?.readOnly &&
    baseDecision !== "allow" &&
    writesUnderGraphOut(name, input)
  ) {
    return {
      decision: "allow",
      reason:
        `${name} writes graph-extraction output under graphify-out/ — permitted ` +
        `for graph subagents (ADR-0058). Read-only discovery, scoped write.`,
    };
  }

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
  // IMPLEMENTER WORKTREE ALLOWANCE (ADR-0081). The one amendment to the
  // invariant below: an implementer bound to a MARVIN-created worktree may
  // mutate THAT tree — Edit/Write/NotebookEdit under its path, Bash pinned to
  // it. The main tree stays exactly as protected as before; the deliverable
  // is a branch the user merges. Not granted in Ask mode.
  if (opts?.agentID && opts.worktree && !opts.readOnly && opts.workDir) {
    const wt = implementerWorktreePolicy(name, input, opts.worktree, opts.workDir);
    if (wt) return wt;
  }

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

  if (baseDecision === "allow") return { decision: "allow", reason: policyReason };
  if (baseDecision === "deny") return { decision: "deny", reason: policyReason };
  return { decision: "confirm", reason: policyReason };
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
/**
 * Does this allowed tool call change the workspace? (ADR-0069)
 *
 * Used only to decide whether an in-flight turn may be preempted by an
 * arriving user message. Deliberately CONSERVATIVE: anything uncertain counts
 * as mutating, because the cost of a false negative (interrupting a turn
 * mid-write) is a corrupted edit, while a false positive merely makes the user
 * queue instead of preempting.
 */
export function isMutatingToolCall(toolName: string, input: Record<string, unknown>): boolean {
  if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(toolName)) return true;
  if (toolName !== "Bash") return false;
  const cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd) return true; // unknown Bash -> assume it writes
  // A short read-only allowlist. Everything else is treated as mutating.
  const readOnly = /^\s*(git\s+(status|log|diff|show|branch|rev-parse)|ls|cat|head|tail|grep|rg|find|wc|pwd|echo|which|stat|file|du|df)\b/;
  return !readOnly.test(cmd);
}

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
 * turn), denies immediately rather than hanging. When a UI IS wired, the
 * confirm is registered with NO auto-deny timeout — a decision waits for the
 * human (see the `timeoutMs: 0` note below); the turn's `finally`
 * (clearTurnConfirms) and Stop unwind an abandoned one.
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
    // NO auto-deny timer (timeoutMs = 0). AskUserQuestion is the model
    // explicitly blocking on a human DECISION — a person can legitimately take
    // far longer than the 5-minute permission-confirm default to weigh detailed
    // options. The old default auto-DENIED after 5 min, silently discarding the
    // user's pending answer and making a later "Send choice" click hit a
    // resolved/gone confirm (404 → "nothing happens"). It now waits for the
    // human; the turn's `finally` (clearTurnConfirms) + Stop are the escapes.
    registerPendingConfirm(turnId, toolUseID, resolve, input, 0);
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
 * Shared-tree collision gate — two sessions, one checkout.
 *
 * MARVIN supports several sessions on one working tree; the user requires it.
 * What a shared tree cannot give each session is its own HEAD, so a
 * `git checkout` in one session silently rewrites every file the other is
 * working on. That happened on 2026-09-01 and read to the user as the two
 * sessions having become "interconnected".
 *
 * The precedent for the fix is Anthropic's own: agent teams run multiple
 * sessions in one directory and are documented as NOT isolating them, relying
 * instead on partitioned ownership plus a lock on the shared coordination
 * state. So this neither isolates (that's a worktree, which the user does not
 * want) nor refuses (a branch switch is often exactly the intent) — it
 * surfaces the collision at the instant it would happen, naming the other
 * session, and lets the human decide.
 *
 * ## Why this sits beside AskUserQuestion rather than in `toolPolicy`
 *
 * Two reasons, both structural:
 *
 *   1. `toolPolicy` is pure. Whether another session is live is runtime state,
 *      and threading the turn registry into a pure classifier would make it
 *      untestable for the sake of one caller.
 *   2. The `confirm` class is bypassed wholesale in `auto` mode, which is
 *      MARVIN's default. A conflict that only prompts in `gated` mode would
 *      not have prevented the incident that motivated it. `maybePlanApproval`
 *      and `maybeAskUserQuestion` established the shape for "reaches the user
 *      in every mode"; this is the third member of that family.
 *
 * Returns null — the overwhelmingly common case — unless ALL of:
 *   - the call is a Bash command that moves HEAD or rewrites the tree,
 *   - another session in the same project has a turn running right now,
 *   - a UI is wired to answer.
 *
 * With no UI (a headless wakeup, a background-job turn) the call is DENIED
 * rather than allowed or hung: an unattended turn is the worst possible one to
 * let move HEAD under a session the user is actively watching, and the message
 * names the escape.
 */
function maybeSharedTreeConfirm(args: {
  toolName: string;
  turnId: string;
  toolUseID: string;
  input: Record<string, unknown>;
  /** Absent for turns with no session identity (nothing to collide with). */
  session?: { projectId: string; marvinSessionId: string };
  onConfirmRequest?: (request: ConfirmRequestPayload) => void;
}): Promise<PermissionResult> | null {
  const { toolName, turnId, toolUseID, input, session, onConfirmRequest } = args;
  if (toolName !== "Bash" || !session) return null;
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return null;
  const verdict = classifySharedTreeRisk(command);
  if (!verdict) return null;

  const others = listLiveTurns(session.projectId).filter(
    (t) => t.marvinSessionId !== session.marvinSessionId,
  );
  if (others.length === 0) return null;

  const names = others.map((t) => t.marvinSessionId.slice(0, 8)).join(", ");
  const plural = others.length === 1 ? "session" : "sessions";
  const reason =
    `\`${verdict.verb}\` ${describeSharedTreeRisk(verdict.risk)}. ` +
    `${others.length} other ${plural} (${names}) ${others.length === 1 ? "is" : "are"} ` +
    `running a turn in this same checkout right now. ` +
    `Allow to proceed anyway, or deny and run it in a worktree instead.`;

  if (!onConfirmRequest) {
    return Promise.resolve({
      behavior: "deny",
      message:
        `${reason} No interactive UI is attached to this turn, so it was denied ` +
        `rather than run unattended. Wait for the other ${plural} to finish, or ` +
        `create a worktree with \`git worktree add\` and work there.`,
      interrupt: false,
    } as PermissionResult);
  }

  return new Promise<PermissionResult>((resolve) => {
    // No auto-deny timer, same reasoning as AskUserQuestion: this is a human
    // decision about their own two sessions, and a silent timeout would turn
    // into the mystery failure the confirm exists to replace.
    registerPendingConfirm(turnId, toolUseID, resolve, input, 0);
    onConfirmRequest({
      turnId,
      toolUseId: toolUseID,
      toolName: "Bash",
      input,
      reason,
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
    // Two sessions, one checkout: a HEAD-moving command reaches the user in
    // every mode. `checkpoint` is where this callback already carries the
    // session's identity; the gate is a no-op without it, and without a second
    // live session — which is every single-session turn.
    const sharedTree = maybeSharedTreeConfirm({
      toolName, turnId, toolUseID, input: safeInput,
      ...(checkpoint ? { session: checkpoint } : {}),
      onConfirmRequest,
    });
    if (sharedTree) return sharedTree;
    const binding = lookupSubagent(agentID);
    const cls = classifyToolCall(toolName, toolInput as Record<string, unknown>, {
      agentID,
      readOnly,
      ...(binding?.worktree ? { worktree: binding.worktree, workDir: cwd } : {}),
    });
    if (agentID) logSubagentGate({ turnId, agentID, binding, toolName, decision: cls.decision, reason: cls.reason });
    if (cls.decision !== "deny") {
      maybeRecordPreImage({ checkpoint, cwd, turnId, toolName, input: safeInput, agentID });
      // ADR-0069 — the preemption safety flag. Set the INSTANT a mutating call
      // is allowed, before the write lands: a turn midway through an edit is
      // precisely the one an arriving user message must not interrupt.
      if (checkpoint && isMutatingToolCall(toolName, safeInput)) {
        markTurnMutated(checkpoint.marvinSessionId);
      }
    }
    if (cls.decision === "deny") {
      return {
        behavior: "deny",
        message: cls.reason || "tool use denied",
        interrupt: false,
      } as PermissionResult;
    }
    // ADR-0058 addendum: a general-purpose Task that is recognisably a
    // graph-extraction dispatch is rewritten to the Haiku `graph-extractor`
    // at the gate — the model saving no longer depends on the prose steer.
    const remapped = remapGraphExtractionDispatch(toolName, safeInput);
    const finalInput = remapped ?? cls.updatedInput ?? safeInput;
    appendAutoAuditEntry(cwd, {
      tool: toolName as AutoAuditEntryKind,
      reason:
        (cls.decision === "allow" ? cls.reason : `auto-mode bypass: ${cls.reason}`) +
        (remapped ? " [remapped → graph-extractor, ADR-0058]" : ""),
      input: finalInput,
      turnId,
      toolUseId: toolUseID,
    });
    return { behavior: "allow", updatedInput: finalInput } as PermissionResult;
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
    // Two sessions, one checkout. Ahead of `classifyToolCall` because the
    // conflict is about WHO ELSE is in the tree, not about the command's own
    // risk class — several of these commands auto-allow on their own merits.
    const sharedTree = maybeSharedTreeConfirm({
      toolName, turnId, toolUseID, input: safeInput,
      ...(checkpoint ? { session: checkpoint } : {}),
      onConfirmRequest,
    });
    if (sharedTree) return sharedTree;
    const binding = lookupSubagent(agentID);
    const cls = classifyToolCall(toolName, toolInput as Record<string, unknown>, {
      agentID,
      readOnly,
      ...(binding?.worktree ? { worktree: binding.worktree, workDir: cwd } : {}),
    });
    if (agentID) logSubagentGate({ turnId, agentID, binding, toolName, decision: cls.decision, reason: cls.reason });
    if (cls.decision !== "deny") {
      // Pre-image BEFORE the confirm round-trip too: if the user allows,
      // the write executes inside the SDK with no further hook here.
      maybeRecordPreImage({ checkpoint, cwd, turnId, toolName, input: safeInput, agentID });
    }

    if (cls.decision === "allow") {
      // ADR-0058 addendum: same graph-extraction dispatch rewrite as auto
      // mode — sanctioned Task dispatches auto-allow under gated too, so the
      // remap must live here as well or gated sessions lose the Haiku saving.
      const remapped = remapGraphExtractionDispatch(toolName, safeInput);
      const finalInput = remapped ?? cls.updatedInput ?? safeInput;
      // Audit-log mutators that auto-allow under `gated` too. Read /
      // Grep / Glob fall through `appendAutoAuditEntry`'s
      // TOOLS_WORTH_LOGGING filter, so only Edit / Write / Bash
      // actually land in the JSONL — no log explosion.
      appendAutoAuditEntry(cwd, {
        tool: toolName as AutoAuditEntryKind,
        reason: cls.reason + (remapped ? " [remapped → graph-extractor, ADR-0058]" : ""),
        input: finalInput,
        turnId,
        toolUseId: toolUseID,
      });
      return { behavior: "allow", updatedInput: finalInput } as PermissionResult;
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
    onWorktreeFinished,
    signal,
  } = input;
  const permissionStrategy: PermissionStrategy = input.permissionStrategy ?? "auto";
  // The advisor subagent (ADR-0033) defaults to the latest Opus tier
  // (claude-opus-4-8 today) rather than inheriting the executor — a second
  // opinion should always come from the strongest model, even when a cheaper
  // model drives the loop (e.g. runtime "advisor" mode). Tier-resolved per
  // ADR-0029 (no hardcoded version id); `defaultModel()` is the last resort.
  // ADR-0096 — the backstop: a bare Anthropic id must never reach an
  // OpenRouter session, whichever branch produced it.
  const advisorModelResolved =
    ensureProviderModelId(advisorModel ?? (await latestForTier("opus")) ?? defaultModel()) ??
    defaultModel();
  // Haiku-tier model for the graph-extractor subagent (ADR-0058). Falls back to
  // "inherit" (the parent tier) only if Haiku discovery is unavailable.
  const graphExtractorModel = ensureProviderModelId(await latestForTier("haiku")) ?? "inherit";

  // Wire Honeycomb telemetry per-turn. `computeHoneycombTelemetryEnv`
  // is the pure form — it reads the saved config at
  // `<cwd>/.marvin/honeycomb.json` (or the global fallback) and
  // returns the env-diff to merge, WITHOUT mutating `process.env`.
  // Two concurrent turns for two different projects with different
  // Honeycomb configs each get their own env via `Options.env`
  // below, so they don't clobber each other. Audit finding #4.
  const { env: honeycombEnv } = computeHoneycombTelemetryEnv(cwd);
  const authEnv = buildSubprocessEnv();
  const turnEnv: Record<string, string | undefined> = {
    ...authEnv,
    ...honeycombEnv,
    // ADR-0073 — keep the TodoWrite contract across the SDK 0.3 upgrade.
    // From 0.3.142, Opus 4.8+ / Sonnet 5+ sessions get NO task-tracking tool
    // unless opted in, and the opt-in family defaults to the id-based Task
    // tools (TaskCreate/TaskUpdate). MARVIN's entire plan spine (ADR-0046/
    // 0049/0052/0068) reconciles TodoWrite snapshots by `[N]`/`[N.M]` tag;
    // silently losing that tool would leave every plan frozen at "pending".
    // Opt the family in, and select the legacy snapshot tool over Task tools.
    // Migrating the spine to Task ids is its own change (ADR-0073 §next).
    CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
    CLAUDE_CODE_ENABLE_TASKS: "0",
    // Enrich PATH so the SDK + every subprocess it spawns (notably the
    // Playwright MCP stdio server's bare `npx`) can find Homebrew node even
    // when MARVIN was launched from Finder with the minimal launchd PATH.
    PATH: enrichedToolPath(),
    // SUBAGENT RAILS (ADR-0079). MARVIN's sanctioned subagents — advisor,
    // scout, graph-extractor, plugin agents, dynamic-workflow children — are
    // all ONE level deep by design: `personality.ts` tells a scout "no nested
    // subagent dispatches", and Golden Rule 1 forbids model-dispatching-model
    // trees outright. Until now that was prose only; the SDK's own defaults
    // (depth 3, 20 concurrent) are what actually applied, so a misbehaving
    // turn could grow a tree the rule forbids and nothing would stop it.
    // Depth 2 leaves one level of slack for a plugin agent that legitimately
    // fans out; concurrency 8 is above graphify's extraction fan-out and well
    // under the "spawned 50 subagents for a simple query" failure Anthropic
    // documents. A user who sets either var keeps their own value.
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH:
      process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? "2",
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS:
      process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? "8",
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
  const turnCloseStopHook = makeTurnCloseStopHook({
    turnId,
    facts: () => ({
      mutations: designCtx.mutationCount,
      lastTodos: lastTodoPayload,
      machineTurn: /^\[(scheduled wakeup|queued |\d+ messages queued)/.test(message),
    }),
    onFired: () => {
      /* telemetry lives in the hook; nothing else to record per turn */
    },
  });
  // Output governor (PostToolUse) — caps what a Bash result costs before the
  // model sees it; full output goes to disk with a pointer in the result.
  const outputGovernorHook = makeOutputGovernorPostToolUse({
    marvinSessionId: input.marvinSessionId ?? "unscoped",
    turnId,
  });
  // ADR-0095 — read the advisor's verdict and park its caveats. The dispatch
  // was already counted in PreToolUse; this is the half that looks at the
  // ANSWER, so a `reject` stops discharging the gate like a `go` and the
  // caveats outlive the context window.
  const advisorVerdictHook = makeAdvisorVerdictPostToolUse({
    workDir: cwd,
    marvinSessionId: input.marvinSessionId ?? "unscoped",
    turnId,
    advisorModel: advisorModelResolved,
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

  // In-process MCP server for the curated durable-facts memory (ADR-0042).
  // The enforced write path for `.marvin/memory.md` — `remember` caps + rejects
  // activity/status content so the log can't bloat back to a redundant blob.
  // Scoped to the active project's workDir (never MARVIN's own repo).
  const memoryMcp = createMemoryMcpServer(cwd);

  // In-process MCP server for the project backlog (ADR-0044) — the enforced
  // write path for `.marvin/backlog/`. `backlog_add` rejects fact/status/
  // decision payloads + caps length so the parking lot can't bloat. Scoped to
  // the active project's workDir; carries the session id for the source link.
  const backlogMcp = createBacklogMcpServer({ cwd, marvinSessionId: input.marvinSessionId });

  // Obsidian vault integration (ADR-0065). Status is read-only; init writes
  // only `.obsidian/app.json`, `MARVIN.md` and `graphify-out/obsidian/` — never
  // a note the user wrote. Scoped to the active project's workDir.
  const obsidianMcp = createObsidianMcpServer({ cwd });

  // In-process MCP server exposing the self-wakeup tools (ADR-0031). Only
  // wired when we know which session to resume — a wakeup turn must be able
  // to re-enter THIS marvinSession. Captures the turn's config so the fired
  // turn inherits the same model / permission posture (no elevation).
  const wakeupCtx: WakeupToolContext | null =
    input.marvinSessionId && input.projectId
      ? {
          marvinSessionId: input.marvinSessionId,
          projectId: input.projectId,
          cwd,
          model,
          advisorModel: advisorModel ?? null,
          personality: input.personality ?? "ultron",
          permissionStrategy,
          playwrightEnabled: input.playwrightEnabled,
          thinkingMode: input.thinkingMode ?? "high",
          advisorThinkingMode: input.advisorThinkingMode,
          depth: input.wakeupDepth ?? 0,
        }
      : null;
  const wakeupMcp = wakeupCtx ? createWakeupMcpServer(wakeupCtx) : null;

  // Project-local skills plugin (ADR-0024). When the project has
  // committed any `<workDir>/.marvin/skills/<name>/SKILL.md` files, we
  // synthesize a minimal plugin manifest at `<workDir>/.marvin/.claude-plugin/plugin.json`
  // (idempotent — never overwrites a customised one) and pass the
  // plugin spec to the SDK so the project-local skills become callable
  // from this session. No skills committed → `null` returned, the
  // option is omitted, the SDK runs with user-global skills only.
  const projectSkillsPlugin = projectSkillsPluginConfig(cwd);

  // Installed Claude Code plugins, opt-in per project (ADR-0053). Discovered
  // from `~/.claude/plugins/`, activated only when listed in
  // `<workDir>/.marvin/plugins.json`. Returns empty for a non-project cwd or
  // when nothing is enabled — so a session with no `plugins.json` is unchanged.
  // v1 loads skills + commands via a sanitised staged copy (agents/hooks
  // stripped); plugin-declared MCP servers are merged into `mcpServers` below,
  // where the ADR-0053 gate routes their tools through `confirm`.
  const enabledPlugins = loadEnabledPlugins(cwd);

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
    // FOREIGN HARNESS TOOLS (ADR-0055 addendum 2). `ScheduleWakeup` is the
    // Claude Code harness's own tool for `/loop` dynamic pacing. Inside
    // MARVIN's SDK session there is no loop for it to pace, so calling it
    // schedules NOTHING — but it reads as the obvious choice, and MARVIN's own
    // tool is the snake_case `schedule_wakeup`. Observed 2026-08-23: MARVIN
    // called `ScheduleWakeup`, told the user it had "scheduled a check in ~2
    // minutes", and nothing ever fired — the wakeup store held only an
    // unrelated 24 h entry. Worse, the coverage check below tests
    // `name.includes("schedule_wakeup")`, which is FALSE for `ScheduleWakeup`,
    // so the promise looked uncovered to the backstop and armed nothing either.
    // Remove it from the tool surface entirely: a tool that silently no-ops a
    // safety-critical promise must not be reachable.
    disallowedTools: [
      "ScheduleWakeup",
      ...(readOnly ? ["Edit", "Write", "NotebookEdit"] : []),
    ],
    // PreToolUse fires on EVERY tool call BEFORE the SDK's permission
    // pipeline. canUseTool only gets called for tools the SDK considers
    // gate-worthy (Edit / Write / Bash) — Read / Grep / Glob auto-allow
    // without consulting it. The design hooks need to gate the read /
    // search side too (graphify-first), so they live here as PreToolUse.
    hooks: {
      PreToolUse: [{ hooks: [designPreToolUseHook] }],
      PostToolUse: [{ hooks: [outputGovernorHook, advisorVerdictHook] }],
      // Turn-close guard (2026-09-03): a real-work turn ending without its
      // handoff, or a turn stopping with plan steps open and no question, is
      // blocked ONCE with the reason and the model continues in-request.
      Stop: [{ hooks: [turnCloseStopHook] }],
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: appendSystemPrompt + modeGuidance(mode),
    },
    mcpServers: {
      "marvin-graph": graphMcp,
      "marvin-memory": memoryMcp,
      "marvin-backlog": backlogMcp,
      "marvin-obsidian": obsidianMcp,
      ...(wakeupMcp ? { "marvin-control": wakeupMcp } : {}),
      // Opt-in external (stdio) browser server (ADR-0045). Off by default; its
      // tools are gated in `classifyToolCall` (code-exec denied, interaction
      // confirmed, observation auto) — NOT blanket-allowed like the in-process
      // servers above.
      ...(input.playwrightEnabled
        ? {
            [PLAYWRIGHT_SERVER_KEY]: {
              type: "stdio" as const,
              command: "npx",
              args: ["@playwright/mcp@latest"],
              // Belt-and-braces with turnEnv: spawn the server with an enriched
              // PATH so bare `npx` resolves under a Finder-launched app's
              // minimal PATH (ADR-0045 follow-up). Without this the server
              // ENOENTs and the browser tools silently never register.
              env: browserServerEnv(),
            },
          }
        : {}),
      // Plugin-declared MCP servers (ADR-0053). Namespaced by the plugin's own
      // server name; their tools arrive as `mcp__<name>__*` and the gate routes
      // them through `confirm` (never the blanket-allow the in-process servers
      // above get). Empty unless a plugin is opted in via `.marvin/plugins.json`.
      ...(enabledPlugins.mcpServers as Record<string, McpServerConfig>),
    },
    // Project-local skills (ADR-0024). When `<workDir>/.marvin/skills/`
    // contains at least one SKILL.md, the SDK loads the synthesised
    // plugin and the project's skills become callable from this turn.
    // Project-local skill names SHADOW user-global ones on conflict —
    // mirrors the per-project MCP override precedence rule.
    // …plus any opt-in installed plugins (ADR-0053), loaded from their
    // sanitised staged copies. Both sources share the one `plugins:` array.
    ...((projectSkillsPlugin || enabledPlugins.plugins.length > 0)
      ? { plugins: [...(projectSkillsPlugin ? [projectSkillsPlugin] : []), ...enabledPlugins.plugins] }
      : {}),
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
      [ADVISOR_SUBAGENT_TYPE]: buildAdvisorAgent({
        model: advisorModelResolved,
        // Default the advisor to the EXECUTOR's effort when no separate
        // advisor effort was picked — exactly the pre-ADR-0033 behaviour.
        effort: resolveEffort(
          input.advisorThinkingMode ?? input.thinkingMode,
          advisorModelResolved,
        ),
      }),
      // ADR-0058: the cheap, parallel graph-extraction subagent (Haiku tier,
      // writes scoped to graphify-out/ by the gate). Dispatched for graphify's
      // semantic pass so it fans out on a low-cost model instead of running
      // serially on the executor.
      "graph-extractor": buildGraphExtractorAgent({ model: graphExtractorModel }),
      // ADR-0081: the worktree-isolated builder. Writes are gate-scoped to
      // the worktree its dispatch prompt names; the main tree stays sealed.
      [IMPLEMENTER_TYPE]: buildImplementerAgent(),
    },
    includePartialMessages: false,
    // Reasoning-effort selection → SDK effort. Accepts the full ladder
    // (low/medium/high/xhigh/max) and legacy fast/thinking/max aliases;
    // `xhigh`/`max` fall back to `high` on non-Opus executors per
    // `resolveEffort`. Defaults to `high` (the SDK default), so existing
    // sessions keep their current responsiveness.
    effort: resolveEffort(input.thinkingMode, model),
    // Server-side advisor (`--advisor <model>`) is intentionally NOT wired
    // here. The old inert `options.advisorModel` (a Claude Code *settings*
    // field the SDK wrapper drops — not a `query()` option) is removed.
    // Verified against the 0.2.113 binary (2026-06-18): the flag is
    // EXPERIMENTAL (gated behind `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`)
    // AND the advisor model is allowlisted server-side — the current default
    // Opus is rejected, so passing it unconditionally would error the turn.
    // The advisor MODEL still reaches its real consumer: the `agents.advisor`
    // subagent registered above (ADR-0033). See ADR-0033 addendum.
    ...(sessionId ? { resume: sessionId } : {}),
  } as Options;

  let lastSessionId: string | undefined = sessionId;
  let durationMs: number | undefined;
  let costUsd: number | undefined;
  let tokenUsage: RunAgentResult["tokenUsage"];
  let permissionDenials = 0;
  let resultError: string | undefined;
  /** ADR-0100 — advisor conditions captured before the design context is torn
   *  down, for the scope-met reconcile below. */
  let advisorConditionsAtClose: string[] = [];
  // True once a non-error `result` envelope has been observed. Drives
  // the watchdog: if the SDK iterator hasn't terminated within
  // WATCHDOG_MS of seeing `result`, we force-abort the subprocess
  // and treat the resulting AbortError as a clean exit (the turn
  // already succeeded — we just couldn't get the SDK process to
  // close its stdio). Observed in v0.2.113 when stdio MCP children
  // (e.g. Playwright) hold the parent open after `result`.
  let seenSuccessfulResult = false;
  // Check-back guard state (ADR-0055). Track the LAST assistant message's text
  // and whether any follow-through mechanism was armed during the turn, so at
  // turn-end we can auto-arm a wakeup for an unbacked "I'll check back" promise.
  let finalAssistantText = "";
  let armedWakeup = false;
  let armedBackgroundJob = false;
  // Workflow-completion guard state (ADR-0057). Latest TodoWrite payload and the
  // set of ADR files this turn edited, checked at turn-end against the scope-met
  // marker to catch a premature "done".
  let lastTodoPayload: unknown ;
  const editedAdrPaths = new Set<string>();
  let watchdogTimer: NodeJS.Timeout | null = null;
  // ADR-0080 — background subagents outlive the main turn's `result`. While
  // the SDK reports any as live, a `result` is intermediate: the CLI will
  // re-prompt the model with the completion and produce another. Closing the
  // channel + arming the 5 s watchdog at the FIRST result would kill the scout
  // it was waiting for. The ledger is fed by `background_tasks_changed`.
  const bgLedger = new BackgroundTaskLedger();
  let bgDrainTimer: NodeJS.Timeout | null = null;
  // Upper bound on how long a deferred result may wait for its background
  // tasks. Scouts are `maxTurns: 40`; nothing legitimate needs this long.
  const BG_DRAIN_MAX_MS = (() => {
    const raw = process.env.MARVIN_BACKGROUND_DRAIN_MAX_MS;
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
  })();
  // Watchdog window. Tunable via env in case a future SDK version
  // needs longer post-`result` cleanup; the default is generous
  // enough that any honest cleanup completes naturally.
  const WATCHDOG_MS = (() => {
    const raw = process.env.MARVIN_RESULT_WATCHDOG_MS;
    if (!raw) return 5_000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 5_000;
  })();

  // ADR-0076 — hoisted above `try` so `finally` can close it.
  //
  // ALWAYS a channel (ADR-0081). Without one the SDK runs in single-message
  // mode, and in that mode it stops servicing permission requests after the
  // first `result` — every background subagent tool call is then denied with
  // the SDK's generic "the user doesn't want to take this action", before
  // MARVIN's hooks or gate ever see it. Found the hard way: four live runs of
  // an implementer died on their first call with no MARVIN code involved.
  // The orchestrator always passes a channel; this default makes it a
  // property of `runAgent` rather than of its caller.
  const channel = input.inputChannel ?? new TurnInputChannel();
  try {
    // ADR-0051 — inject the live active-plan snapshot as a `<system-reminder>`
    // suffix on THIS user turn. It rides the new message (the uncached volatile
    // tail), so it never invalidates the cached system prefix even as step
    // statuses change; and it's only on the SDK prompt, not the persisted
    // `turn.user`, so reloads show the clean message.
    // Graph pre-orientation (2026-09-03): the runtime runs the turn's first
    // graph call itself and rides the answer on the prompt. See
    // `graph-orientation.ts` for the measurement that put the graphify-first
    // deny at the top of the practice backtest. Same seam as the plan
    // snapshot: the uncached tail, never the cached prefix.
    let orientation: string | null = null;
    if (designCtx.hasGraph) {
      const query = buildOrientationQuery(message);
      if (query) {
        try {
          const hits = searchGraph(join(cwd, "graphify-out", "graph.json"), query, 8);
          orientation = formatOrientation(query, hits);
          if (orientation) {
            recordAllowedTool(designCtx, "mcp__marvin-graph__graph_search", { query });
            console.info(
              "[marvin.telemetry] " +
                JSON.stringify({ kind: "graph.preorient", turnId, hits: hits.length, at: new Date().toISOString() }),
            );
          }
        } catch {
          orientation = null; // the graph is a convenience here, never a blocker
        }
      }
    }
    const reminders = [orientation, input.planContext].filter((x): x is string => Boolean(x));
    const turnPrompt =
      reminders.length > 0
        ? `${message}\n\n${reminders.map((r) => `<system-reminder>\n${r}\n</system-reminder>`).join("\n\n")}`
        : message;
    // Wall-clock when the model turn began — stamped onto the terminal
    // `result` event below so the chat footer can show "start → end"
    // (the SDK's duration_ms alone can't say *when* it ran). These ride
    // on the persisted result cli.event, so replay reconstructs the same
    // timestamps — the ONLY seam that survives transcript reload (the
    // client skips turn.completed on replay).
    const turnStartedAtIso = new Date().toISOString();
    // ADR-0076 — streaming input when a channel is supplied; the SDK
    // accepts an AsyncIterable of user messages in place of the string.
    const q = query({
      prompt: channel ? channel.stream(turnPrompt) : turnPrompt,
      options,
    });
    // Slash-command catalog capture is armed here but FIRED after the
    // `system/init` event below — `supportedCommands()` is a control request
    // that needs the subprocess session initialised, so calling it straight
    // after `query()` races the handshake and silently fails.
    let capturedCommands = false;
    for await (const ev of q) {
      if (ev.type === "result") {
        // Enrich BEFORE onEvent forwards + persists it, so the wire event
        // and the on-disk cli.event both carry the timestamps.
        Object.assign(ev, {
          marvin_started_at: turnStartedAtIso,
          marvin_ended_at: new Date().toISOString(),
        });
      }
      onEvent(ev);
      // ADR-0080 — level signal, REPLACE semantics (see background-tasks.ts).
      const bgTasks = backgroundTasksPayload(ev);
      if (bgTasks) bgLedger.replace(bgTasks);
      // ADR-0082 — Claude plan usage. The SDK reports the 5-hour / weekly
      // window state on every turn; for a subscription this IS the spend.
      const rl = rateLimitPayload(ev);
      if (rl) {
        try {
          recordClaudeRateLimit(rl);
        } catch {
          /* usage display is best-effort; never fail a turn on it */
        }
      }
      // ADR-0081 — remember which subagent this task_id is, and bind an
      // implementer to the worktree its dispatch prompt names.
      const started = taskStartedPayload(ev);
      if (started) {
        const known = listWorktrees(cwd).map((w) => w.path);
        const binding = registerSubagent({
          turnId,
          taskId: started.task_id,
          subagentType: started.subagent_type ?? "",
          ...(started.prompt ? { prompt: started.prompt } : {}),
          worktrees: known,
        });
        // ADR-0103 — the in-memory binding dies with the turn
        // (`clearSubagentsForTurn`), but the worktree outlives it by design.
        // Writing the task id onto the record is what lets a completion that
        // arrives later still be matched to the branch it produced.
        if (binding.worktree) {
          try {
            bindWorktreeTask(cwd, binding.worktree, started.task_id);
          } catch {
            /* the dispatch matters more than the bookkeeping */
          }
        }
        // Observability: whether an implementer got bound is the single fact
        // that decides if its writes are allowed or collapsed. Log it.
        try {
          console.info(
            "[marvin.telemetry] " +
              JSON.stringify({
                kind: "subagent.registered",
                turnId,
                taskId: started.task_id,
                subagentType: binding.subagentType,
                worktree: binding.worktree ?? null,
                knownWorktrees: known.length,
                promptHasPath: known.some((w) => (started.prompt ?? "").includes(w)),
                at: new Date().toISOString(),
              }),
          );
        } catch {
          /* never break on serialisation */
        }
      }
      // ADR-0103 — an implementer finishing is the event this system was
      // missing. Mark the record done, re-derive its state from git, and
      // reclaim it immediately when there is provably nothing to lose.
      const finished = taskNotificationPayload(ev);
      if (finished) {
        try {
          const wt = markWorktreeFinished(cwd, finished.task_id);
          if (wt) {
            const cleaned = wt.state === "empty" && !wt.dirty ? sweepWorktrees(cwd) : [];
            onWorktreeFinished?.({
              slug: wt.slug,
              branch: wt.branch,
              state: wt.state,
              commits: wt.commits,
              filesChanged: wt.filesChanged,
              base: wt.base,
              task: wt.task,
              reclaimed: cleaned.some((c) => c.slug === wt.slug && c.deletedBranch),
            });
          }
        } catch {
          /* a failed reconcile must never kill the turn */
        }
      }
      // Check-back guard bookkeeping (ADR-0055): capture the latest assistant
      // text and note if a follow-through tool was called this turn.
      if (ev.type === "assistant") {
        const content = (ev as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const block of content) {
            const b = block as {
              type?: string;
              text?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
            if (b.type === "tool_use" && typeof b.name === "string") {
              // Tracked SEPARATELY (ADR-0055 addendum): they discharge
              // different promises. A wakeup covers any promise; a background
              // job only covers an open-ended one, since a long-running server
              // never completes and so never fires a completion turn.
              if (b.name.includes("schedule_wakeup")) armedWakeup = true;
              if (b.name.includes("run_background_job")) armedBackgroundJob = true;
              // ADR-0057 — capture the latest TodoWrite payload and any ADR files
              // edited this turn, for the turn-end workflow-completion guard.
              const input = b.input as Record<string, unknown> | undefined;
              if (b.name === "TodoWrite" && input && "todos" in input) {
                lastTodoPayload = input.todos;
              }
              if (
                (b.name === "Edit" || b.name === "Write" || b.name === "NotebookEdit") &&
                input
              ) {
                const fp = input.file_path ?? input.notebook_path;
                if (typeof fp === "string" && /docs\/decisions\/.*\.md$/.test(fp)) {
                  editedAdrPaths.add(isAbsolute(fp) ? fp : resolve(cwd, fp));
                }
              }
            }
          }
          // Last assistant message with text wins — that's the closing narration.
          if (texts.length > 0) finalAssistantText = texts.join("\n");
        }
      }
      if (ev.type === "system" && "subtype" in ev && ev.subtype === "init") {
        lastSessionId = ev.session_id;
        // Capture the slash-command catalog for the composer's autocomplete.
        // Fired HERE (not right after `query()`) because `supportedCommands()`
        // is a control request that needs the session handshake done — the
        // earlier placement raced it and failed silently. Failures are now
        // LOGGED rather than swallowed: an unobservable capture is
        // indistinguishable from "no commands", which is exactly the
        // debugging dead-end the ADR-0060 telemetry work was about.
        if (!capturedCommands && input.projectId) {
          capturedCommands = true;
          const pid = input.projectId;
          void (async () => {
            try {
              const cmds = await q.supportedCommands();
              saveSlashCommands(pid, cmds);
              console.info(
                "[marvin.telemetry] " +
                  JSON.stringify({
                    kind: "slashcommands.captured",
                    projectId: pid,
                    count: Array.isArray(cmds) ? cmds.length : 0,
                    at: new Date().toISOString(),
                  }),
              );
            } catch (e) {
              console.info(
                "[marvin.telemetry] " +
                  JSON.stringify({
                    kind: "slashcommands.failed",
                    projectId: pid,
                    error: (e as Error)?.message ?? String(e),
                    at: new Date().toISOString(),
                  }),
              );
            }
          })();
        }
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
        } else if (channel && channel.pending > 0) {
        } else if (bgLedger.hasLive) {
          // ADR-0080 — a background subagent (scout / graph-extractor) is
          // still running. Same shape as the injected-message case: this
          // `result` is intermediate. The CLI re-prompts the model when the
          // task settles (verified live: second assistant turn + second
          // `result` in the same query), so keep iterating, keep the channel
          // open, and do NOT arm the kill-watchdog. A drain bound guards
          // against a subagent that never settles.
          try {
            console.info(
              "[marvin.telemetry] " +
                JSON.stringify({
                  kind: "runagent.result.deferred",
                  turnId,
                  live: bgLedger.live,
                  tasks: bgLedger.describe(),
                  at: new Date().toISOString(),
                }),
            );
          } catch {
            /* never break on serialisation */
          }
          if (!bgDrainTimer) {
            bgDrainTimer = setTimeout(() => {
              try {
                abortController.abort();
              } catch {
                /* subprocess is wedged */
              }
            }, BG_DRAIN_MAX_MS);
          }
        } else {
          // Successful result. Arm the watchdog: if the iterator
          // doesn't terminate naturally within WATCHDOG_MS, force-
          // close the subprocess. The for-await loop will then
          // throw, but the catch block treats the abort as benign
          // (we already captured the result + token usage above).
          seenSuccessfulResult = true;
          if (bgDrainTimer) {
            clearTimeout(bgDrainTimer);
            bgDrainTimer = null;
          }
          // ADR-0076 — nothing pending: end the input stream so the SDK
          // terminates the query the way single-message mode did.
          channel?.close();
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
    // ADR-0076 — whatever ended the loop (result, abort, throw), the input
    // generator must not be left suspended waiting for a push.
    channel?.close();
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (bgDrainTimer) {
      clearTimeout(bgDrainTimer);
      bgDrainTimer = null;
    }
    // Any lingering confirm requests are auto-denied so the SDK unwinds.
    clearTurnConfirms(turnId);
    clearSubagentsForTurn(turnId);
    // ADR-0060 follow-up — emit the turn's graph:file summary BEFORE dropping
    // the context, so the ratio is readable from the sidecar log instead of
    // reconstructed from session transcripts.
    logDesignTurnSummary(designCtx);
    // ADR-0100 — read the advisor conditions off the context BEFORE the
    // teardown drops it. `clearTurnDesignContext` only deletes the registry
    // entry, so the local `designCtx` reference would survive it — but the
    // workflow guard below is ~50 lines away and depending on that detail
    // across a teardown is how a working read becomes a silent `undefined`
    // after an unrelated refactor.
    advisorConditionsAtClose = designCtx.advisorConditions ?? [];
    clearTurnDesignContext(turnId);
  }

  // ── Check-back guard (ADR-0055) ────────────────────────────────────────
  // If a successful turn ended on an "I'll check back" promise but armed NO
  // follow-through mechanism, arm the wakeup ourselves so the promise becomes
  // real (the model's firm-surface MUST fires unreliably — this is the
  // mechanical backstop). No-op without a wakeup context (unknown session).
  if (!resultError && wakeupCtx) {
    const detected = detectUncoveredCheckBack(finalAssistantText);
    // Coverage is decided per-promise, not by a single "something was armed"
    // flag: a background job discharges "I'll continue once it's done", but not
    // "I'll check in ~2.5 minutes" (ADR-0055 addendum).
    if (detected && !isCheckBackCovered(detected, {
      scheduleWakeup: armedWakeup,
      backgroundJob: armedBackgroundJob,
    })) {
      const { reason, prompt } = buildCheckBackWakeup(detected);
      const res = scheduleWakeup({
        ...wakeupCtx,
        schedulingDepth: wakeupCtx.depth,
        delaySeconds: detected.delaySeconds,
        reason,
        prompt,
      });
      try {
        console.info(
          "[marvin.telemetry] " +
            JSON.stringify({
              kind: "checkback.autoarm",
              turnId,
              armed: res.ok,
              delaySeconds: detected.delaySeconds,
              ...(res.ok ? { wakeupId: res.record.id } : { skipped: res.error }),
              at: new Date().toISOString(),
            }),
        );
      } catch {
        /* never break the turn on a telemetry serialisation error */
      }
    }
  }

  // ── Workflow-completion guard (ADR-0057) ───────────────────────────────
  // If a successful turn emitted the scope-met marker but left plan items open
  // or an ADR's Scope of Done entirely unmarked, fire a corrective turn that
  // forces an HONEST reconciliation (mark what's done; retract what isn't).
  if (!resultError && wakeupCtx && hasScopeMet(finalAssistantText)) {
    const untickedAdrs: string[] = [];
    for (const p of editedAdrPaths) {
      try {
        if (scopeOfDoneEntirelyUnticked(readFileSync(p, "utf8"))) untickedAdrs.push(basename(p));
      } catch {
        /* unreadable (deleted / moved) — skip */
      }
    }
    // Plan-item signal: trust THIS turn's TodoWrite when present (no lag). Only
    // when the turn emitted no TodoWrite — so the plan didn't advance and the
    // debounced-PUT plan-state can't be racily stale — fall back to the
    // persisted spine (ADR-0057, closing the terminal-turn gap). readPlanState
    // returns null on a mismatched key, so the fallback degrades to no-op.
    let openPlanItems: string[];
    if (lastTodoPayload !== undefined) {
      openPlanItems = openTodos(lastTodoPayload);
    } else {
      const ps = readPlanState(wakeupCtx.projectId, wakeupCtx.marvinSessionId);
      openPlanItems = ps.ok ? openPlanSteps(ps.state) : [];
    }
    // ADR-0100 — advisor conditions are part of the close, not a backlog
    // deposit made 20 minutes earlier. They rode the turn on the design
    // context; here is where the executor is asked for an outcome on each.
    const openConditions = advisorConditionsAtClose;
    const gap: WorkflowGap = {
      openTodos: openPlanItems,
      untickedAdrs,
      openConditions,
    };
    if (hasWorkflowGap(gap)) {
      const { reason, prompt } = buildReconcilePrompt(gap);
      const res = scheduleWakeup({
        ...wakeupCtx,
        schedulingDepth: wakeupCtx.depth,
        delaySeconds: 60,
        reason,
        prompt,
      });
      try {
        console.info(
          "[marvin.telemetry] " +
            JSON.stringify({
              kind: "workflow.reconcile",
              turnId,
              armed: res.ok,
              openTodos: gap.openTodos.length,
              untickedAdrs: gap.untickedAdrs.length,
              ...(res.ok ? { wakeupId: res.record.id } : { skipped: res.error }),
              at: new Date().toISOString(),
            }),
        );
      } catch {
        /* never break the turn on a telemetry serialisation error */
      }
    }
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
