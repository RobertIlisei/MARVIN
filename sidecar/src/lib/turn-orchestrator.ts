/**
 * Shared turn-dispatch orchestration.
 *
 * `runDetachedTurn` is the inner loop that used to live inline in
 * `POST /api/chat` (`runAgentDetached`). It runs the SDK to completion
 * regardless of HTTP-request lifecycle, pumping events to BOTH the on-disk
 * transcript and the in-memory `turn-registry` bus, then records cost and
 * ends the live turn.
 *
 * Extracting it lets a **self-scheduled wakeup** (ADR-0031) start a real
 * turn through the exact same path the chat route uses — no duplicated
 * cost / session / registry wiring to drift. `startScheduledTurn` is the
 * wakeup entry point: it rebuilds the system prompt + project context,
 * registers a live turn, and dispatches.
 */

import { randomUUID } from "node:crypto";
import { buildProjectContext } from "@marvin/project-context";
import { recordTurnCost, pollOpenRouterBalance } from "@marvin/runtime/cost-tracker";
import { readAuthConfig } from "@marvin/runtime/auth-config";
import { calculateEstimatedCost } from "@marvin/runtime/models";
import { buildSystemPrompt, type PersonalityMode } from "@marvin/runtime/personality";
import { formatActiveSkillsBlock } from "@marvin/runtime/skill-enablement";
import { slugifyWorkDir, touchProject } from "@marvin/runtime/projects";
import { practicePromptBlock } from "@marvin/runtime/practice";
import {
  type AgentMode,
  type PermissionStrategy,
  clampEffort,
  runAgent,
} from "@marvin/runtime/sdk-runner";
import {
  appendSessionTurn,
  lastSdkSessionId,
  rememberSdkSessionId,
} from "@marvin/runtime/session";
import {
  type LiveTurn,
  emitTurnEvent,
  endLiveTurn,
  getLiveTurn,
  registerLiveTurn,
} from "@marvin/runtime/turn-registry";
import {
  drainPending,
  enqueuePending,
  renderPendingPrompt,
} from "@marvin/runtime/pending-input";
import { TurnInputChannel } from "@marvin/runtime/turn-input";
import {
  autoContinueDelaySeconds,
  autoContinuePrompt,
  classifyTurnError,
  MAX_AUTO_CONTINUES,
} from "@marvin/runtime/transient-errors";
import {
  deferIfSessionBusy,
  noteMachineTurnStarted,
  scheduleWakeup,
  setWakeupFireHandler,
  type WakeupRecord,
} from "@marvin/runtime/wakeup-scheduler";

/**
 * The `append` half of the SDK system prompt, built the SAME way for every
 * path that starts a turn — the chat route, a fired wakeup, a drained queue.
 *
 * One builder, because the prompt is the cache prefix. Measured on session
 * 8927baf0 (2026-09-02, ~650–870K tokens of context): the wakeup path built
 * personality + project context while the chat route built personality +
 * project context + active-skills block, so every human↔wakeup transition
 * re-created the whole cache — 7 of the 12 full re-creations that session,
 * ~$2.50–3 each for turns that emitted a hundred output tokens. The
 * remaining misses are the Claude Code preset's own per-process git-status
 * snapshot, which MARVIN cannot pin from outside.
 */
export async function buildTurnSystemPrompt(args: {
  cwd: string;
  personality: PersonalityMode;
  firstMessage: boolean;
  skipProjectContext?: boolean | undefined;
}): Promise<string> {
  const systemPrompt = buildSystemPrompt(args.personality);
  const projectContext = args.skipProjectContext
    ? ""
    : (
        await buildProjectContext({ workDir: args.cwd, firstMessage: args.firstMessage }).catch(
          () => ({ text: "", breakdown: [] }),
        )
      ).text;
  // ADR-0037 — name the skills ACTIVE for this project so the model stops
  // reaching for the (always-loaded) irrelevant ones. Best-effort; never
  // block a turn on skill enablement.
  let activeSkillsBlock = "";
  try {
    activeSkillsBlock = formatActiveSkillsBlock(args.cwd);
  } catch {
    /* best-effort */
  }
  // ADR-0105 — prompt-tier practice rules the user accepted for this project.
  // Stable across turns (it only changes when a rule is edited), so it does
  // not disturb the cache prefix the builder exists to protect.
  let practiceBlock = "";
  try {
    practiceBlock = practicePromptBlock(slugifyWorkDir(args.cwd));
  } catch {
    /* best-effort */
  }
  return [systemPrompt, projectContext, activeSkillsBlock, practiceBlock].filter(Boolean).join("\n\n");
}

