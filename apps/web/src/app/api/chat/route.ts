import { randomUUID } from "crypto";
import type { NextRequest } from "next/server";

import { defaultModel } from "@marvin/runtime/claude-cli";
import {
  resolveRuntimeMode,
  runAgent,
  type PermissionStrategy,
  type RuntimeMode,
} from "@marvin/runtime/sdk-runner";
import { buildSystemPrompt, type PersonalityMode } from "@marvin/runtime/personality";
import { appendSessionTurn } from "@marvin/runtime/session";
import { recordTurnCost } from "@marvin/runtime/cost-tracker";
import { slugifyWorkDir, touchProject } from "@marvin/runtime/projects";
import {
  emitTurnEvent,
  endLiveTurn,
  registerLiveTurn,
} from "@marvin/runtime/turn-registry";
import { buildProjectContext } from "@marvin/project-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  /** Active project working directory — where the CLI runs. */
  cwd?: string;
  /** Logical project identifier for session persistence. Defaults to a slug
   *  derived from `cwd`. */
  projectId?: string;
  /** Resume a previous Claude CLI session (omit to start a new one). */
  sessionId?: string;
  /** Resume a previous MARVIN session transcript (omit for new). */
  marvinSessionId?: string;
  personality?: PersonalityMode;
  /** Explicit executor model. Wins over runtimeMode if both supplied. */
  model?: string;
  /** Explicit advisor model. Enables the SDK's server-side advisor tool. */
  advisorModel?: string;
  /** Convenience alias for executor+advisor pair — used only when `model`
   *  and `advisorModel` are not explicitly set. */
  runtimeMode?: RuntimeMode;
  /** Permission strategy. `auto` (default) = full bypass, no confirm gate.
   *  `gated` = Edit/Write/unsafe Bash render a confirm card. */
  permissionStrategy?: PermissionStrategy;
  /** When true, skip the PROJECT_STATUS/BUSINESS_OVERVIEW/probe injection. */
  skipProjectContext?: boolean;
}

/**
 * POST /api/chat — start a turn.
 *
 * The HTTP response streams Server-Sent Events for the caller, but the
 * underlying agent is **decoupled from the request lifecycle** via
 * `@marvin/runtime/turn-registry`. Closing the browser tab no longer
 * kills the turn — a reconnecting client tails the same in-memory bus
 * via `GET /api/chat/resume?marvinSessionId=…`, and the transcript on
 * disk lets the client rebuild whatever it missed before reconnecting.
 */
export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const message = body.message?.trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cwd = body.cwd?.trim() || process.cwd();
  const projectId = body.projectId?.trim() || slugifyWorkDir(cwd);
  const marvinSessionId = body.marvinSessionId?.trim() || randomUUID();
  const turnId = randomUUID();
  const personality: PersonalityMode = body.personality ?? "marvin";
  const runtimeMode: RuntimeMode = body.runtimeMode ?? "opus";
  const permissionStrategy: PermissionStrategy = body.permissionStrategy ?? "auto";

  // Resolution order for model/advisorModel: explicit body fields win;
  // runtimeMode fills the gap; defaultModel() is the last resort.
  const resolved = resolveRuntimeMode(runtimeMode);
  const model = body.model?.trim() || resolved.model || defaultModel();
  const advisorModel = body.advisorModel?.trim() || resolved.advisorModel;
  const firstMessage = !body.marvinSessionId;

  const systemPrompt = buildSystemPrompt(personality);
  const projectContext = body.skipProjectContext
    ? ""
    : await buildProjectContext({ workDir: cwd, firstMessage }).catch(() => "");
  const appendSystemPrompt = projectContext ? `${systemPrompt}\n\n${projectContext}` : systemPrompt;

  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.user",
    at: new Date().toISOString(),
    message,
  });

  // Register the live turn. Events get pushed to BOTH the on-disk
  // transcript AND this bus; any number of HTTP subscribers can listen.
  const liveTurn = registerLiveTurn({ turnId, marvinSessionId, projectId });

  const turnStartedPayload = {
    marvinSessionId,
    projectId,
    model,
    advisorModel: advisorModel ?? null,
    runtimeMode,
    personality,
    permissionStrategy,
    turnId,
  };
  emitTurnEvent(liveTurn, "turn.started", turnStartedPayload);
  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.started" as unknown as "turn.user", // transcript shape is open; cast keeps TS happy
    at: new Date().toISOString(),
    ...turnStartedPayload,
  } as never);

  // Fire-and-forget: the SDK loop runs to completion regardless of
  // whether this HTTP request is still connected.
  void runAgentDetached();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* controller closed — client went away */
        }
      };

      // Echo the turn.started we already emitted so this subscriber sees it.
      send("turn.started", turnStartedPayload);

      const onEvent = (e: { event: string; data: unknown }) => {
        send(e.event, e.data);
        // A terminal event means the turn is done — close the stream
        // on this subscriber. Others may still be listening.
        if (e.event === "turn.completed" || e.event === "turn.error") {
          liveTurn.bus.off("event", onEvent);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      };
      liveTurn.bus.on("event", onEvent);

      // If the HTTP client aborts, we detach the listener BUT DO NOT
      // cancel the turn. Explicit user cancels come through the
      // dedicated /api/chat/cancel route.
      req.signal.addEventListener(
        "abort",
        () => {
          liveTurn.bus.off("event", onEvent);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        },
        { once: true },
      );
    },
  });

  async function runAgentDetached() {
    const result = await runAgent({
      message,
      cwd,
      model,
      ...(advisorModel ? { advisorModel } : {}),
      permissionStrategy,
      turnId,
      sessionId: body.sessionId,
      appendSystemPrompt,
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
      // Only explicit cancels via /api/chat/cancel reach the SDK.
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
