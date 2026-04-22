/**
 * POST /api/terminal/run — stream a shell command's stdout/stderr as SSE.
 *
 * This is the most dangerous endpoint in MARVIN by design: it runs
 * arbitrary shell in the user's account. Three gates protect it:
 *
 *   1. **CSRF preflight header** (`X-Marvin-Client: 1`) via the shared
 *      `requireMarvinClient` guard. Blocks drive-by same-browser tabs
 *      at other origins from triggering a shell.
 *   2. **Sandbox check on cwd** via `checkFsPath`. Prevents the route
 *      from spawning in `/`, `/etc`, a non-existent path, or a symlink
 *      target. The path must exist and be a directory. This does NOT
 *      restrict cwd to registered projects — the terminal is meant to
 *      be general — but it does stop a caller from passing empty,
 *      poisoned, or fabricated paths.
 *   3. **Command length cap** (`MAX_CMD_LEN`, 8 KB) and **runtime
 *      timeout** (`MAX_RUN_MS`, 10 minutes). Localhost-only so DoS
 *      concern is limited, but both are cheap and stop a misbehaving
 *      long-runner from holding the server thread indefinitely.
 *
 * What is DELIBERATELY NOT gated: the command string itself. This is
 * the user's terminal — arbitrary shell is the feature. A command
 * allowlist here would break legitimate work. The CSRF guard is what
 * keeps non-owners from hitting this route at all.
 */

import { spawn } from "node:child_process";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

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

  // Sandbox check: cwd must exist, must be a directory, must not be a
  // symlink (or contain symlink ancestors that escape). The terminal
  // route intentionally allows arbitrary-but-existing directories — it
  // is not restricted to registered projects. What this prevents:
  //   - Empty or relative cwd that would default to the Node server's
  //     own current working directory (leaking MARVIN's repo root).
  //   - Non-existent paths that would cause spawn to error in a less
  //     structured way than a JSON 400.
  //   - Symlink shenanigans (fs-sandbox rejects symlinks outright).
  //
  // `cwd: cwd` as both the sandbox root AND the target means "the
  // sandbox boundary IS the cwd." The absolute-path return is what we
  // pass to spawn, so a caller can't defeat the check with a relative
  // path that points elsewhere post-validation.
  const cwdCheck = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!cwdCheck.ok) {
    return NextResponse.json({ error: cwdCheck.error }, { status: 400 });
  }
  if (!cwdCheck.isDirectory) {
    return NextResponse.json(
      { error: "cwd is not a directory" },
      { status: 400 },
    );
  }
  const resolvedCwd = cwdCheck.absolutePath;

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