export interface DetachedTurnParams {
  liveTurn: LiveTurn;
  projectId: string;
  marvinSessionId: string;
  turnId: string;
  message: string;
  cwd: string;
  model: string;
  advisorModel?: string | undefined;
  permissionStrategy: PermissionStrategy;
  /** Opt-in Playwright MCP browser server for this turn (ADR-0045). */
  playwrightEnabled?: boolean;
  /** Autonomy mode (ADR-0036); defaults to `agent` in runAgent when omitted. */
  mode?: AgentMode | undefined;
  thinkingMode: string;
  /** Advisor-specific effort (ADR-0033); undefined = follow the executor. */
  advisorThinkingMode?: string | undefined;
  sessionId?: string | undefined;
  appendSystemPrompt: string;
  personality: "marvin" | "neutral" | "ultron";
  /** ADR-0051 — live active-plan snapshot, injected into the SDK prompt as a
   *  `<system-reminder>` suffix so the model stays plan-aware. Not persisted. */
  planContext?: string | undefined;
  /** Depth of this turn in a wakeup chain (0 = human-started). ADR-0031. */
  wakeupDepth?: number;
}

interface AutoContinueParams {
  error: string;
  projectId: string;
  marvinSessionId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral" | "ultron";
  permissionStrategy: PermissionStrategy;
  playwrightEnabled?: boolean;
  thinkingMode: string;
  advisorThinkingMode?: string | undefined;
  wakeupDepth: number;
}

/**
 * Re-enter the session after a TRANSPORT failure — never after a real one.
 *
 * Scheduling through the existing wakeup scheduler is deliberate: ADR-0031
 * already bounds self-continuation (pending cap per session, re-schedule depth,
 * chain depth, unchanged permission posture). A bespoke retry loop here would
 * duplicate that and escape those rails.
 *
 * `MAX_AUTO_CONTINUES` bounds the causal chain on top of that, so a sustained
 * outage stops and reports instead of retrying unattended all night.
 */
function maybeAutoContinue(p: AutoContinueParams): void {
  const verdict = classifyTurnError(p.error);
  const attempt = p.wakeupDepth + 1;
  const give_up = attempt > MAX_AUTO_CONTINUES;

  if (!verdict.transient || give_up) {
    // Say why we are NOT retrying — a silent non-retry is indistinguishable
    // from a missing feature when someone reads this log later.
    logAutoContinue({
      projectId: p.projectId,
      decision: "no-retry",
      reason: give_up ? `attempt ${attempt} > cap ${MAX_AUTO_CONTINUES}` : verdict.reason,
      error: p.error.slice(0, 160),
    });
    return;
  }

  const delaySeconds = autoContinueDelaySeconds(p.wakeupDepth);
  const res = scheduleWakeup({
    marvinSessionId: p.marvinSessionId,
    projectId: p.projectId,
    cwd: p.cwd,
    model: p.model,
    advisorModel: p.advisorModel,
    personality: p.personality,
    permissionStrategy: p.permissionStrategy,
    ...(p.playwrightEnabled !== undefined ? { playwrightEnabled: p.playwrightEnabled } : {}),
    thinkingMode: p.thinkingMode,
    ...(p.advisorThinkingMode ? { advisorThinkingMode: p.advisorThinkingMode } : {}),
    delaySeconds,
    reason: `auto-continue after transport error (attempt ${attempt}/${MAX_AUTO_CONTINUES})`,
    prompt: autoContinuePrompt(p.error, attempt),
    schedulingDepth: p.wakeupDepth,
  });

  logAutoContinue({
    projectId: p.projectId,
    decision: res.ok ? "scheduled" : "schedule-failed",
    reason: res.ok ? `${verdict.reason} in ${delaySeconds}s` : res.error,
    error: p.error.slice(0, 160),
  });
}

function logAutoContinue(fields: Record<string, string>): void {
  try {
    console.info(
      "[marvin.telemetry] " +
        JSON.stringify({ kind: "turn.autocontinue", ...fields, at: new Date().toISOString() }),
    );
  } catch {
    /* never break the turn on serialisation */
  }
}

/**
 * Run a turn to completion, decoupled from any HTTP request. Pumps events to
 * the transcript + the live-turn bus, records cost, ends the turn. Never
 * throws — failures land as a `turn.error` terminal event.
 */
