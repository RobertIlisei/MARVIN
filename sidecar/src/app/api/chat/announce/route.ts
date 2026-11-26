import { backlogChangedPayload, getBacklogLive } from "@marvin/runtime/backlog-live";
import { getProject } from "@marvin/runtime/projects";
import { type ProjectEvent, subscribeProjectEvents } from "@marvin/runtime/turn-registry";
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

      // ADR-0107 — the whole project event set rides this one stream:
      // turn.registered (as before), turn.ended, confirm.pending,
      // confirm.resolved, session.tree. Filtered to this project.
      const unsubscribe = subscribeProjectEvents((e: ProjectEvent) => {
        if (e.data.projectId !== projectId) return;
        send(e.event, e.data);
      });

      // ADR-0044 addendum — the project's backlog counts ride this stream too:
      // the current state right after attach (so a reconnect after sleep or a
      // sidecar restart resyncs), then one `backlog.changed` per debounced
      // change of any origin. One watcher per project however many clients.
      let releaseBacklogWatch: (() => void) | null = null;
      let unsubscribeBacklog: (() => void) | null = null;
      const project = getProject(projectId);
      if (project) {
        const hub = getBacklogLive();
        releaseBacklogWatch = hub.watch(project.workDir);
        // `attach`: the state now as this stream's first frame, then each
        // change, in one order (a change can never be overwritten by an older
        // snapshot).
        unsubscribeBacklog = hub.attach(project.workDir, (c) =>
          send("backlog.changed", backlogChangedPayload(projectId, c)),
        );
      }

      const heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);
      heartbeat.unref?.();

      function teardown() {
        if (!open) return;
        open = false;
        unsubscribe();
        unsubscribeBacklog?.();
        releaseBacklogWatch?.();
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
