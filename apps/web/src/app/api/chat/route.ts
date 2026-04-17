import { randomUUID } from "crypto";
import type { NextRequest } from "next/server";

import { defaultModel } from "@marvin/runtime/claude-cli";
import { runAgent } from "@marvin/runtime/sdk-runner";
import { buildSystemPrompt, type PersonalityMode } from "@marvin/runtime/personality";
import { appendSessionTurn } from "@marvin/runtime/session";
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
  model?: string;
  /** When true, skip the PROJECT_STATUS/BUSINESS_OVERVIEW/probe injection. */
  skipProjectContext?: boolean;
}

function slugifyCwd(cwd: string): string {
  return cwd.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "default";
}

/**
 * POST /api/chat — baseline streaming chat endpoint.
 *
 * Body: { message, cwd?, projectId?, sessionId?, marvinSessionId?, personality?, model? }
 *
 * Streams Server-Sent Events. Each event has:
 *   event: <event-name>
 *   data:  <json>
 *
 * Event names:
 *   - `turn.started` — { marvinSessionId, projectId }
 *   - `cli.event`    — raw NDJSON from `claude -p --output-format stream-json`
 *   - `turn.completed` — { sessionId, durationMs, costUsd, tokenUsage }
 *   - `turn.error`   — { error }
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
  const projectId = body.projectId?.trim() || slugifyCwd(cwd);
  const marvinSessionId = body.marvinSessionId?.trim() || randomUUID();
  const turnId = randomUUID();
  const personality: PersonalityMode = body.personality ?? "marvin";
  const model = body.model?.trim() || defaultModel();
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* controller closed */
        }
      };

      send("turn.started", {
        marvinSessionId,
        projectId,
        model,
        personality,
        turnId,
      });

      const result = await runAgent({
        message,
        cwd,
        model,
        turnId,
        sessionId: body.sessionId,
        appendSystemPrompt,
        onEvent: (event) => {
          appendSessionTurn(projectId, marvinSessionId, {
            type: "cli.event",
            at: new Date().toISOString(),
            event,
          });
          send("cli.event", event);
        },
        onConfirmRequest: (payload) => {
          appendSessionTurn(projectId, marvinSessionId, {
            type: "confirm.request",
            at: new Date().toISOString(),
            payload,
          });
          send("confirm.request", payload);
        },
        signal: req.signal,
      });

      if (!result.ok) {
        appendSessionTurn(projectId, marvinSessionId, {
          type: "turn.error",
          at: new Date().toISOString(),
          error: result.error ?? "Unknown error",
        });
        send("turn.error", { error: result.error ?? "Unknown error" });
      } else {
        appendSessionTurn(projectId, marvinSessionId, {
          type: "turn.completed",
          at: new Date().toISOString(),
          durationMs: result.durationMs ?? null,
          costUsd: result.costUsd ?? null,
          tokenUsage: result.tokenUsage ?? null,
          sessionId: result.sessionId ?? null,
        });
        send("turn.completed", {
          sessionId: result.sessionId,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
          tokenUsage: result.tokenUsage,
          marvinSessionId,
        });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
