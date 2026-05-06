/**
 * Design hooks — deterministic enforcement of the personality's two most
 * load-bearing workflow rules:
 *
 *   1. **Graphify-first** — before reading source files, query the graph.
 *   2. **Advisor-on-ADR-trigger** — before editing files in security /
 *      schema / CI / migration paths, fire an advisor consult.
 *
 * Why hooks instead of relying on the personality alone: long system prompts
 * thin out sonnet's attention to specific rules; even the trimmed personality
 * can't guarantee adherence on every turn. The runtime can.
 *
 * Each hook returns a `PermissionResult { behavior: "deny", message }`
 * when a rule fires. The deny message is structured as a hint to the
 * model — it sees the message as a tool_result and adjusts its next
 * tool call. This is the same mechanism the SDK uses for the safety
 * floor; we layer workflow enforcement on top.
 *
 * Enforcement level is controlled by `MARVIN_DESIGN_HOOKS`:
 *   - `enforce` (default) — deny when a rule fires.
 *   - `measure` — log to the auto-audit but allow the call.
 *   - `off`            — hooks are no-ops.
 *
 * Per-turn state lives in a Map keyed by `turnId`, cleared via
 * `clearTurnDesignContext`. /api/chat calls that on `turn.completed` /
 * `turn.error` so the in-memory state matches the SDK's own per-turn
 * lifecycle.
 */

import { existsSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/**
 * Hooks only ever return a deny PermissionResult (or null). We narrow the
 * union here so callers don't need to type-narrow in the deny branch when
 * reading `.message` for audit logging.
 */
export type DesignHookDeny = Extract<PermissionResult, { behavior: "deny" }>;

export type DesignHooksMode = "enforce" | "measure" | "off";

export interface DesignTurnContext {
  turnId: string;
  cwd: string;
  /** True if the project has `<cwd>/graphify-out/graph.json` at turn start. */
  hasGraph: boolean;
  /** Number of graph_* MCP tool calls allowed so far. */
  graphCallCount: number;
  /** Number of advisor Task subagents fired so far. */
  advisorCallCount: number;
  /** Number of source-file reads allowed so far (excluding the first deny). */
  sourceFilesRead: number;
  /** Has the graphify-first hook already fired-and-blocked once? Once it
   *  fires, the model gets the hint; we don't keep blocking subsequent
   *  reads in the same turn even if the graph stays unqueried — that
   *  becomes a measurement signal, not a wall. */
  graphifyHookFired: boolean;
  /** Has the advisor-on-ADR hook already fired-and-blocked once for this
   *  same target path? Same logic — first deny carries the steering
   *  signal, subsequent calls don't keep tripping. */
  advisorHookFiredForPaths: Set<string>;
}

/** Resolve enforcement level from env, exported so tests can pin it. */
export function readDesignHooksMode(): DesignHooksMode {
  const v = process.env.MARVIN_DESIGN_HOOKS?.trim().toLowerCase();
  if (v === "off" || v === "measure" || v === "enforce") return v;
  return "enforce";
}

/** Source file extensions that the graphify-first rule applies to. The
 *  rule is about *structural* reads — config / docs / data files don't
 *  trigger graph-first because they're not what the graph indexes. */
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".swift",
  ".py",
  ".go",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".java",
  ".kt",
  ".kts",
  ".rb",
  ".ex",
  ".exs",
  ".cs",
  ".m",
  ".mm",
]);

/** Filename suffixes / patterns that should NOT trigger advisor-on-ADR
 *  even if they match a trigger path. Tests are exempt — touching
 *  `auth.test.ts` doesn't change auth behavior. */
const ADR_TRIGGER_EXEMPT_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".test.js",
  ".test.jsx",
  ".spec.ts",
  ".spec.tsx",
  ".spec.js",
  ".spec.jsx",
  "_test.go",
  "_test.py",
  "test_",
];

/** Path patterns that warrant an advisor consult before mutation.
 *  Aligned with the personality's deterministic ADR triggers. */