export async function runDetachedTurn(params: DetachedTurnParams): Promise<void> {
  const {
    liveTurn,
    projectId,
    marvinSessionId,
    turnId,
    message,
    cwd,
    model,
    advisorModel,
    permissionStrategy,
    playwrightEnabled,
    mode,
    thinkingMode,
    advisorThinkingMode,
    sessionId,
    appendSystemPrompt,
    personality,
    planContext,
    wakeupDepth,
  } = params;

  // ADR-0076 — streaming input: messages POSTed while this turn runs are
  // delivered into it (`liveTurn.inject`) rather than queued behind it.
  const inputChannel = new TurnInputChannel();
  liveTurn.inject = (text) => inputChannel.push(text);

  const result = await runAgent({
    message,
    inputChannel,
    cwd,
    model,
    ...(advisorModel ? { advisorModel } : {}),
    permissionStrategy,
    ...(playwrightEnabled !== undefined ? { playwrightEnabled } : {}),
    ...(mode ? { mode } : {}),
    thinkingMode,
    ...(advisorThinkingMode ? { advisorThinkingMode } : {}),
    ...(planContext ? { planContext } : {}),
    turnId,
    sessionId,
    appendSystemPrompt,
    marvinSessionId,
    projectId,
    personality,
    ...(wakeupDepth !== undefined ? { wakeupDepth } : {}),
    onEvent: (event) => {
      appendSessionTurn(projectId, marvinSessionId, {
        type: "cli.event",
        at: new Date().toISOString(),
        event,
      });
      emitTurnEvent(liveTurn, "cli.event", event);
    },
    onConfirmRequest: (payload) => {
      appendSessionTurn(projectId, marvinSessionId, {
        type: "confirm.request",
        at: new Date().toISOString(),
        payload,
      });
      emitTurnEvent(liveTurn, "confirm.request", payload);
    },
    // ADR-0103 — an implementer finished and its branch is now a
    // deliverable. Persisted like any other turn event so the fact
    // survives a reload: before this, whether the user ever heard about
    // a finished branch depended on the model remembering to say so.
    onWorktreeFinished: (payload) => {
      appendSessionTurn(projectId, marvinSessionId, {
        type: "worktree.finished",
        at: new Date().toISOString(),
        payload,
      });
      emitTurnEvent(liveTurn, "worktree.finished", payload);
    },
    signal: liveTurn.abortController.signal,
  });

  // ADR-0076 — the turn is over; stop accepting input, and hand anything
  // that was accepted but never reached the SDK to the durable queue so
  // the drain below runs it (ADR-0069: no user message is ever lost).
  liveTurn.inject = undefined;
  inputChannel.close();
  for (const text of inputChannel.drainUnconsumed()) {
    enqueuePending(projectId, marvinSessionId, text);
  }

  if (!result.ok) {
    const payload = { error: result.error ?? "Unknown error" };
    appendSessionTurn(projectId, marvinSessionId, {
      type: "turn.error",
      at: new Date().toISOString(),
      error: payload.error,
    });
    // AUTO-CONTINUE ON TRANSPORT FAILURE (ADR-0067). A dropped socket is not a
    // verdict about the work, but it used to end the session as if it were:
    // measured at 5.1 h of dead time across 4 incidents, the longest 4.5 h
    // starting at 01:47 while nobody was awake to notice. Re-enter the session
    // through the EXISTING wakeup scheduler rather than a bespoke retry loop,
    // so ADR-0031's rails (pending cap, depth caps, same permission posture)
    // apply unchanged.
    maybeAutoContinue({
      error: payload.error,
      projectId,
      marvinSessionId,
      cwd,
      model,
      advisorModel: advisorModel ?? null,
      personality,
      permissionStrategy,
      ...(playwrightEnabled !== undefined ? { playwrightEnabled } : {}),
      thinkingMode,
      ...(advisorThinkingMode ? { advisorThinkingMode } : {}),
      wakeupDepth: wakeupDepth ?? 0,
    });
    endLiveTurn(liveTurn, { event: "turn.error", data: payload });
    drainQueuedInput(params);
    return;
  }

  const estimatedCost = await calculateEstimatedCost(model, result.tokenUsage);
  // The SDK's total_cost_usd prices every model off the Claude rate card —
  // for an OpenRouter BYOK model it is fiction (measured ~10× over: a
  // 4.3M-token glm turn recorded $4.21 against ~$0.33 actual). Only fall
  // back to it when Anthropic is the provider; an unpriceable OpenRouter
  // turn records 0 and keeps its tokens — the OpenRouter account block
  // carries the authoritative spend.
  const provider = readAuthConfig()?.provider ?? "anthropic";
  const finalCostUsd =
    estimatedCost ?? (provider === "openrouter" ? null : (result.costUsd ?? null));

  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.completed",
    at: new Date().toISOString(),
    durationMs: result.durationMs ?? null,
    costUsd: finalCostUsd,
    tokenUsage: result.tokenUsage ?? null,
    sessionId: result.sessionId ?? null,
  });
  if (result.sessionId) {
    rememberSdkSessionId(projectId, marvinSessionId, result.sessionId);
  }
  recordTurnCost({
    projectId,
    costUsd: finalCostUsd,
    tokenUsage: result.tokenUsage ?? null,
  });
  // Fire and forget balance poll (ADR-0071: OpenRouter native balance tracking)
  pollOpenRouterBalance().catch(() => {});
  try {
    touchProject(projectId);
  } catch {
    /* project may not be registered (cwd used directly) — fine */
  }
  endLiveTurn(liveTurn, {
    event: "turn.completed",
    data: {
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      costUsd: finalCostUsd,
      tokenUsage: result.tokenUsage,
      marvinSessionId,
      turnId,
    },
  });
  drainQueuedInput(params);
}

