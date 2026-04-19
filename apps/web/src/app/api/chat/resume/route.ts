import type { NextRequest } from "next/server";

import { getLiveTurn } from "@marvin/runtime/turn-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/chat/resume?marvinSessionId=...
 *
 * Attach to a live in-memory turn bus and stream further events. This
 * lets a refreshed / re-opened browser tab pick up a turn that started
 * before the disconnect without killing or restarting the agent.
 *
 * Behaviour:
 *   - If there's a live (not-yet-terminal) turn for the session:
 *     subscribe to its event bus and stream until it ends.
 *   - If the turn recently ended (within the registry's grace window):
 *     emit an `turn.completed`/`turn.error` catch-up and close.
 *   - If there's no known live turn at all: respond 204 so the client
 *     knows to fall back to loading the session transcript from disk.
 */
export async function GET(req: NextRequest) {
  const marvinSessionId = req.nextUrl.searchParams.get("marvinSessionId")?.trim();
  if (!marvinSessionId) {
    return new Response(
      JSON.stringify({ error: "marvinSessionId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const live = getLiveTurn(marvinSessionId);
  if (!live) {
    // No live turn to attach to. 204 instructs the client to load the
    // transcript from /api/sessions/[id] and treat the turn as settled.
    return new Response(null, { status: 204 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        } catch {
          /* client went away */
        }
      };

      // Inform the client that the connection is live so it can swap the
      // UI out of "stale / disconnected" mode.
      send("resume.attached", {
        marvinSessionId: live.marvinSessionId,
        turnId: live.turnId,
        startedAt: new Date(live.startedAt).toISOString(),
        ended: live.ended,
      });

      // If the turn already ended just before we attached, emit a
      // synthetic terminal event so the client stops "thinking" and
      // then close. The real terminal event was already stored on disk.
      if (live.ended) {
        send("turn.completed", {
          marvinSessionId: live.marvinSessionId,
          turnId: live.turnId,
          note: "turn ended before resume attached; load transcript",
        });
        try {
          controller.close();
        } catch {
          /* ignore */
        }
        return;
      }

      const onEvent = (e: { event: string; data: unknown }) => {
        send(e.event, e.data);
        if (e.event === "turn.completed" || e.event === "turn.error") {
          live.bus.off("event", onEvent);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      };
      live.bus.on("event", onEvent);

      // Detach this listener if the client goes away again — without
      // aborting the underlying SDK work.
      req.signal.addEventListener(
        "abort",
        () => {
          live.bus.off("event", onEvent);
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

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
