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

import type {
  HookCallback,
  HookJSONOutput,
  PermissionResult,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { appendAutoAuditEntry, type AutoAuditEntryKind } from "./auto-audit";

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
  /** ADR-0060 — source files ALREADY seen this turn. Re-reading one of
   *  these is *work* (editing a file you already located), not exploration,
   *  so it must never re-trip the graph rule. */
  seenSourceFiles: Set<string>;
  /** ADR-0060 — NOVEL source files opened since the last graph call. This is
   *  the drift signal: reading files you've never touched, in areas the graph
   *  could have pointed at. Reset to 0 by any graph call. */
  novelFilesSinceGraph: number;
  /** ADR-0060 addendum 2 — novel reads currently CHARGED to the drift budget
   *  and not yet refunded. Tracked so an Edit/Write can refund exactly once.
   *  Cleared alongside the budget on a graph call. */
  chargedFiles: Set<string>;
  /** Diagnostic counters for `graph.turn.summary`: how many novel reads were
   *  charged, and how many were refunded as implementation. */
  driftCharges: number;
  driftRefunds: number;
  /** ADR-0060 — how many drift nudges have fired this turn (capped, so a long
   *  legitimate implementation turn can't be nagged repeatedly). */
  graphifyNudgeCount: number;
}

/** ADR-0060 — novel source files that may be opened after the last graph call
 *  before the drift nudge fires. Tuned from measured sessions: real drift ran
 *  15-40 unguided reads, while a legitimate implementation burst rarely opens
 *  more than a handful of *previously unseen* files without re-orienting. */
export const GRAPH_DRIFT_NOVEL_FILE_THRESHOLD = 7;

/** ADR-0060 — max drift nudges per turn. The nudge is advisory and cheap, but
 *  repeating it every 7 files in an 80-op turn would become noise the model
 *  learns to skip. */
export const GRAPH_DRIFT_MAX_NUDGES = 3;

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
    seenSourceFiles: new Set<string>(),
    novelFilesSinceGraph: 0,
    chargedFiles: new Set<string>(),
    driftCharges: 0,
    driftRefunds: 0,
    graphifyNudgeCount: 0,
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
    // ADR-0060 — re-orienting clears the drift budget. The rule isn't "query
    // the graph N times", it's "don't explore blind for long stretches".
    ctx.novelFilesSinceGraph = 0;
    ctx.chargedFiles.clear();
    return;
  }

  // ADR-0060 addendum 2 — IMPLEMENTATION REFUND.
  //
  // Measured on a real implementation-heavy session (2026-07-25): of 49 novel
  // source reads, 20 were files MARVIN went on to Edit/Write. Reading a file
  // you are about to change is correct behaviour, not blind exploration — but
  // at Read time it is indistinguishable from drift, since the Edit hasn't
  // happened yet. `seenSourceFiles` only exempts RE-reads, so those 20 first
  // reads were charged to the drift budget and inflated the signal ~40 %.
  //
  // Fix retroactively: when a charged file is mutated, refund it. The budget
  // then reflects only reads that never became edits — actual orientation,
  // which is the graph's job. This is why escalating to a mid-turn hard deny
  // would have been wrong: it would have blocked real implementation reads.
  if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
    const target = pickPath(toolInput, ["file_path", "notebook_path", "path"]);
    if (target && ctx.chargedFiles.has(target)) {
      ctx.chargedFiles.delete(target);
      ctx.novelFilesSinceGraph = Math.max(0, ctx.novelFilesSinceGraph - 1);
      ctx.driftRefunds += 1;
    }
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
      // ADR-0060 — only a file we have NOT seen this turn counts as drift.
      // Re-reading a file already in play is implementation work; charging it
      // to the drift budget would nag during exactly the phase where reading
      // is correct.
      if (!ctx.seenSourceFiles.has(target)) {
        ctx.seenSourceFiles.add(target);
        ctx.novelFilesSinceGraph += 1;
        // Charged — refundable if this turns out to be a read-before-edit.
        ctx.chargedFiles.add(target);
        ctx.driftCharges += 1;
      }
    }
    return;
  }
  // Grep / Glob count toward the same "first structural search" tally so
  // the hook stays one-shot per turn whichever tool the model reaches for.
  if (toolName === "Grep" || toolName === "Glob") {
    const path =
      pickPath(toolInput, ["path"]) ??
      (typeof toolInput.pattern === "string" ? toolInput.pattern : null) ??
      ctx.cwd;
    if (isInsideCwd(ctx.cwd, path)) {
      ctx.sourceFilesRead += 1;
      // A project-tree Grep/Glob IS unguided exploration — the "grep and pray"
      // the rule targets — so it always charges the drift budget. Keyed by
      // pattern so repeating the same search doesn't double-charge.
      const key = `${toolName}:${typeof toolInput.pattern === "string" ? toolInput.pattern : path}`;
      if (!ctx.seenSourceFiles.has(key)) {
        ctx.seenSourceFiles.add(key);
        ctx.novelFilesSinceGraph += 1;
        ctx.driftCharges += 1;
        // Deliberately NOT added to chargedFiles: a search has no file to edit,
        // so it can never be refunded as implementation. Searching the tree IS
        // the exploration the rule targets.
      }
    }
  }
}