/**
 * Run whatever the user queued while this turn held the slot (ADR-0069).
 *
 * Coalesced into ONE follow-up turn: three messages sent while blocked must not
 * become three sequential turns each acting on partial intent, since the later
 * ones routinely supersede the earlier. Fire-and-forget — a failure to drain
 * must never fail the turn that just completed, and the messages stay on disk
 * until a drain succeeds.
 */
function drainQueuedInput(params: DetachedTurnParams): void {
  const { projectId, marvinSessionId } = params;
  let prompt: string | null = null;
  try {
    prompt = renderPendingPrompt(drainPending(projectId, marvinSessionId));
  } catch {
    return; // queue unreadable — leave it for the next turn rather than crash
  }
  if (!prompt) return;
  try {
    console.info(
      "[marvin.telemetry] " +
        JSON.stringify({
          kind: "turn.queue.drain",
          projectId,
          at: new Date().toISOString(),
        }),
    );
  } catch {
    /* never break on serialisation */
  }
  // The queued text is a HUMAN message: it re-enters through the same path a
  // fresh POST would, so it is a human-kind turn and can itself be queued
  // behind (never preempted).
  void startQueuedTurn(params, prompt);
}

/**
 * Start a fresh HUMAN turn carrying the drained queue.
 *
 * Reuses the completed turn's runtime settings (model, mode, permissions) —
 * the user queued the message under those settings and would not expect them
 * to change. A fresh `turnId` + live turn keeps it a first-class turn in the
 * registry, so an attached client renders it exactly like any other.
 *
 * Terminates naturally: the drained queue is already cleared, so the follow-up
 * turn's own drain finds nothing unless the user queued again meanwhile.
 */
async function startQueuedTurn(prev: DetachedTurnParams, message: string): Promise<void> {
  // Same eviction hazard as `startScheduledTurn`, smaller window: between
  // the previous turn ending and this drain, a fresh POST may have
  // registered its own human turn. Never evict it — put the drained text
  // back on the durable queue and let THAT turn's own drain pick it up.
  const inflight = getLiveTurn(prev.marvinSessionId);
  if (inflight && !inflight.ended) {
    enqueuePending(prev.projectId, prev.marvinSessionId, message);
    return;
  }
  const turnId = randomUUID();
  const liveTurn = registerLiveTurn({
    turnId,
    marvinSessionId: prev.marvinSessionId,
    projectId: prev.projectId,
    kind: "human",
  });
  appendSessionTurn(prev.projectId, prev.marvinSessionId, {
    type: "turn.user",
    at: new Date().toISOString(),
    message,
  });
  // Resume the SDK context the previous turn ended on, so the queued message
  // continues the conversation instead of starting a cold one.
  const sessionId = lastSdkSessionId(prev.projectId, prev.marvinSessionId) ?? prev.sessionId;
  // A drained turn used to leave only a `turn.user` in the transcript — no
  // `turn.started` — so every audit that groups events by turn attributed its
  // whole run to the NEXT turn.user (session 8927baf0, 17:22: the queued
  // "pipeline failed." appeared to vanish and its work to belong to a turn
  // that started 300 ms later). Record it like the route and the wakeup do.
  const turnStartedPayload = {
    marvinSessionId: prev.marvinSessionId,
    projectId: prev.projectId,
    model: prev.model,
    advisorModel: prev.advisorModel ?? null,
    runtimeMode: (prev.advisorModel ? "advisor" : "opus") as "advisor" | "opus",
    personality: prev.personality,
    permissionStrategy: prev.permissionStrategy,
    playwrightEnabled: prev.playwrightEnabled ?? false,
    mode: prev.mode ?? "agent",
    thinkingMode: prev.thinkingMode,
    advisorThinkingMode: prev.advisorThinkingMode ?? null,
    sdkSessionFresh: !sessionId,
    turnId,
    queued: true,
  };
  emitTurnEvent(liveTurn, "turn.started", turnStartedPayload);
  appendSessionTurn(prev.projectId, prev.marvinSessionId, {
    type: "turn.started",
    at: new Date().toISOString(),
    ...turnStartedPayload,
  });
  await runDetachedTurn({
    ...prev,
    liveTurn,
    turnId,
    message,
    sessionId,
    // A human message is never part of a wakeup chain.
    wakeupDepth: 0,
  });
}

