import { spawn } from "node:child_process";
import path from "node:path";

import type { NextRequest } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunBody = { cwd?: string; cmd?: string };

const MAX_CMD_LEN = 8 * 1024;
const MAX_RUN_MS = 10 * 60 * 1000;

function shellFor(): [string, string[]] {
  const sh = process.env.SHELL ?? "/bin/sh";
  // `-c` + a single string is portable across zsh / bash / sh.
  return [sh, ["-c"]];
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const cwd = body.cwd?.trim();
  const cmd = body.cmd?.trim();
  if (!cwd || !cmd) {
    return new Response("cwd and cmd required", { status: 400 });
  }
  if (cmd.length > MAX_CMD_LEN) {
    return new Response("cmd too long", { status: 413 });
  }
  const resolvedCwd = path.resolve(cwd);

  const encoder = new TextEncoder();
  const [shBin, shArgs] = shellFor();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          /* stream closed */
        }
      };

      const child = spawn(shBin, [...shArgs, cmd], {
        cwd: resolvedCwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const startedAt = Date.now();
      send("started", { pid: child.pid, cwd: resolvedCwd, cmd });

      const timeout = setTimeout(() => {
        send("stderr", { data: `\n[terminal] timeout after ${MAX_RUN_MS}ms\n` });
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, MAX_RUN_MS);

      child.stdout.on("data", (d: Buffer) => {
        send("stdout", { data: d.toString("utf8") });
      });
      child.stderr.on("data", (d: Buffer) => {
        send("stderr", { data: d.toString("utf8") });
      });
      child.on("error", (err: Error) => {
        send("stderr", { data: `\n[terminal] ${err.message}\n` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        send("exit", {
          code: code ?? null,
          signal: signal ?? null,
          durationMs: Date.now() - startedAt,
        });
        close();
      });

      const abort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener("abort", abort, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