/**
 * ADR-0060 — the graph-drift nudge.
 *
 * The graphify-first hook (`checkGraphifyFirst`) is a ONE-SHOT gate at the head
 * of a turn: one graph call sets `graphCallCount > 0` and disarms it for the
 * whole turn. Measured on four real sessions (2026-07-24), that meant graph
 * calls clustered in the first half and the back 40-50 % of every session was
 * pure grep-and-read — 1 graph call per 5-11 file ops, the exact "grep and
 * pray" the rule exists to eliminate. The gate was designed when turns were
 * short; agentic turns now run 30-80 tool calls.
 *
 * This re-arms enforcement WITHOUT the false-positive cost of blocking
 * implementation. Two deliberate asymmetries:
 *
 *   - **Novel files only.** Re-reading a file already open this turn is work,
 *     not exploration, and never counts. The graph helps you FIND code; it
 *     doesn't help you WRITE it.
 *   - **Nudge, not deny.** The turn's first violation still hard-denies
 *     (`checkGraphifyFirst` — it demonstrably works, it's why early graph calls
 *     exist at all). Everything after is advisory `additionalContext`, so a
 *     false positive costs a sentence of context, never a blocked tool call.
 *
 * Returns the nudge text, or null when no nudge is due. Pure except for the
 * nudge counter, which it bumps so the cap holds. Exported for tests.
 */
export function checkGraphDrift(
  ctx: DesignTurnContext,
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (!ctx.hasGraph) return null;
  if (ctx.graphifyNudgeCount >= GRAPH_DRIFT_MAX_NUDGES) return null;
  if (ctx.novelFilesSinceGraph < GRAPH_DRIFT_NOVEL_FILE_THRESHOLD) return null;

  // Only nudge on a structural tool — never interrupt an Edit/Write/Bash.
  if (toolName !== "Read" && toolName !== "Grep" && toolName !== "Glob") return null;
  if (toolName === "Read") {
    const target = pickPath(toolInput, ["file_path", "path"]);
    if (!target || !isSourceFile(target) || !isInsideCwd(ctx.cwd, target)) return null;
    // A file already in play is work — don't nudge on it.
    if (ctx.seenSourceFiles.has(target)) return null;
  }

  ctx.graphifyNudgeCount += 1;
  const n = ctx.novelFilesSinceGraph;
  return (
    `[graphify drift — advisory, your call] You have opened ${n} previously ` +
    `unseen source files/searches since your last graph query. If you are ` +
    `IMPLEMENTING against files you already located, ignore this and carry on. ` +
    `If you are still LOCATING things — asking where something lives, who calls ` +
    `it, or what a change would touch — a \`mcp__marvin-graph__\` query ` +
    `(graph_search / graph_neighbors / graph_query) answers that in a few ` +
    `hundred tokens instead of thousands per file, and catches couplings a ` +
    `grep cannot see. Golden Rule 7.`
  );
}

/**
 * Build a PreToolUse hook callback for the SDK's `Options.hooks` config.
 *
 * Why a PreToolUse hook instead of `canUseTool`: with `permissionMode:
 * "default"`, the SDK auto-allows tools it considers safe (Read / Grep /
 * Glob) WITHOUT consulting `canUseTool`. The earlier wiring put design
 * hooks inside the canUseTool wrapper, so they only fired on Edit /
 * Write / Bash — Read / Grep / Glob slipped through. PreToolUse fires on
 * EVERY tool call regardless of permission classification, which is what
 * graphify-first needs.
 *
 * Returns `permissionDecision: "deny"` when a rule fires, otherwise an
 * empty output (the SDK falls through to its normal allow path or
 * canUseTool for gated tools).
 */
