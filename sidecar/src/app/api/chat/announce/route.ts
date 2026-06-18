import {
  subscribeTurnAnnouncements,
  type TurnAnnouncement,
} from "@marvin/runtime/turn-registry";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Heartbeat keeps the connection warm and reaps a client that vanished
 *  without a clean close (the write throws → we tear down). */
const HEARTBEAT_MS = 25_000;

/**
 * GET /api/chat/announce?projectId=...
 *
 * An always-on, read-only SSE stream the client holds open for the whole time
 * a project is loaded. It forwards `turn.registered` announcements (emitted by
 * `registerLiveTurn`) for that project, so an **idle** client learns that a
 * turn it did NOT start has begun — a background-job completion (ADR-0038) or a
 * timed wakeup (ADR-0031) — and re-attaches to it via `/api/chat/resume`.
 *
 * This route never starts, cancels, or mutates a turn. It only says "a turn
 * for session X just registered"; the client decides whether to attach. The
 * gap it closes: `attachLive` was only ever called on session *hydrate*, so a
 * server-fired turn ran into the event bus with no listener and was invisible
 * until the next session switch. ADR-0043.
 */
export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return new Response(
      JSON.stringify({ error: "projectId is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client went away between events — tear down so we stop holding
          // the subscription + timer for a dead connection.
          teardown();
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      send("announce.attached", { projectId });

      const unsubscribe = subscribeTurnAnnouncements((a: TurnAnnouncement) => {
        if (a.projectId !== projectId) return;
        send("turn.registered", a);
      });

      const heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
      heartbeat.unref?.();

      function teardown() {
        if (!open) return;
        open = false;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      req.signal.addEventListener("abort", teardown, { once: true });
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