const ADR_TRIGGER_PATTERNS: ReadonlyArray<{
  /** Regex tested against the relative path (cwd-stripped, forward slashes). */
  regex: RegExp;
  /** Short label for the deny message. */
  label: string;
}> = [
  { regex: /(^|\/)auth(\/|\.)/, label: "auth surface" },
  { regex: /(^|\/)login(\/|\.)/, label: "auth/login surface" },
  { regex: /(^|\/)session(\/|\.)/, label: "session/auth surface" },
  { regex: /(^|\/)credentials?(\/|\.)/, label: "credentials surface" },
  { regex: /(^|\/)migrations?\//, label: "DB migration" },
  { regex: /(^|\/)schema(\/|\.|$)/, label: "schema definition" },
  { regex: /(^|\/)\.github\/workflows\//, label: "CI workflow" },
  { regex: /(^|\/)Dockerfile($|\.)/i, label: "container image" },
  { regex: /(^|\/)docker-compose/i, label: "container orchestration" },
  { regex: /(^|\/)policy(\/|\.|$)/, label: "policy / permission surface" },
  { regex: /(^|\/)permission/, label: "permission surface" },
  { regex: /\.sql$/i, label: "SQL/migration file" },
];

const turnContexts = new Map<string, DesignTurnContext>();

/** Create + register a fresh turn context. Called once per /api/chat. */
export function createTurnDesignContext(
  turnId: string,
  cwd: string,
): DesignTurnContext {
  const graphPath = join(cwd, "graphify-out", "graph.json");
  const ctx: DesignTurnContext = {
    turnId,
    cwd,
    hasGraph: existsSync(graphPath),
    graphCallCount: 0,
    advisorCallCount: 0,
    sourceFilesRead: 0,
    graphifyHookFired: false,
    advisorHookFiredForPaths: new Set(),
  };
  turnContexts.set(turnId, ctx);
  return ctx;
}

/** Free per-turn state. /api/chat calls this on turn.completed / turn.error. */
export function clearTurnDesignContext(turnId: string): void {
  turnContexts.delete(turnId);
}

/** Read-only accessor for tests + diagnostics. */
export function getTurnDesignContext(
  turnId: string,
): DesignTurnContext | undefined {
  return turnContexts.get(turnId);
}

/** Update tracking after a tool was allowed. Inspect the tool name +
 *  input to decide what to record. Called from the canUseTool wrapper
 *  on the allow branch. */
export function recordAllowedTool(
  ctx: DesignTurnContext,
  toolName: string,
  toolInput: Record<string, unknown>,
): void {
  if (toolName.startsWith("mcp__marvin-graph__")) {
    ctx.graphCallCount += 1;
    return;
  }
  if (toolName === "Task") {
    const description =
      typeof toolInput.description === "string" ? toolInput.description : "";
    if (description.trim().toLowerCase().startsWith("advisor:")) {
      ctx.advisorCallCount += 1;
    }
    return;
  }
  if (toolName === "Read") {
    const target = pickPath(toolInput, ["file_path", "path"]);
    if (target && isSourceFile(target) && isInsideCwd(ctx.cwd, target)) {
      ctx.sourceFilesRead += 1;
    }
  }
}

/**
 * Run the design hooks for a tool call. Returns a PermissionResult to
 * override the inner canUseTool decision, or `null` when the design
 * rules don't apply.
 *
 * Called BEFORE the inner canUseTool so a deny short-circuits without
 * consulting the policy classifier.
 */
export function runDesignHooks(args: {
  ctx: DesignTurnContext;
  toolName: string;
  toolInput: Record<string, unknown>;
  mode: DesignHooksMode;
}): DesignHookDeny | null {
  const { ctx, toolName, toolInput, mode } = args;
  if (mode === "off") return null;

  // Hook 1 — graphify-first.
  const graphifyDeny = checkGraphifyFirst(ctx, toolName, toolInput);
  if (graphifyDeny) {
    if (mode === "measure") {
      // Caller is responsible for logging; we just don't deny.
    } else {
      ctx.graphifyHookFired = true;
      return graphifyDeny;
    }
  }

  // Hook 2 — advisor-on-ADR-trigger.
  const advisorDeny = checkAdvisorOnAdrTrigger(ctx, toolName, toolInput);
  if (advisorDeny) {
    if (mode === "measure") {
      // Caller logs; allow the call.
    } else {
      const path = pickPath(toolInput, ["file_path", "path"]);
      if (path) ctx.advisorHookFiredForPaths.add(path);
      return advisorDeny;
    }
  }

  return null;
}

/** Returns the deny PermissionResult when the graphify-first rule should
 *  fire, otherwise null. Pure — does not mutate ctx. */
function checkGraphifyFirst(
  ctx: DesignTurnContext,
  toolName: string,
  toolInput: Record<string, unknown>,
): DesignHookDeny | null {
  if (!ctx.hasGraph) return null;
  if (ctx.graphifyHookFired) return null;
  if (ctx.graphCallCount > 0) return null;
  if (ctx.sourceFilesRead > 0) return null;
  if (toolName !== "Read") return null;
  const target = pickPath(toolInput, ["file_path", "path"]);
  if (!target) return null;
  if (!isInsideCwd(ctx.cwd, target)) return null;
  if (!isSourceFile(target)) return null;
  return {
    behavior: "deny",
    message:
      "graphify-first: this is the first source-file read of the turn and " +
      "the graph hasn't been queried yet. Call " +
      "`mcp__marvin-graph__graph_search` with a relevant query first, then " +
      "re-Read the file the graph points at. Graph queries before source " +
      "reads is a non-negotiable rule (personality §Graphify protocol). " +
      "If the graph genuinely doesn't cover what you need, call " +
      "`graph_search` with a near-miss query so the rule is satisfied, " +
      "then proceed with grep / glob. (To bypass these hooks for an " +
      "approved exception, the user can set MARVIN_DESIGN_HOOKS=measure.)",
    interrupt: false,
  };
}

/** Returns the deny PermissionResult when the advisor-on-ADR-trigger rule
 *  should fire, otherwise null. Pure — does not mutate ctx. */
function checkAdvisorOnAdrTrigger(
  ctx: DesignTurnContext,
  toolName: string,
  toolInput: Record<string, unknown>,
): DesignHookDeny | null {
  if (toolName !== "Edit" && toolName !== "Write") return null;
  if (ctx.advisorCallCount > 0) return null;
  const target = pickPath(toolInput, ["file_path", "path"]);
  if (!target) return null;
  if (ctx.advisorHookFiredForPaths.has(target)) return null;
  if (isExemptFromAdrTriggers(target)) return null;
  const triggerLabel = matchAdrTrigger(ctx.cwd, target);
  if (!triggerLabel) return null;
  return {
    behavior: "deny",
    message:
      `advisor-on-ADR-trigger: the target path matches the "${triggerLabel}" ` +
      "ADR trigger pattern, and no advisor consult has fired this turn. " +
      "Spawn a Task subagent first:\n\n" +
      "    tool_use Task:\n" +
      '      subagent_type: "general-purpose"\n' +
      '      model:          "opus"\n' +
      '      description:    "advisor: <one-line topic>"\n' +
      "      prompt: |\n" +
      "        You are an advisor consulted by MARVIN's executor on a hard\n" +
      "        step. Be blunt. Structure: ## Risks / ## Alternatives /\n" +
      "        ## Pushback / ## Verdict (go|go-with-caveats|reject).\n" +
      "        Full context: <PASTE_PLAN_OR_DIFF>\n\n" +
      "Then cite the advisor's substantive input in your reply and apply " +
      "the edit. Personality §Advisor protocol requires this for ADR-trigger " +
      "paths. (Bypass with MARVIN_DESIGN_HOOKS=measure if the user has " +
      "explicitly approved an exception.)",
    interrupt: false,
  };
}

/** Read a string field by candidate keys; returns absolute path normalised
 *  with forward slashes. */
function pickPath(
  input: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Check whether `target` is a regular source file (by extension). */
export function isSourceFile(target: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(extname(target).toLowerCase());
}

/** Check whether `target` resolves to a path inside `cwd`. Tolerates
 *  relative paths by treating them as relative to cwd. */
export function isInsideCwd(cwd: string, target: string): boolean {
  const abs = isAbsolute(target) ? target : join(cwd, target);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // Also treat empty string as inside (target === cwd).
  return true;
}

/** Match a path against the ADR trigger list. Returns the trigger label
 *  on first match, or null. */
export function matchAdrTrigger(cwd: string, target: string): string | null {
  const abs = isAbsolute(target) ? target : join(cwd, target);
  const rel = relative(cwd, abs).split(sep).join("/");
  for (const { regex, label } of ADR_TRIGGER_PATTERNS) {
    if (regex.test(rel)) return label;
  }
  return null;
}

/** Tests / specs / mock files don't change runtime behavior — they
 *  shouldn't gate on advisor consults even if their paths look load-
 *  bearing. */
export function isExemptFromAdrTriggers(target: string): boolean {
  const lower = target.toLowerCase();
  for (const suffix of ADR_TRIGGER_EXEMPT_SUFFIXES) {
    if (lower.endsWith(suffix) || lower.includes(`/${suffix}`)) return true;
  }
  // Also exempt files inside dedicated test directories.
  if (
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    lower.includes("/test/") ||
    lower.includes("/spec/")
  ) {
    return true;
  }
  return false;
}