/**
 * Emit a design-hook event on the `[marvin.telemetry]` channel (ADR-0060
 * follow-up). Goes to the sidecar log, which is readable at
 * `~/Library/Logs/MARVIN/sidecar.log` — the same channel ADR-0055/0057 use, and
 * deliberately NOT `appendAutoAuditEntry`, which drops every non-mutator tool.
 * Never throws: observability must not be able to break a turn.
 */
function logDesignHookEvent(fields: Record<string, unknown>): void {
  try {
    console.info(
      "[marvin.telemetry] " + JSON.stringify({ ...fields, at: new Date().toISOString() }),
    );
  } catch {
    /* never break a turn on a telemetry serialisation error */
  }
}

/**
 * One-line, end-of-turn summary of graph-vs-file behaviour (ADR-0060 follow-up).
 *
 * The per-fire lines above say whether a guard fired; this says what the turn
 * actually DID, so the graph:file ratio can be read straight from the log
 * instead of reconstructed from session transcripts. Call once per turn from
 * the runner. Safe to call with a context that never saw a structural tool.
 */
export function logDesignTurnSummary(ctx: DesignTurnContext): void {
  if (!ctx.hasGraph && ctx.sourceFilesRead === 0 && ctx.graphCallCount === 0) return;
  // `exploreOps` is the number that actually matters: drift charges MINUS the
  // reads that turned out to be implementation. The first reading of this log
  // (1 graph : 17.5 "file ops") was misleading precisely because it lumped
  // implementation reads and non-source reads in with orientation. Reporting
  // charges/refunds/exploreOps separately makes the exploration-only ratio —
  // graphCalls : exploreOps — readable straight from the line.
  const exploreOps = Math.max(0, ctx.driftCharges - ctx.driftRefunds);
  logDesignHookEvent({
    kind: "graph.turn.summary",
    turnId: ctx.turnId,
    hasGraph: ctx.hasGraph,
    graphCalls: ctx.graphCallCount,
    // Drift-relevant only: source-file reads + project-tree searches. Never
    // .md / .sql / .yaml — the code graph doesn't index those, so they are not
    // reads the graph could have replaced.
    driftOps: ctx.sourceFilesRead,
    driftCharges: ctx.driftCharges,
    implRefunds: ctx.driftRefunds,
    exploreOps,
    exploreRatio:
      ctx.graphCallCount > 0
        ? Math.round((exploreOps / ctx.graphCallCount) * 10) / 10
        : null,
    novelFilesAtEnd: ctx.novelFilesSinceGraph,
    nudges: ctx.graphifyNudgeCount,
    denied: ctx.graphifyHookFired,
  });
}

