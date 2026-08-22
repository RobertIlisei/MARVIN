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
import { recordTurnCost } from "@marvin/runtime/cost-tracker";
import { buildSystemPrompt } from "@marvin/runtime/personality";
import { touchProject } from "@marvin/runtime/projects";
import {
  type AgentMode,
  type PermissionStrategy,
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
  registerLiveTurn,
} from "@marvin/runtime/turn-registry";
import { drainPending, renderPendingPrompt } from "@marvin/runtime/pending-input";
import {
  autoContinueDelaySeconds,
  autoContinuePrompt,
  classifyTurnError,
  MAX_AUTO_CONTINUES,
} from "@marvin/runtime/transient-errors";
import {
  noteMachineTurnStarted,
  scheduleWakeup,
  setWakeupFireHandler,
  type WakeupRecord,
} from "@marvin/runtime/wakeup-scheduler";

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

  const result = await runAgent({
    message,
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
    signal: liveTurn.abortController.signal,
  });

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

  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.completed",
    at: new Date().toISOString(),
    durationMs: result.durationMs ?? null,
    costUsd: result.costUsd ?? null,
    tokenUsage: result.tokenUsage ?? null,
    sessionId: result.sessionId ?? null,
  });
  if (result.sessionId) {
    rememberSdkSessionId(projectId, marvinSessionId, result.sessionId);
  }
  recordTurnCost({
    projectId,
    costUsd: result.costUsd ?? null,
    tokenUsage: result.tokenUsage ?? null,
  });
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
      costUsd: result.costUsd,
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
  await runDetachedTurn({
    ...prev,
    liveTurn,
    turnId,
    message,
    // Resume the SDK context the previous turn ended on, so the queued message
    // continues the conversation instead of starting a cold one.
    sessionId: lastSdkSessionId(prev.projectId, prev.marvinSessionId) ?? prev.sessionId,
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

  const systemPrompt = buildSystemPrompt(record.personality);
  const projectContext = (
    await buildProjectContext({
      workDir: cwd,
      firstMessage: false,
    }).catch(() => ({ text: "", breakdown: [] }))
  ).text;
  const appendSystemPrompt = projectContext
    ? `${systemPrompt}\n\n${projectContext}`
    : systemPrompt;

  const sdkResumeId = lastSdkSessionId(projectId, marvinSessionId) ?? undefined;

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

  const turnStartedPayload = {
    marvinSessionId,
    projectId,
    model: record.model,
    advisorModel: record.advisorModel,
    runtimeMode: (record.advisorModel ? "advisor" : "opus") as "advisor" | "opus",
    personality: record.personality,
    permissionStrategy: record.permissionStrategy,
    thinkingMode: record.thinkingMode,
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
    thinkingMode: record.thinkingMode,
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