/**
 * Start a turn from a fired wakeup (ADR-0031). Rebuilds the prompt + project
 * context (never as a first message), resumes the session's SDK context,
 * registers a live turn so any open `/api/chat/resume` tab sees it, and
 * dispatches via {@link runDetachedTurn}. The wakeup turn's own
 * `schedule_wakeup` calls inherit `record.depth` so the chain-depth guard
 * keeps counting.
 */
export async function startScheduledTurn(record: WakeupRecord): Promise<void> {
  const turnId = randomUUID();
  const { projectId, marvinSessionId, cwd } = record;

  const message = `[scheduled wakeup — ${record.reason}]\n\n${record.prompt}`;

  const appendSystemPrompt = await buildTurnSystemPrompt({
    cwd,
    personality: record.personality,
    firstMessage: false,
  });

  const sdkResumeId = lastSdkSessionId(projectId, marvinSessionId) ?? undefined;

  // Re-check at the point of registration, not just at fire time: the
  // awaits above take seconds, and a human message that arrived meanwhile
  // has already registered its own live turn. Registering now would EVICT
  // it ("replaced by a newer turn on the same session"). Yield instead —
  // `deferIfSessionBusy` re-persists + re-arms the record, so the wakeup
  // still runs once the session is free. Must happen BEFORE the
  // `turn.user` append so a deferred wakeup leaves no orphan prompt in the
  // transcript.
  if (deferIfSessionBusy(record)) return;

  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.user",
    at: new Date().toISOString(),
    message,
  });

  const liveTurn = registerLiveTurn({
    turnId,
    marvinSessionId,
    projectId,
    kind: "machine",
  });
  // ADR-0069 — record the start so the scheduler can space the NEXT one.
  noteMachineTurnStarted(marvinSessionId);

  // Dynamic effort: whoever armed this wakeup may have asked for less than
  // the user's ceiling (a check-and-report turn, a job that succeeded).
  // The clamp is the guarantee that "less" is the only direction.
  const effectiveEffort = clampEffort(record.effort, record.thinkingMode, record.model);

  const turnStartedPayload = {
    marvinSessionId,
    projectId,
    model: record.model,
    advisorModel: record.advisorModel,
    runtimeMode: (record.advisorModel ? "advisor" : "opus") as "advisor" | "opus",
    personality: record.personality,
    permissionStrategy: record.permissionStrategy,
    thinkingMode: effectiveEffort,
    advisorThinkingMode: record.advisorThinkingMode ?? null,
    sdkSessionFresh: !sdkResumeId,
    turnId,
  };
  emitTurnEvent(liveTurn, "turn.started", turnStartedPayload);
  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.started",
    at: new Date().toISOString(),
    ...turnStartedPayload,
  });

  await runDetachedTurn({
    liveTurn,
    projectId,
    marvinSessionId,
    turnId,
    message,
    cwd,
    model: record.model,
    advisorModel: record.advisorModel ?? undefined,
    permissionStrategy: record.permissionStrategy,
    playwrightEnabled: record.playwrightEnabled,
    thinkingMode: effectiveEffort,
    advisorThinkingMode: record.advisorThinkingMode,
    sessionId: sdkResumeId,
    appendSystemPrompt,
    personality: record.personality,
    wakeupDepth: record.depth,
  });
}

// Wire the fire handler onto the scheduler's global singleton AT MODULE LOAD.
// This module is imported by `/api/chat` (the request path that also builds
// the wakeup MCP tool and arms the timers), so this runs in the SAME chunk
// the timers fire in — guaranteeing `fireHandler` is set before any wakeup
// can fire, independent of whether `instrumentation.ts` runs in the
// standalone bundle. This is the fix for the "scheduler fires but no turn
// starts" bug: previously the handler was wired only from instrumentation,
// which in standalone is a separate entry with its own module copy.
setWakeupFireHandler(startScheduledTurn);