export function makeDesignHooksPreToolUse(args: {
  cwd: string;
  turnId: string;
  designCtx: DesignTurnContext;
}): HookCallback {
  const { cwd, turnId, designCtx } = args;
  const mode = readDesignHooksMode();
  return async (input, toolUseId) => {
    if (input.hook_event_name !== "PreToolUse") return {} as HookJSONOutput;
    const evt = input as PreToolUseHookInput;
    const safeInput =
      evt.tool_input && typeof evt.tool_input === "object" && !Array.isArray(evt.tool_input)
        ? (evt.tool_input as Record<string, unknown>)
        : {};
    const designDeny = runDesignHooks({
      ctx: designCtx,
      toolName: evt.tool_name,
      toolInput: safeInput,
      mode,
    });
    if (designDeny) {
      // Observability (ADR-0060 follow-up). NOTE: `appendAutoAuditEntry` early-
      // returns for anything outside Edit/Write/Bash, and the design hooks fire
      // on Read/Grep/Glob — so this call has ALWAYS been a silent no-op and the
      // whole design-hooks feature was unobservable. Kept (harmless, and it does
      // record if a mutator ever trips a rule), but the telemetry line below is
      // the one that actually lands, in the sidecar log, matching the
      // `[marvin.telemetry]` channel ADR-0055/0057 use.
      appendAutoAuditEntry(cwd, {
        tool: evt.tool_name as AutoAuditEntryKind,
        reason: `design-hook deny: ${designDeny.message?.split(":")[0] ?? "rule"}`,
        input: safeInput,
        turnId,
        toolUseId: toolUseId ?? evt.tool_use_id ?? "unknown",
      });
      logDesignHookEvent({
        kind: "designhook.deny",
        turnId,
        tool: evt.tool_name,
        graphCallCount: designCtx.graphCallCount,
        sourceFilesRead: designCtx.sourceFilesRead,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: designDeny.message ?? "design-hook deny",
        },
      } as HookJSONOutput;
    }
    // ADR-0060 — graph-drift nudge. Checked BEFORE recording the tool so the
    // count reflects the drift that led here, and emitted as non-blocking
    // `additionalContext`: the call proceeds either way.
    const drift = mode === "enforce" ? checkGraphDrift(designCtx, evt.tool_name, safeInput) : null;

    // No design-hook deny — record the tool as allowed-from-our-POV so
    // state advances. (canUseTool may still deny for safety reasons; if
    // it does, recordAllowedTool was a slight over-count, but that only
    // delays — never silences — a future hook firing.)
    recordAllowedTool(designCtx, evt.tool_name, safeInput);

    if (drift) {
      // The nudge is injected as context, which leaves NO trace in the session
      // transcript — so without this line there is no way to tell "the nudge
      // fired and was ignored" (→ escalate) from "the nudge never fired"
      // (→ fix a bug). Those need opposite responses; ADR-0060's empirical
      // follow-up is unanswerable without it.
      logDesignHookEvent({
        kind: "graph.drift.nudge",
        turnId,
        tool: evt.tool_name,
        novelFilesSinceGraph: designCtx.novelFilesSinceGraph,
        nudgeCount: designCtx.graphifyNudgeCount,
        graphCallCount: designCtx.graphCallCount,
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: drift,
        },
      } as HookJSONOutput;
    }
    return {} as HookJSONOutput;
  };
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
 *  fire, otherwise null. Pure — does not mutate ctx.
 *
 *  Covers Read / Grep / Glob — the personality's rule applies to all three
 *  ("Read / Grep / Glob on any source file for a structural question").
 *  Earlier this hook only intercepted Read, so the model could slip through
 *  by calling Grep first — the exact "grep and pray" failure mode the rule
 *  exists to eliminate. */
function checkGraphifyFirst(
  ctx: DesignTurnContext,
  toolName: string,
  toolInput: Record<string, unknown>,
): DesignHookDeny | null {
  if (!ctx.hasGraph) return null;
  if (ctx.graphifyHookFired) return null;
  if (ctx.graphCallCount > 0) return null;
  if (ctx.sourceFilesRead > 0) return null;

  let triggered: { kind: "Read" | "Grep" | "Glob"; target: string } | null = null;
  if (toolName === "Read") {
    const target = pickPath(toolInput, ["file_path", "path"]);
    if (target && isInsideCwd(ctx.cwd, target) && isSourceFile(target)) {
      triggered = { kind: "Read", target };
    }
  } else if (toolName === "Grep") {
    // Grep input: { pattern, path?, glob?, output_mode?, ... }. Default
    // path = cwd when omitted. Apply the rule when the search root is in
    // cwd — structural exploration of the project tree.
    const path =
      pickPath(toolInput, ["path"]) ??
      (typeof toolInput.glob === "string" ? toolInput.glob : null) ??
      ctx.cwd;
    if (isInsideCwd(ctx.cwd, path)) {
      triggered = { kind: "Grep", target: path };
    }
  } else if (toolName === "Glob") {
    // Glob input: { pattern, path? }. The pattern is often a path glob
    // ("**/*.ts"). When the path is omitted, the search root defaults
    // to cwd. Fire if the search lands inside cwd.
    const path = pickPath(toolInput, ["path"]) ?? ctx.cwd;
    const pattern = typeof toolInput.pattern === "string" ? toolInput.pattern : "";
    // Treat a Glob *anywhere* inside cwd as structural — the model
    // should orient via the graph first regardless of the glob shape.
    if (isInsideCwd(ctx.cwd, path) || isInsideCwd(ctx.cwd, pattern)) {
      triggered = { kind: "Glob", target: pattern || path };
    }
  }

  if (!triggered) return null;
  return {
    behavior: "deny",
    message:
      `graphify-first: ${triggered.kind} on \`${truncate(triggered.target, 80)}\` ` +
      "would be the first structural search of this turn, and the graph " +
      "hasn't been queried yet. Call " +
      "`mcp__marvin-graph__graph_search` (or `graph_summary` to orient) " +
      "FIRST, then come back with the file the graph points at. The " +
      "personality's Graphify protocol is non-negotiable for any " +
      "structural exploration: graph before Read / Grep / Glob. " +
      "If the graph genuinely doesn't cover what you need, run " +
      "`graph_search` with a near-miss query so the rule is satisfied, " +
      "then fall back to grep / glob. (Set MARVIN_DESIGN_HOOKS=measure " +
      "to bypass for an approved exception.)",
    interrupt: false,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
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
