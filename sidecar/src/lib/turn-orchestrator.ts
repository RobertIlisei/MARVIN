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
import {
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
  /** Autonomy mode (ADR-0036); defaults to `agent` in runAgent when omitted. */
  mode?: AgentMode | undefined;
  thinkingMode: string;
  /** Advisor-specific effort (ADR-0033); undefined = follow the executor. */
  advisorThinkingMode?: string | undefined;
  sessionId?: string | undefined;
  appendSystemPrompt: string;
  personality: "marvin" | "neutral";
  /** Depth of this turn in a wakeup chain (0 = human-started). ADR-0031. */
  wakeupDepth?: number;
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
    mode,
    thinkingMode,
    advisorThinkingMode,
    sessionId,
    appendSystemPrompt,
    personality,
    wakeupDepth,
  } = params;

  const result = await runAgent({
    message,
    cwd,
    model,
    ...(advisorModel ? { advisorModel } : {}),
    permissionStrategy,
    ...(mode ? { mode } : {}),
    thinkingMode,
    ...(advisorThinkingMode ? { advisorThinkingMode } : {}),
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
    endLiveTurn(liveTurn, { event: "turn.error", data: payload });
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
  const projectContext = await buildProjectContext({
    workDir: cwd,
    firstMessage: false,
  }).catch(() => "");
  const appendSystemPrompt = projectContext
    ? `${systemPrompt}\n\n${projectContext}`
    : systemPrompt;

  const sdkResumeId = lastSdkSessionId(projectId, marvinSessionId) ?? undefined;

  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.user",
    at: new Date().toISOString(),
    message,
  });

  const liveTurn = registerLiveTurn({ turnId, marvinSessionId, projectId });

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
